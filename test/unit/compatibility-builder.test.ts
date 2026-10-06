import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import { resolveMinimumSuccessfulPanelists } from '../../src/panel-quorum.js';
import {
  buildJudgeSpawnParams,
  buildPanelSpawnParams,
  resolveEffectiveTimeouts,
} from '../../src/run-builder.js';
import type { FusionProfile } from '../../src/types.js';

const profile: FusionProfile = {
  panel: Array.from({ length: 4 }, (_, index) => ({
    id: `member-${index}`,
    agent: 'pi-fusion.fusion-panelist',
  })),
  judge: { agent: 'pi-fusion.fusion-judge' },
  concurrency: 4,
  minimumSuccessfulPanelists: 2,
  stopWhenPanelAgrees: true,
};

test('all ordinary launch envelopes use the public inline script field', () => {
  for (const params of [
    buildPanelSpawnParams(profile, 'review'),
    buildJudgeSpawnParams({
      profile,
      prompt: 'review',
      panelOutputs: [],
      failedPanelists: [],
      runId: 'fusion-1',
    }),
  ]) {
    assert.equal('workflowScript' in params, false);
    assert.ok('script' in params && typeof params.script === 'string');
  }
});

test('agreement deadline covers the actual quorum-sized waves', () => {
  const timeouts = resolveEffectiveTimeouts(profile);
  assert.equal(timeouts.panelTimeoutMs, 1_800_000);
  assert.ok(
    timeouts.panelTimeoutMs >=
      timeouts.panelistTimeoutMs * 2 + timeouts.panelGraceMs,
  );
});

test('soft deadlines reject an explicit budget too short for agreement waves', () => {
  assert.throws(
    () =>
      resolveEffectiveTimeouts({
        ...profile,
        panelistSoftTimeoutMs: 600_000,
        panelTimeoutMs: 900_000,
      }),
    /every concurrency wave/,
  );
});

test('every multi-member quorum requires at least two answers', () => {
  for (const [size, expected] of [
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 2],
    [5, 3],
    [6, 3],
  ] as const) {
    assert.equal(resolveMinimumSuccessfulPanelists(undefined, size), expected);
    assert.equal(resolveMinimumSuccessfulPanelists('majority', size), expected);
    assert.equal(resolveMinimumSuccessfulPanelists('all', size), size);
    assert.equal(resolveMinimumSuccessfulPanelists(1, size), Math.min(2, size));
  }
});

test('two-member agreement cannot stop after one decision', async () => {
  const launches: string[] = [];
  const emitted: unknown[] = [];
  const params = buildPanelSpawnParams(
    {
      panel: profile.panel.slice(0, 2),
      judge: profile.judge,
      concurrency: 2,
      stopWhenPanelAgrees: true,
    },
    'compare',
  );
  const execute = runInNewContext(`(async () => { ${params.script} })()`, {
    runs: {
      all(tasks: Array<{ key: string }>) {
        launches.push(...tasks.map((task) => task.key));
        return Promise.resolve(
          tasks.map(() => ({
            ok: true,
            output:
              '<fusion-panel-decision>{"recommendation":"Choose A","confidence":"high","needsMoreEvidence":false}</fusion-panel-decision>',
          })),
        );
      },
    },
    emit: (value: unknown) => emitted.push(value),
  });
  await execute;
  assert.deepEqual(launches, ['panel-1', 'panel-2']);
  assert.equal(emitted.length, 0);
});

test('exact output contracts reject agreement stopping before dispatch', () => {
  assert.throws(
    () => buildPanelSpawnParams(profile, 'review', 'plan-review-v1'),
    /exact.*contract|contract.*agreement/i,
  );
});
