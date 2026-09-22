import assert from 'node:assert/strict';
import { test } from 'vitest';
import { nativeTerminalProof } from '../../src/runtime-contract.js';

const native = {
  operationId: 'native-operation',
  digest: 'native-request-digest',
};

function proof() {
  const binding = {
    operationId: 'kernel-operation',
    requestDigest: 'kernel-request-digest',
    hostId: '11111111-2222-3333-4444-555555555555',
    bootId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
  };
  const identity = {
    version: 1,
    backend: 'darwin-resource-coalition-v1',
    ...binding,
    coalitionId: '345',
    leader: { pid: 1234, uniqueId: '5678', pidVersion: 0 },
  };
  return {
    version: 1,
    state: 'observed',
    runId: 'native-run',
    runnerProcessInstanceId: 'runner-instance',
    observedAt: 1,
    processTreeOwnership: {
      version: 1,
      scope: 'owned-process-tree',
      escapedDescendants: 'contained',
    },
    nativeOperation: native,
    kernelBinding: binding,
    kernelProof: {
      status: 'retired',
      binding,
      identity,
      proof: {
        kind: 'darwin-coalition-retired',
        ...binding,
        identity,
        observedAt: '2026-09-21T00:00:00.000Z',
      },
    },
  };
}

test('retired kernel evidence binds native and kernel identities separately', () => {
  const evidence = proof();
  assert.notEqual(
    evidence.nativeOperation.digest,
    evidence.kernelBinding.requestDigest,
  );
  assert.deepEqual(
    nativeTerminalProof(
      { processTerminalProof: evidence },
      'native-run',
      native,
    ),
    evidence,
  );
});

const corruptions: Array<
  [string, (value: ReturnType<typeof proof>) => unknown]
> = [
  [
    'foreign native request',
    (p) => ({
      ...p,
      nativeOperation: { ...p.nativeOperation, digest: 'other' },
    }),
  ],
  [
    'foreign native operation',
    (p) => ({
      ...p,
      nativeOperation: { ...p.nativeOperation, operationId: 'other' },
    }),
  ],
  [
    'foreign kernel request',
    (p) => ({
      ...p,
      kernelProof: {
        ...p.kernelProof,
        binding: { ...p.kernelProof.binding, requestDigest: 'other' },
      },
    }),
  ],
  [
    'foreign kernel host',
    (p) => ({
      ...p,
      kernelBinding: {
        ...p.kernelBinding,
        hostId: 'ffffffff-2222-3333-4444-555555555555',
      },
    }),
  ],
  [
    'foreign coalition',
    (p) => ({
      ...p,
      kernelProof: {
        ...p.kernelProof,
        proof: {
          ...p.kernelProof.proof,
          identity: { ...p.kernelProof.proof.identity, coalitionId: '999' },
        },
      },
    }),
  ],
  [
    'reused leader incarnation',
    (p) => ({
      ...p,
      kernelProof: {
        ...p.kernelProof,
        proof: {
          ...p.kernelProof.proof,
          identity: {
            ...p.kernelProof.proof.identity,
            leader: { ...p.kernelProof.proof.identity.leader, pidVersion: 1 },
          },
        },
      },
    }),
  ],
  [
    'active coalition',
    (p) => ({ ...p, kernelProof: { ...p.kernelProof, status: 'active' } }),
  ],
  [
    'zero counters',
    (p) => ({
      ...p,
      kernelProof: {
        ...p.kernelProof,
        proof: {
          ...p.kernelProof.proof,
          kind: 'coalition-empty',
          activeProcesses: 0,
        },
      },
    }),
  ],
  [
    'missing launch label',
    (p) => ({
      ...p,
      kernelProof: {
        ...p.kernelProof,
        proof: { ...p.kernelProof.proof, kind: 'launchd-label-absent' },
      },
    }),
  ],
  [
    'noncanonical observed date',
    (p) => ({
      ...p,
      kernelProof: {
        ...p.kernelProof,
        proof: { ...p.kernelProof.proof, observedAt: '2026-09-21' },
      },
    }),
  ],
  ['missing kernel witness', (p) => ({ ...p, kernelProof: undefined })],
  [
    'unknown backend',
    (p) => ({
      ...p,
      kernelProof: {
        ...p.kernelProof,
        identity: { ...p.kernelProof.identity, backend: 'process-group' },
      },
    }),
  ],
];

for (const [name, corrupt] of corruptions) {
  test(`kernel proof rejects ${name}`, () => {
    assert.equal(
      nativeTerminalProof(
        { processTerminalProof: corrupt(proof()) },
        'native-run',
        native,
      ),
      undefined,
    );
  });
}
