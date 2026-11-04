import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  extractFusionProgressCounts,
  formatProgressCounts,
  isTerminalFusionProgress,
} from '../../src/status.js';

for (const state of ['mystery', 'paused', 'detached', 'partial']) {
  test(`incomplete ${state} output never proves terminal progress`, () => {
    assert.equal(
      isTerminalFusionProgress({
        steps: [{ state, output: 'Partial findings' }],
      }),
      false,
    );
    assert.equal(
      extractFusionProgressCounts({
        steps: [{ state, output: 'Partial findings' }],
      })?.completed,
      0,
    );
  });
}

for (const state of ['running', 'queued']) {
  test(`explicit ${state} wins over a partial success flag`, () => {
    assert.equal(
      isTerminalFusionProgress({
        steps: [{ state, success: true, output: 'Partial' }],
      }),
      false,
    );
  });
}

test('queued progress is visible', () => {
  assert.match(
    formatProgressCounts({
      total: 4,
      pending: 2,
      running: 1,
      completed: 1,
      failed: 0,
    }),
    /2 queued/,
  );
});

for (const state of ['cancelled', 'stopped', 'rejected', 'timed_out']) {
  test(`explicit ${state} is a terminal failure, not a successful partial answer`, () => {
    const payload = { steps: [{ state, output: 'Partial findings' }] };
    assert.equal(isTerminalFusionProgress(payload), true);
    assert.equal(extractFusionProgressCounts(payload)?.failed, 1);
    assert.equal(extractFusionProgressCounts(payload)?.completed, 0);
  });
}
