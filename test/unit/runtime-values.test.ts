import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseFusionConfig } from '../../src/config.js';
import { parseFusionArgs } from '../../src/fusion-args.js';
import { FusionRunStore } from '../../src/run-store.js';
import { isExecutionLifetime } from '../../src/runtime-contract.js';
import {
  extractWorkflowFailureKind,
  isTimerMs,
  MAX_TIMER_MS,
} from '../../src/runtime-values.js';

test('timer boundaries reject values which Node would silently shorten', () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, 2 ** 31, '100']) {
    assert.equal(isTimerMs(value), false);
    assert.equal(
      isExecutionLifetime({ mode: 'bounded', timeoutMs: value }),
      false,
    );
  }
  assert.equal(isTimerMs(MAX_TIMER_MS), true);
  assert.throws(
    () => parseFusionArgs('--judge-timeout-ms 2147483648 review'),
    /Timeout/,
  );
  assert.throws(() =>
    parseFusionConfig(
      JSON.stringify({
        defaultProfile: 'a',
        profiles: {
          a: {
            panel: [{ id: 'a', agent: 'test' }],
            judge: { agent: 'test' },
            timeoutMs: 2 ** 31,
          },
        },
      }),
      'test',
    ),
  );
});

test('known workflow failure categories survive persistence and summaries', () => {
  for (const kind of [
    'validation',
    'script',
    'child',
    'return-serialization',
    'timeout',
    'detached-child',
    'runtime',
  ] as const) {
    assert.equal(
      extractWorkflowFailureKind({
        details: { workflow: { failureKind: kind } },
      }),
      kind,
    );
    const entries: unknown[] = [];
    const store = new FusionRunStore({
      persistence: {
        appendEntry(customType, data) {
          entries.push({ type: 'custom', customType, data });
        },
      },
    });
    const run = store.startRun({ prompt: 'review', profileName: 'test' });
    store.failRun(run.id, { error: 'failure', failureKind: kind });
    const restored = new FusionRunStore();
    restored.restoreFromEntries(entries);
    assert.equal(restored.getLastRunSummary()?.failureKind, kind);
    assert.equal(restored.getRunById(run.id)?.failureKind, kind);
  }
  for (const payload of [
    null,
    { workflow: { failureKind: 'future' } },
    { results: [{ workflow: { failureKind: 'script' } }] },
  ])
    assert.equal(extractWorkflowFailureKind(payload), undefined);
});
