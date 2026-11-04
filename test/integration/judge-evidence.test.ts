import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  extractJudgeOutput,
  FusionOrchestrator,
  type FusionRpcClientLike,
} from '../../src/orchestrator.js';
import { FusionRunStore } from '../../src/run-store.js';
import { nextTick } from '../support/fake-pi.js';

const output =
  '# Fusion Report\n## Summary\nComplete synthesis.\n## Recommendation\n' +
  'evidence '.repeat(300) +
  'JUDGE_FINAL_END';
const completion = {
  runId: 'native-judge',
  state: 'complete',
  results: [{ agent: 'judge', success: true, output }],
};

test('terminal native workflow return contains the judge answer, not execution prose', () => {
  assert.deepEqual(
    extractJudgeOutput({
      mode: 'workflow',
      state: 'complete',
      workflow: { value: { key: 'judge', ok: true, output } },
    }),
    { ok: true, output },
  );
  assert.equal(
    extractJudgeOutput({
      mode: 'workflow',
      state: 'complete',
      results: [],
      summary: 'Workflow completed. Return: {"output":"preview"}',
    }).ok,
    false,
  );
  const failed = extractJudgeOutput({
    mode: 'workflow',
    workflow: {
      value: {
        key: 'judge',
        ok: false,
        error: 'Provider rejected request',
        output: 'Partial text',
      },
    },
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error, /Provider rejected/);
});

test('consumed artifact does not discard matching completion queued during a poll', async (t) => {
  const terminal = {
    runId: 'native-judge',
    mode: 'workflow',
    state: 'complete',
    endedAt: Date.now(),
    steps: [{ agent: 'judge', status: 'complete' }],
  };
  const { store, orchestrator, rpc } = fixture(terminal);
  t.onTestFinished(() => orchestrator.dispose());
  let unblock: (value: unknown) => void = () => assert.fail('poll not started');
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  rpc.status = () => {
    entered();
    return new Promise((resolve) => {
      unblock = resolve;
    });
  };
  const polling = orchestrator.getStatusReport();
  await started;
  await orchestrator.handleSubagentComplete(completion);
  await orchestrator.handleSubagentComplete({
    runId: 'unrelated',
    state: 'complete',
    results: [],
  });
  rpc.status = async () => terminal;
  unblock(terminal);
  await polling;
  await nextTick();
  assert.equal(store.getLastRunSummary()?.phase, 'done');
  assert.match(store.getLastRunSummary()?.report ?? '', /JUDGE_FINAL_END/);
});

test('empty completion cannot shadow a complete retained native judge value', async (t) => {
  const f = fixture({
    runId: 'native-judge',
    mode: 'workflow',
    state: 'running',
    steps: [],
  });
  t.onTestFinished(() => f.orchestrator.dispose());
  await f.orchestrator.handleSubagentComplete({
    runId: 'native-judge',
    results: [],
  });
  f.rpc.status = async () => ({
    runId: 'native-judge',
    mode: 'workflow',
    state: 'complete',
    workflow: { value: { key: 'judge', ok: true, output } },
  });
  await f.orchestrator.getStatusReport();
  assert.equal(f.store.getLastRunSummary()?.phase, 'done');
  assert.match(f.store.getLastRunSummary()?.report ?? '', /JUDGE_FINAL_END/);
});

test('missing output waits for evidence once, then fails without retrying synthesis', async (t) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { store, orchestrator } = fixture({
    runId: 'native-judge',
    state: 'complete',
    results: [],
  });
  t.onTestFinished(() => orchestrator.dispose());
  await orchestrator.getStatusReport();
  assert.equal(store.getActiveRun()?.phase, 'judge');
  vi.setSystemTime(Date.now() + 5_001);
  await orchestrator.getStatusReport();
  assert.equal(store.getLastRunSummary()?.phase, 'failed');
  assert.match(store.getLastRunSummary()?.error ?? '', /without output/);
});

function fixture(payload: unknown) {
  const store = new FusionRunStore();
  store.startRun({
    id: 'fusion-evidence',
    prompt: 'review',
    profileName: 'test',
    phase: 'judge',
    profileSnapshot: {
      panel: [
        { id: 'a', agent: 'panel' },
        { id: 'b', agent: 'panel' },
      ],
      judge: { agent: 'judge' },
      minimumSuccessfulPanelists: 2,
    },
  });
  store.updateRun('fusion-evidence', {
    judgeRunId: 'native-judge',
  });
  const rpc: FusionRpcClientLike = {
    ping: async () => ({}),
    status: async () => payload,
    spawn: async () => assert.fail('must not retry model work'),
    stop: async () => ({}),
    interrupt: async () => ({}),
  };
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store });
  return { store, orchestrator, rpc };
}
