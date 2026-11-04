import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderJudgeReport } from '../../src/report.js';

for (const [sources, label] of [
  [['provider'], 'Total provider-reported cost'],
  [['estimate'], 'Total estimated cost'],
  [['provider', 'estimate'], 'Total cost (mixed sources)'],
  [[undefined], 'Total cost (provenance unknown)'],
] as const) {
  test(`cost aggregate label is ${label}`, () => {
    const report = renderJudgeReport({
      run: {
        id: 'cost',
        prompt: 'Review',
        profileName: 'quality',
        phase: 'judge',
        createdAt: 0,
        updatedAt: 1,
      },
      judgeOutput:
        '# Fusion Report\n## Summary\nAnswer\n## Recommendation\nChoose A',
      panelOutputs: sources.map((source, index) => ({
        index,
        agent: 'panel',
        output: 'Evidence',
        observation: {
          usage: { costUsd: 1, ...(source ? { costSource: source } : {}) },
        },
      })),
      failures: [],
    });
    assert.ok(report.includes(`${label}: $`));
  });
}
