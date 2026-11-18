import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { isRecord } from '../../src/utils.js';
import { mountFusion } from '../support/fusion-extension-fixture.js';

test.for(['status', 'artifact'] as const)(
  'workflow failure category reaches the persisted run and report from %s',
  async (source, t) => {
    const { cwd, pi, start, complete } = await mountFusion(t);
    const kind = source === 'artifact' ? 'child' : 'runtime';
    if (source === 'artifact') {
      const dir = join(cwd, 'async-subagent-runs', 'panel-1');
      const resultsDir = join(cwd, 'async-subagent-results');
      await mkdir(dir, { recursive: true });
      await mkdir(resultsDir);
      await writeFile(
        join(dir, 'status.json'),
        JSON.stringify({ runId: 'panel-1', state: 'running' }),
      );
      pi.events.spawnAsyncDirs.set('panel-1', dir);
      await start();
      await writeFile(
        join(resultsDir, 'panel-1.json'),
        JSON.stringify({
          state: 'complete',
          workflow: { failureKind: kind },
          results: Array.from({ length: 3 }, () => ({
            success: false,
            error: 'child failed',
          })),
        }),
      );
    } else {
      await start();
      pi.events.statusResults.set('panel-1', {
        runId: 'panel-1',
        state: 'failed',
        error: 'runtime broke',
        workflow: { failureKind: kind },
      });
    }
    await complete();
    assert.ok(
      pi.messages
        .at(-1)
        ?.content.includes(`Workflow failure category: ${kind}`),
    );
    const run = pi.entries.at(-1)?.data;
    assert.ok(isRecord(run));
    assert.equal(run.failureKind, kind);
  },
);

test('launch tool returns a structured receipt and marks conflicts as errors', async (t) => {
  const { pi, ctx } = await mountFusion(t);
  const tool = pi.tools.get('start_fusion_review');
  assert.ok(tool);
  const result = (await tool.execute(
    'one',
    { prompt: 'review' },
    undefined,
    undefined,
    ctx,
  )) as {
    structuredContent: { status: string; runId: string };
    isError: boolean;
  };
  assert.equal(result.structuredContent.status, 'started');
  assert.ok(result.structuredContent.runId);
  assert.equal(result.isError, false);
  const conflict = (await tool.execute(
    'two',
    { prompt: 'review' },
    undefined,
    undefined,
    ctx,
  )) as { structuredContent: { status: string }; isError: boolean };
  assert.equal(conflict.structuredContent.status, 'conflict');
  assert.equal(conflict.isError, true);
});

test('a child that reports success without an answer does not discard its siblings', async (t) => {
  const { pi, start, complete } = await mountFusion(t);
  await start();
  pi.events.statusResults.set('panel-1', {
    runId: 'panel-1',
    state: 'complete',
    results: [
      { success: true, output: ' ' },
      { success: true, output: 'First usable answer' },
      { success: false, error: 'OAuth refresh failed for fixture: HTTP 400' },
    ],
  });
  await complete();

  const report = pi.messages.at(-1)?.content ?? '';
  assert.match(report, /First usable answer/);
  assert.match(report, /reported success but returned no answer/);
  assert.match(report, /OAuth refresh failed/);
  assert.equal(pi.events.spawns.length, 1);
});
