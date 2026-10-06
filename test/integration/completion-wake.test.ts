import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import fusionExtension from '../../src/index.js';
import { createProjectDir, FakePi, nextTick } from '../support/fake-pi.js';

for (const terminal of ['done', 'cancelled'] as const) {
  test(`opt-in owner wakes on ${terminal} after active restore`, async (t) => {
    const cwd = await createProjectDir(t);
    const path = join(cwd, '.pi/fusion.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    for (const profile of Object.values(config.profiles) as Array<
      Record<string, unknown>
    >)
      profile.wakeOnCompletion = true;
    await writeFile(path, JSON.stringify(config));
    const first = new FakePi();
    const firstCtx = first.createContext(cwd);
    fusionExtension(first.asExtensionApi());
    await first.runCommand('fusion', 'review', firstCtx);
    await first.emitLifecycle('session_shutdown', {}, firstCtx);
    const pi = new FakePi(first.entries);
    const ctx = pi.createContext(cwd);
    fusionExtension(pi.asExtensionApi());
    await pi.emitLifecycle('session_start', {}, ctx);
    t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
    if (terminal === 'cancelled') await pi.runCommand('fusion', 'stop', ctx);
    else {
      pi.events.statusResults.set('panel-1', {
        runId: 'panel-1',
        state: 'complete',
        results: [1, 2, 3].map(() => ({
          agent: 'pi-fusion.fusion-panelist',
          success: true,
          output: 'review',
        })),
      });
      pi.events.emit('subagent:async-complete', { runId: 'panel-1' });
      await nextTick();
      pi.events.statusResults.set('judge-1', {
        runId: 'judge-1',
        state: 'complete',
        results: [
          {
            agent: 'pi-fusion.fusion-judge',
            success: true,
            output: 'Final review',
          },
        ],
      });
      pi.events.emit('subagent:async-complete', { runId: 'judge-1' });
      await nextTick();
    }
    assert.equal(pi.messages.at(-1)?.customType, 'fusion-report');
    assert.equal(pi.messageOptions.at(-1)?.triggerTurn, false);
    assert.deepEqual(pi.userMessages, [
      { content: 'Fusion update above.', deliverAs: 'followUp' },
    ]);
  });
}

for (const owner of [
  'interactive',
  'controller',
  'different-session',
  'disabled',
] as const) {
  test(`terminal wake respects ${owner} ownership and is not replayed`, async (t) => {
    const cwd = await createProjectDir(t);
    const path = join(cwd, '.pi/fusion.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    for (const profile of Object.values(config.profiles) as Array<
      Record<string, unknown>
    >)
      profile.wakeOnCompletion = owner !== 'disabled';
    await writeFile(path, JSON.stringify(config));
    const pi = new FakePi();
    const ctx = pi.createContext(cwd);
    fusionExtension(pi.asExtensionApi());
    await pi.emitLifecycle('session_start', {}, ctx);
    t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
    if (owner === 'controller') {
      await new Promise<void>((resolve) => {
        pi.events.on('fusion:rpc:v1:reply:owner', () => resolve());
        pi.events.emit('fusion:rpc:v1:request', {
          version: 1,
          requestId: 'owner',
          method: 'start',
          params: { prompt: 'review', operationId: 'controller' },
        });
      });
    } else await pi.runCommand('fusion', 'review', ctx);
    assert.equal(pi.events.spawns.length, 1);
    if (owner === 'different-session') pi.sessionId = 'another-session';
    pi.events.statusResults.set('panel-1', {
      runId: 'panel-1',
      state: 'failed',
      error: 'panel failed',
    });
    pi.events.emit('subagent:async-complete', { runId: 'panel-1' });
    await nextTick();
    const reports = pi.messages.filter((m) => m.customType === 'fusion-report');
    assert.equal(reports.length, 1);
    assert.equal(pi.messageOptions.at(-1)?.triggerTurn, false);
    assert.equal(pi.userMessages.length, owner === 'interactive' ? 1 : 0);
    if (owner === 'interactive')
      assert.equal(pi.userMessages[0]?.deliverAs, 'followUp');
    pi.events.emit('subagent:async-complete', { runId: 'panel-1' });
    await nextTick();
    assert.equal(
      pi.messages.filter((m) => m.customType === 'fusion-report').length,
      1,
    );
    await pi.emitLifecycle('session_shutdown', {}, ctx);
    const restored = new FakePi(pi.entries);
    fusionExtension(restored.asExtensionApi());
    const restoredCtx = restored.createContext(cwd);
    await restored.emitLifecycle('session_start', {}, restoredCtx);
    assert.equal(restored.messages.length, 0);
    assert.equal(restored.userMessages.length, 0);
    await restored.emitLifecycle('session_shutdown', {}, restoredCtx);
  });
}
