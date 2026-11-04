import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  extractRunObservation,
  mergeRunObservations,
} from '../../src/run-observations.js';

for (const [flag, source] of [
  [true, 'provider'],
  [false, 'estimate'],
  [undefined, undefined],
] as const) {
  test(`cost provenance follows explicit native flag ${flag}`, () => {
    const observation = extractRunObservation({
      model: 'provider/model',
      thinkingLevel: 'high',
      usage: { cost: { total: 0.2, totalFromProvider: flag } },
    });
    assert.equal(observation.thinking, 'high');
    assert.equal(observation.usage?.costUsd, 0.2);
    assert.equal(observation.usage?.costSource, source);
  });
}

test('aggregate cost cannot borrow billed provenance from a different child amount', () => {
  const observation = extractRunObservation({
    totalCost: { costUsd: 2 },
    usage: { cost: { total: 1, totalFromProvider: true } },
  });
  assert.equal(observation.usage?.costUsd, 2);
  assert.equal(observation.usage?.costSource, undefined);
});

test('native numeric zero cost is known zero, not missing usage', () => {
  assert.equal(
    extractRunObservation({ usage: { input: 0, output: 0, cost: 0 } }).usage
      ?.costUsd,
    0,
  );
});

test('a new unlabelled amount cannot inherit billed provenance from an older amount', () => {
  const merged = mergeRunObservations(
    { usage: { costUsd: 1, costSource: 'provider' }, thinking: 'high' },
    { usage: { costUsd: 2 } },
  );
  assert.equal(merged.usage?.costUsd, 2);
  assert.equal(merged.usage?.costSource, undefined);
  assert.equal(merged.thinking, 'high');
});
