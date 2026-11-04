import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { createDefaultFusionConfig } from '../../src/config.js';
import fusionExtension from '../../src/index.js';
import { createProjectDir, FakePi, nextTick } from '../support/fake-pi.js';

for (const newInput of [false, true]) {
  test(`an aborted parent suppresses Fusion wakes until new explicit input=${newInput}`, async (t) => {
    const cwd = await createProjectDir(t);
    const config = createDefaultFusionConfig();
    const profile = config.profiles.quality;
    assert.ok(profile);
    profile.wakeOnCompletion = true;
    await writeFile(join(cwd, '.pi/fusion.json'), JSON.stringify(config));
    const pi = new FakePi();
    const ctx = pi.createContext(cwd);
    fusionExtension(pi.asExtensionApi());
    await pi.emitLifecycle('session_start', {}, ctx);
    t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
    await pi.runCommand('fusion', 'Review', ctx);
    await pi.emitLifecycle('agent_settled', { aborted: true }, ctx);
    await pi.emitLifecycle(
      'input',
      { source: 'extension', text: 'native update' },
      ctx,
    );
    if (newInput)
      await pi.emitLifecycle(
        'input',
        { source: 'interactive', text: 'Continue' },
        ctx,
      );
    pi.events.statusResults.set('panel-1', {
      runId: 'panel-1',
      state: 'failed',
      error: 'Fixture failure',
    });
    pi.events.emit('subagent:async-complete', { runId: 'panel-1' });
    await nextTick();
    assert.equal(pi.messages.at(-1)?.customType, 'fusion-report');
    assert.equal(pi.messageOptions.at(-1)?.triggerTurn, newInput);
    assert.deepEqual(pi.userMessages, []);
  });
}

test('untrusted projects cannot restore disk state or launch a review', async (t) => {
  const cwd = await createProjectDir(t);
  const pi = new FakePi();
  const ctx = { ...pi.createContext(cwd), isProjectTrusted: () => false };
  fusionExtension(pi.asExtensionApi());
  await pi.emitLifecycle('session_start', {}, ctx);
  t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
  await pi.runCommand('fusion', 'Review', ctx);
  assert.equal(pi.events.spawns.length, 0);
  assert.match(ctx.ui.notifications.at(-1)?.message ?? '', /project trust/);
  assert.equal(pi.entries.length, 0);
});

test('bundled mutation-capable panels are rejected before any child starts', async (t) => {
  const cwd = await createProjectDir(t);
  const config = createDefaultFusionConfig();
  const profile = config.profiles.quality;
  assert.ok(profile?.panel[0]);
  profile.panel[0].agent = 'pi-fusion.fusion-panelist-full';
  await writeFile(join(cwd, '.pi/fusion.json'), JSON.stringify(config));
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);
  fusionExtension(pi.asExtensionApi());
  t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
  await pi.runCommand('fusion', 'Review', ctx);
  assert.equal(pi.events.spawns.length, 0);
  assert.match(
    ctx.ui.notifications.at(-1)?.message ?? '',
    /cannot run concurrently/,
  );
});
