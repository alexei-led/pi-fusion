import assert from 'node:assert/strict';
import { type TestContext, test } from 'vitest';
import {
  FusionOrchestrator,
  type FusionRpcClientLike,
} from '../../src/orchestrator.js';
import { FusionRunStore } from '../../src/run-store.js';
import { SubagentsRpcRemoteError } from '../../src/subagents-rpc.js';
import { FakePi } from '../support/fake-pi.js';

test('ordinary stop holds admission until exact native retirement, without duplicate stops', async (t) => {
  const f = fixture(t);
  assert.equal((await f.orchestrator.cancelActiveRun(f.ctx)).status, 'started');
  assert.equal(
    f.store.getActiveRun()?.cancellationDelivery?.state,
    'delivered',
  );
  assert.equal(f.stops.length, 1);
  for (const proof of [
    undefined,
    { ...f.proof, runId: 'other' },
    { ...f.proof, dispatchClosed: false },
  ]) {
    f.setStatus({
      runId: 'native-1',
      state: 'stopped',
      workflowTerminalProof: proof,
    });
    await f.orchestrator.getStatusReport();
    assert.equal(f.store.getActiveRun()?.cancellationRequested, true);
    assert.equal(f.stops.length, 1);
  }
  f.setStatus({
    details: { runId: 'native-1', workflowTerminalProof: f.proof },
  });
  await f.orchestrator.getStatusReport();
  assert.equal(f.store.getLastRunSummary()?.phase, 'cancelled');
  assert.equal(f.store.getActiveRun(), undefined);
});

for (const code of [
  'execution_failed',
  'not_found',
  'invalid_state',
  'invalid_params',
]) {
  test(`stop ${code} never becomes interrupt or proof of exit`, async (t) => {
    const f = fixture(t, code);
    assert.equal(
      (await f.orchestrator.cancelActiveRun(f.ctx)).status,
      'started',
    );
    assert.equal(f.store.getActiveRun()?.cancellationRequested, true);
    assert.equal(
      f.store.getActiveRun()?.cancellationDelivery?.state,
      ['not_found', 'invalid_state'].includes(code)
        ? 'undeliverable'
        : 'pending',
    );
    assert.equal(f.stops.length, 1);
  });
}

function fixture(t: TestContext, code?: string) {
  const store = new FusionRunStore();
  store.startRun({
    id: 'fusion-stop',
    prompt: 'review',
    profileName: 'quality',
  });
  store.updateRun('fusion-stop', { panelRunId: 'native-1' });
  let status: unknown = { runId: 'native-1', state: 'running' };
  const stops: unknown[] = [];
  const rpc: FusionRpcClientLike = {
    ping: async () => ({}),
    spawn: async () => assert.fail('must not replay'),
    stop: async (params) => {
      stops.push(params);
      if (code)
        throw new SubagentsRpcRemoteError({
          code,
          message: 'native stop rejected',
          requestId: 'stop-request',
          method: 'stop',
        });
      return { runId: 'native-1', state: 'stopping' };
    },
    interrupt: async () => assert.fail('interrupt is not stop fallback'),
    status: async () => status,
  };
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store });
  t.onTestFinished(() => orchestrator.dispose());
  return {
    store,
    orchestrator,
    stops,
    ctx: new FakePi().createContext(),
    setStatus: (value: unknown) => {
      status = value;
    },
    proof: {
      version: 1,
      kind: 'workflow',
      runId: 'native-1',
      state: 'observed',
      dispatchClosed: true,
      observedAt: 1,
      children: [],
    },
  };
}
