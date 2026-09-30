import assert from 'node:assert/strict';
import { test } from 'vitest';
import fusionExtension from '../../src/index.js';
import { createProjectDir, FakePi, nextTick } from '../support/fake-pi.js';

for (const event of ['subagent:child-status', 'subagent:process-terminal']) {
  test(`${event} is only a hint, coalesces duplicates, and cleans up on shutdown`, async (t) => {
    const pi = new FakePi();
    const ctx = pi.createContext(await createProjectDir(t));
    fusionExtension(pi.asExtensionApi());
    await pi.emitLifecycle('session_start', {}, ctx);
    t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
    await pi.runCommand('fusion', 'review', ctx);
    assert.equal(pi.events.listenerCount(event), 1);
    const statusCount = () =>
      pi.events.emitted.filter(
        (e) =>
          e.event === 'subagents:rpc:v1:request' &&
          (e.payload as { method: string }).method === 'status',
      ).length;
    const before = statusCount();
    pi.events.emit(event, {
      version: 1,
      runId: 'unrelated',
      state: 'complete',
    });
    await nextTick();
    assert.equal(statusCount(), before);
    for (let i = 0; i < 5; i++)
      pi.events.emit(event, {
        version: 1,
        runId: 'panel-1',
        state: 'complete',
        output: 'not evidence',
      });
    await nextTick();
    assert.equal(statusCount(), before + 1);
    assert.equal(pi.events.spawns.length, 1);
    pi.events.statusResults.set('panel-1', {
      runId: 'panel-1',
      state: 'complete',
      results: [1, 2, 3].map(() => ({
        agent: 'pi-fusion.fusion-panelist',
        success: true,
        output: 'review',
      })),
    });
    pi.events.emit(event, { version: 1, runId: 'panel-1', state: 'observed' });
    await nextTick();
    assert.equal(pi.events.spawns.length, 2);
    pi.events.emit(event, { version: 1, runId: 'panel-1' });
    await nextTick();
    assert.equal(pi.events.spawns.length, 2);
    const after = statusCount();
    pi.events.emit(event, { version: 1, runId: 'judge-1' });
    await pi.emitLifecycle('session_shutdown', {}, ctx);
    await nextTick();
    assert.equal(pi.events.listenerCount(event), 0);
    assert.equal(statusCount(), after);
  });
}

test('a hint during an in-flight status request schedules one fresh pass', async (t) => {
  const pi = new FakePi();
  const ctx = pi.createContext(await createProjectDir(t));
  fusionExtension(pi.asExtensionApi());
  await pi.runCommand('fusion', 'review', ctx);
  t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
  const emit = pi.events.emit.bind(pi.events);
  let held: { requestId: string; method: string } | undefined;
  let requests = 0;
  pi.events.emit = (event, payload) => {
    const request = payload as { requestId: string; method: string };
    if (
      event === 'subagents:rpc:v1:request' &&
      request.method === 'status' &&
      ++requests === 1
    ) {
      held = request;
      return;
    }
    emit(event, payload);
  };
  emit('subagent:child-status', { runId: 'panel-1' });
  await nextTick();
  assert.ok(held);
  for (let i = 0; i < 5; i++)
    emit('subagent:child-status', { runId: 'panel-1' });
  await nextTick();
  assert.equal(requests, 1);
  emit(`subagents:rpc:v1:reply:${held.requestId}`, {
    version: 1,
    requestId: held.requestId,
    method: 'status',
    success: true,
    data: { runId: 'panel-1', results: [] },
  });
  await nextTick();
  assert.equal(requests, 2);
});

test('unadvertised lifecycle channels are not subscribed', async (t) => {
  const pi = new FakePi();
  pi.events.pingResult = { ok: true };
  const ctx = pi.createContext(await createProjectDir(t));
  fusionExtension(pi.asExtensionApi());
  await pi.runCommand('fusion', 'review', ctx);
  t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
  assert.equal(pi.events.listenerCount('subagent:child-status'), 0);
});
