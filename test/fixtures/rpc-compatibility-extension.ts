import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { extractSubagentRunId } from '../../src/orchestrator.js';
import { isRecord } from '../../src/utils.js';

export default function compatibilityFixture(pi: ExtensionAPI): void {
  function request(
    channel: string,
    method: string,
    params: object,
  ): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('RPC fixture timed out'));
      }, 10_000);
      const off = pi.events.on(
        `${channel}:reply:${requestId}`,
        (reply: unknown) => {
          clearTimeout(timer);
          off();
          if (!isRecord(reply)) {
            reject(new Error('Invalid fixture RPC reply'));
            return;
          }
          resolve(reply);
        },
      );
      pi.events.emit(`${channel}:request`, {
        version: 1,
        requestId,
        method,
        params,
      });
    });
  }

  pi.registerCommand('fusion-compatibility', {
    description: 'Isolated Fusion integration fixture',
    handler: async (_args, ctx) => {
      const report: Record<string, unknown> = {};
      const completed = new Set<string>();
      const unsubscribe = pi.events.on(
        'subagent:async-complete',
        (payload: unknown) => {
          if (isRecord(payload) && typeof payload.runId === 'string')
            completed.add(payload.runId);
        },
      );
      try {
        const old = await request('subagents:rpc:v1', 'spawn', {
          workflowScript: 'return 1',
          async: true,
        });
        assert.equal(old.success, false);
        assert.ok(isRecord(old.error));
        assert.equal(old.error.code, 'invalid_params');
        report.legacyRejected = true;
        const native = await request('subagents:rpc:v1', 'spawn', {
          script: 'return "fixture";',
          async: true,
        });
        assert.equal(native.success, true, JSON.stringify(native));
        const nativeId = extractSubagentRunId(native.data);
        assert.ok(nativeId);
        const completedDeadline = Date.now() + 10_000;
        while (!completed.has(nativeId) && Date.now() < completedDeadline)
          await delay(50);
        assert.ok(
          completed.has(nativeId),
          'Native coordinator did not complete',
        );
        const stopped = await request('subagents:rpc:v1', 'stop', {
          id: nativeId,
        });
        assert.equal(stopped.success, false);
        assert.ok(isRecord(stopped.error));
        assert.equal(stopped.error.code, 'invalid_state');
        const missing = await request('subagents:rpc:v1', 'stop', {
          id: randomUUID(),
        });
        assert.equal(missing.success, false);
        assert.ok(isRecord(missing.error));
        assert.equal(missing.error.code, 'not_found');
        report.nativeStopRejections = [stopped.error.code, missing.error.code];
        const runs: unknown[] = [];
        for (const profile of ['select', 'merge', 'single', 'refill']) {
          const params = {
            operationId: `smoke-${profile}`,
            profile,
            prompt: 'FUSION_COMPATIBILITY_FIXTURE',
          };
          const start = await request('fusion:rpc:v1', 'start', params);
          assert.equal(start.success, true, JSON.stringify(start));
          assert.ok(isRecord(start.data) && isRecord(start.data.run));
          const replay = await request('fusion:rpc:v1', 'start', params);
          assert.ok(isRecord(replay.data) && isRecord(replay.data.run));
          assert.equal(replay.data.replayed, true);
          assert.equal(replay.data.run.runId, start.data.run.runId);
          let done = false;
          const deadline = Date.now() + 40_000;
          while (Date.now() < deadline) {
            const reply = await request('fusion:rpc:v1', 'result', {
              operationId: params.operationId,
            });
            if (
              reply.success &&
              isRecord(reply.data) &&
              isRecord(reply.data.run) &&
              reply.data.run.terminal
            ) {
              assert.equal(reply.data.run.phase, 'done', JSON.stringify(reply));
              assert.match(String(reply.data.run.report), /FIXTURE_OK/);
              if (profile === 'refill') {
                assert.match(
                  String(reply.data.run.report),
                  /Successful panelists: 5/,
                );
                assert.match(
                  String(reply.data.run.report),
                  /Failed panelists: 1/,
                );
              }
              runs.push({ profile, phase: reply.data.run.phase });
              done = true;
              break;
            }
            await delay(50);
          }
          assert.ok(done, `No terminal Fusion report for ${profile}`);
        }
        report.runs = runs;
        report.success = true;
      } catch (error: unknown) {
        report.success = false;
        report.error = error instanceof Error ? error.stack : String(error);
      } finally {
        unsubscribe();
      }
      await ctx.waitForIdle();
      pi.sendMessage({
        customType: 'fusion-compatibility-done',
        content: JSON.stringify(report),
        display: false,
      });
    },
  });
}
