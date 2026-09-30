import assert from 'node:assert/strict';
import { test } from 'vitest';
import fusionExtension from '../../src/index.js';
import { createProjectDir, FakePi, nextTick } from '../support/fake-pi.js';

for (const phase of ['panel', 'judge'] as const) {
  for (const includeResults of [false, true]) {
    test(`stopped ${phase} is terminal without result.json (results=${includeResults})`, async (t) => {
      const pi = new FakePi();
      const ctx = pi.createContext(await createProjectDir(t));
      fusionExtension(pi.asExtensionApi());
      await pi.runCommand('fusion', 'review', ctx);
      t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
      if (phase === 'judge') {
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
      }
      const runId = phase === 'panel' ? 'panel-1' : 'judge-1';
      pi.events.statusResults.set(runId, {
        runId,
        state: 'stopped',
        mode: 'workflow',
        endedAt: Date.now(),
        ...(includeResults
          ? {
              results: [
                {
                  agent: 'pi-fusion.fusion-panelist',
                  success: true,
                  output: 'partial',
                },
              ],
            }
          : {
              error:
                'Workflow stopped because the extension session was replaced or reloaded.',
            }),
      });
      pi.events.emit('subagent:child-status', { runId });
      await nextTick();
      assert.match(pi.messages.at(-1)?.content ?? '', /stopped/i);
      assert.equal(
        (pi.entries.at(-1)?.data as { phase: string } | undefined)?.phase,
        'failed',
      );
      assert.equal(pi.events.spawns.length, phase === 'panel' ? 1 : 2);
    });
  }
}
