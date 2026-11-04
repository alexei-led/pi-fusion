import assert from 'node:assert/strict';
import { test } from 'vitest';
import fusionExtension from '../../src/index.js';
import { createProjectDir, FakePi, nextTick } from '../support/fake-pi.js';

test('id-less jobs changes refresh once and never become completion evidence', async (t) => {
  const pi = new FakePi();
  pi.events.pingResult = { events: { jobsChanged: 'subagent:jobs-changed' } };
  const ctx = pi.createContext(await createProjectDir(t));
  fusionExtension(pi.asExtensionApi());
  await pi.runCommand('fusion', 'review', ctx);
  t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
  const count = () =>
    pi.events.emitted.filter(
      (event) =>
        event.event === 'subagents:rpc:v1:request' &&
        (event.payload as { method: string }).method === 'status',
    ).length;
  const before = count();
  pi.events.emit('subagent:jobs-changed', { version: 2 });
  await nextTick();
  assert.equal(count(), before);
  for (let index = 0; index < 5; index++)
    pi.events.emit('subagent:jobs-changed', {
      version: 1,
      output: 'not evidence',
    });
  await nextTick();
  assert.equal(count(), before + 1);
  assert.equal(pi.events.spawns.length, 1);
  await pi.emitLifecycle('session_shutdown', {}, ctx);
  assert.equal(pi.events.listenerCount('subagent:jobs-changed'), 0);
});
