import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ordinaryRetirementDetail,
  ordinaryTerminalProof,
} from '../../src/native-stop-proof.js';

const proof = {
  version: 1,
  kind: 'workflow',
  runId: 'native-1',
  state: 'observed',
  dispatchClosed: true,
  observedAt: 1,
  children: [],
};

test('ordinary retirement requires exact target and closed native dispatch', () => {
  assert.deepEqual(
    ordinaryTerminalProof(
      { details: { workflowTerminalProof: proof } },
      'native-1',
    ),
    proof,
  );
  assert.equal(
    ordinaryTerminalProof({ workflowTerminalProof: proof }, 'other'),
    undefined,
  );
  for (const patch of [
    { state: 'pending' },
    { dispatchClosed: false },
    { observedAt: NaN },
    { version: 2 },
    { children: [{ state: 'unknown' }] },
  ])
    assert.equal(
      ordinaryTerminalProof(
        { workflowTerminalProof: { ...proof, ...patch } },
        'native-1',
      ),
      undefined,
    );
});

test('unknown writer closure is exposed as a diagnostic, never an exit proof', () => {
  const payload = {
    details: {
      workflowTerminalProof: {
        ...proof,
        state: 'unknown',
        reason: 'writer-close-unverified',
      },
    },
  };
  assert.equal(ordinaryTerminalProof(payload, 'native-1'), undefined);
  assert.match(
    ordinaryRetirementDetail(payload, 'native-1'),
    /unknown: writer-close-unverified/,
  );
});

test('a stop receipt is not terminal evidence', () => {
  assert.equal(
    ordinaryTerminalProof({ runId: 'native-1', state: 'stopping' }, 'native-1'),
    undefined,
  );
});
