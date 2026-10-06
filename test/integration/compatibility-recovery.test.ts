import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test, vi } from 'vitest';
import {
  FusionOrchestrator,
  type FusionRpcClientLike,
} from '../../src/orchestrator.js';
import { FusionRunStore } from '../../src/run-store.js';
import { SubagentsRpcRemoteError } from '../../src/subagents-rpc.js';
import { createProjectDir, FakePi } from '../support/fake-pi.js';

async function fixture(t: TestContext) {
  const cwd = await createProjectDir(t);
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);
  const directory = join(cwd, '.pi', 'fusion', 'runs');
  const store = new FusionRunStore({ directory });
  const spawns: object[] = [];
  const status = new Map<string, unknown>();
  const stops: string[] = [];
  let spawnFailure: Error | undefined;
  const rpc: FusionRpcClientLike = {
    async ping() {
      return {};
    },
    async spawn(params) {
      spawns.push(params);
      if (spawnFailure) throw spawnFailure;
      return { runId: `native-${spawns.length}` };
    },
    async status(params) {
      return status.get(params?.id ?? '') ?? {};
    },
    async stop(params) {
      stops.push(params.id ?? '');
      return { runId: params.id, state: 'stopping' };
    },
    async interrupt() {
      return { state: 'paused' };
    },
  };
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store });
  t.onTestFinished(() => orchestrator.dispose());
  return {
    directory,
    ctx,
    store,
    rpc,
    spawns,
    status,
    stops,
    orchestrator,
    failSpawn(error: Error) {
      spawnFailure = error;
    },
  };
}

test('ordinary workflow identity and exact request survive durable reload', async (t) => {
  const f = await fixture(t);
  await f.orchestrator.startRun('review', f.ctx);
  const run = f.store.getActiveRun();
  assert.ok(run);
  const params = f.spawns[0];
  assert.ok(params && 'args' in params);
  assert.deepEqual(params.args, { fusionRunId: run.id, stage: 'panel' });
  const restored = new FusionRunStore({
    directory: f.directory,
  }).getActiveRun();
  assert.deepEqual(restored?.spawnIntent?.params, params);
  assert.ok(restored?.spawnIntent?.requestId);
});

for (const stage of ['panel', 'judge', 'chain'] as const) {
  test(`runtime-replaced ${stage} holds admission across restart without replay`, async (t) => {
    const f = await fixture(t);
    const run = f.store.startRun({
      prompt: 'review',
      profileName: 'quality',
      phase: stage,
    });
    f.store.updateRun(
      run.id,
      stage === 'judge'
        ? { judgeRunId: 'old-native' }
        : stage === 'chain'
          ? { chainRunId: 'old-native' }
          : { panelRunId: 'old-native' },
    );
    f.status.set('old-native', {
      runId: 'old-native',
      mode: 'workflow',
      state: 'stopped',
      workflow: { stopCause: 'runtime-replaced' },
      steps: [{ agent: 'panel-1', runId: 'still-alive', status: 'running' }],
    });
    await f.orchestrator.restore(f.ctx);
    assert.equal(f.store.getActiveRun()?.recoveryRequired, 'runtime-replaced');
    const restored = new FusionRunStore({ directory: f.directory });
    assert.equal(restored.getActiveRun()?.recoveryRequired, 'runtime-replaced');
    assert.equal(
      (await f.orchestrator.startRun('new review', f.ctx)).status,
      'conflict',
    );
    await f.orchestrator.cancelActiveRun(f.ctx);
    assert.ok(f.store.getActiveRun());
    assert.equal(f.spawns.length, 0);
    assert.match(await f.orchestrator.getStatusReport(), /recovery required/i);
  });
}

test('generic execution_failed cannot prove no-start even for a capacity rejection message', async (t) => {
  const f = await fixture(t);
  f.failSpawn(
    new SubagentsRpcRemoteError({
      code: 'execution_failed',
      message: 'Active async capacity exhausted',
      requestId: 'capacity-request',
      method: 'spawn',
    }),
  );
  assert.equal(
    (await f.orchestrator.startRun('review', f.ctx)).status,
    'started',
  );
  assert.equal(f.store.getActiveRun()?.recoveryRequired, 'launch-unknown');
  assert.equal(
    (await f.orchestrator.startRun('retry', f.ctx)).status,
    'conflict',
  );
});

test('lost spawn reply stays unresolved, including cancellation and restart', async (t) => {
  const f = await fixture(t);
  f.failSpawn(new Error('reply lost after remote dispatch'));
  const result = await f.orchestrator.startRun('review', f.ctx);
  assert.equal(result.status, 'started');
  assert.equal(f.store.getActiveRun()?.recoveryRequired, 'launch-unknown');
  await f.orchestrator.cancelActiveRun(f.ctx);
  assert.equal(f.store.getActiveRun()?.cancellationRequested, true);
  f.orchestrator.dispose();
  const store = new FusionRunStore({ directory: f.directory });
  const next = new FusionOrchestrator({ rpc: f.rpc, runStore: store });
  t.onTestFinished(() => next.dispose());
  await next.restore(f.ctx);
  assert.equal((await next.startRun('new review', f.ctx)).status, 'conflict');
  assert.equal(f.spawns.length, 1);
});

test('a new same-prompt operation has a new workflow identity', async (t) => {
  const f = await fixture(t);
  await f.orchestrator.startRun('review', f.ctx);
  f.status.set('native-1', {
    state: 'complete',
    results: [0, 1, 2].map(() => ({
      agent: 'panel',
      success: true,
      output: 'Choose A',
    })),
  });
  await f.orchestrator.handleSubagentComplete({ runId: 'native-1' });
  const judge = f.spawns[1];
  assert.ok(judge && 'args' in judge);
  assert.deepEqual(judge.args, {
    fusionRunId: f.store.getActiveRun()?.id,
    stage: 'judge',
  });
  f.status.set('native-2', {
    state: 'complete',
    results: [
      {
        agent: 'judge',
        success: true,
        output: '# Fusion Report\n\n## Recommendation\nChoose A',
      },
    ],
  });
  await f.orchestrator.handleSubagentComplete({ runId: 'native-2' });
  assert.equal(f.store.getActiveRun(), undefined);
  await f.orchestrator.startRun('review', f.ctx);
  const first = f.spawns[0],
    second = f.spawns[2];
  assert.ok(first && second && 'args' in first && 'args' in second);
  assert.notDeepEqual(second.args, first.args);
});

function deferred<T>() {
  let settle: (value: T) => void = () => {
    throw new Error('Promise not initialized');
  };
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle(value) };
}

for (const stage of ['panel', 'judge'] as const) {
  for (const cancel of [false, true]) {
    test(`disposed ${stage} launch preserves late binding and quarantine (cancel=${cancel})`, async (t) => {
      const f = await fixture(t);
      if (stage === 'judge') {
        await f.orchestrator.startRun('review', f.ctx);
        f.status.set('native-1', {
          state: 'complete',
          results: [0, 1, 2].map(() => ({
            agent: 'panel',
            success: true,
            output: 'Choose A',
          })),
        });
      }
      const entered = deferred<void>();
      const reply = deferred<unknown>();
      f.rpc.spawn = async (params) => {
        f.spawns.push(params);
        entered.resolve();
        return reply.promise;
      };
      const pending =
        stage === 'panel'
          ? f.orchestrator.startRun('review', f.ctx)
          : f.orchestrator.handleSubagentComplete({ runId: 'native-1' });
      await entered.promise;
      f.orchestrator.dispose();
      const store = new FusionRunStore({ directory: f.directory });
      const next = new FusionOrchestrator({ rpc: f.rpc, runStore: store });
      t.onTestFinished(() => next.dispose());
      await next.restore(f.ctx);
      if (cancel) await next.cancelActiveRun(f.ctx);
      const timers = vi.spyOn(globalThis, 'setInterval');
      t.onTestFinished(() => timers.mockRestore());
      reply.resolve({ runId: 'late-native' });
      await pending;
      store.refreshDurable();
      const retained = store.getActiveRun();
      assert.equal(retained?.recoveryRequired, 'launch-unknown');
      assert.equal(
        stage === 'panel' ? retained?.panelRunId : retained?.judgeRunId,
        'late-native',
      );
      assert.equal(retained?.cancellationRequested === true, cancel);
      assert.equal(timers.mock.calls.length, 0);
      assert.equal(f.stops.length, 0);
      await next.getStatusReport();
      await next.getStatusReport();
      assert.deepEqual(f.stops, cancel ? ['late-native'] : []);
      assert.equal(store.getActiveRun()?.recoveryRequired, 'launch-unknown');
      assert.equal(
        (await next.startRun('new review', f.ctx)).status,
        'conflict',
      );
      if (cancel) {
        assert.deepEqual(store.getActiveRun()?.cancellationDelivery, {
          runId: 'late-native',
          state: 'delivered',
        });
        next.dispose();
        const restarted = new FusionOrchestrator({
          rpc: f.rpc,
          runStore: new FusionRunStore({ directory: f.directory }),
        });
        t.onTestFinished(() => restarted.dispose());
        await restarted.restore(f.ctx);
        assert.deepEqual(f.stops, ['late-native']);
        assert.equal(
          (await restarted.startRun('new review', f.ctx)).status,
          'conflict',
        );
      }
    });
  }
}

for (const stage of ['panel', 'judge', 'chain'] as const) {
  test(`runtime-replaced status cannot be hidden by a successful ${stage} result artifact`, async (t) => {
    const f = await fixture(t);
    const run = f.store.startRun({
      prompt: 'review',
      profileName: 'quality',
      phase: stage,
    });
    const asyncDir = join(f.ctx.cwd, 'async-subagent-runs', 'old-native');
    await mkdir(asyncDir, { recursive: true });
    await mkdir(join(f.ctx.cwd, 'async-subagent-results'), { recursive: true });
    f.store.updateRun(
      run.id,
      stage === 'judge'
        ? { judgeRunId: 'old-native', judgeAsyncDir: asyncDir }
        : stage === 'chain'
          ? { chainRunId: 'old-native', chainAsyncDir: asyncDir }
          : { panelRunId: 'old-native', panelAsyncDir: asyncDir },
    );
    await writeFile(
      join(asyncDir, 'status.json'),
      JSON.stringify({
        runId: 'old-native',
        state: 'stopped',
        mode: 'workflow',
        workflow: { stopCause: 'runtime-replaced' },
      }),
    );
    await writeFile(
      join(f.ctx.cwd, 'async-subagent-results', 'old-native.json'),
      JSON.stringify({
        runId: 'old-native',
        state: 'complete',
        results: Array.from({ length: stage === 'judge' ? 1 : 3 }, () => ({
          agent: stage === 'judge' ? 'judge' : 'panel',
          success: true,
          output: 'Choose A',
        })),
      }),
    );
    await f.orchestrator.restore(f.ctx);
    assert.equal(f.store.getActiveRun()?.recoveryRequired, 'runtime-replaced');
    assert.equal(f.spawns.length, 0);
  });
}

test('live-owner polling delivers a pending stop after late binding and retries a rejected receipt', async (t) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const f = await fixture(t);
  const run = f.store.startRun({
    prompt: 'review',
    profileName: 'quality',
    phase: 'panel',
  });
  f.store.updateRun(run.id, {
    recoveryRequired: 'launch-unknown',
    cancellationRequested: true,
    spawnIntent: { stage: 'panel', requestedAt: Date.now() },
  });
  await f.orchestrator.restore(f.ctx);
  const attempts: string[] = [];
  let rejected = true;
  f.rpc.stop = async (params) => {
    attempts.push(params.id ?? '');
    if (rejected) throw new Error('Native controller temporarily unavailable');
    return { runId: params.id, state: 'stopping' };
  };
  const binder = new FusionRunStore({ directory: f.directory });
  binder.updateRun(run.id, { panelRunId: 'late-native' });
  await vi.advanceTimersByTimeAsync(2_000);
  assert.deepEqual(attempts, ['late-native']);
  assert.deepEqual(f.store.getActiveRun()?.cancellationDelivery, {
    runId: 'late-native',
    state: 'pending',
    error: 'Native controller temporarily unavailable',
  });
  assert.equal(f.store.getActiveRun()?.recoveryRequired, 'launch-unknown');
  rejected = false;
  await vi.advanceTimersByTimeAsync(2_000);
  assert.deepEqual(attempts, ['late-native', 'late-native']);
  assert.deepEqual(f.store.getActiveRun()?.cancellationDelivery, {
    runId: 'late-native',
    state: 'delivered',
  });
  await vi.advanceTimersByTimeAsync(4_000);
  assert.equal(attempts.length, 2);
  assert.equal(f.store.getActiveRun()?.phase, 'panel');
  assert.equal(f.store.getActiveRun()?.processTerminalProof, undefined);
  assert.equal(f.spawns.length, 0);
});

for (const code of ['not_found', 'invalid_state'] as const) {
  test(`permanent native stop rejection ${code} is undeliverable across polling and restore`, async (t) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture(t);
    const run = f.store.startRun({
      prompt: 'review',
      profileName: 'quality',
      phase: 'panel',
    });
    f.store.updateRun(run.id, {
      panelRunId: 'lost-coordinator',
      recoveryRequired: 'runtime-replaced',
    });
    let attempts = 0;
    f.rpc.stop = async () => {
      attempts++;
      throw new SubagentsRpcRemoteError({
        code,
        message: 'No live workflow controller',
        requestId: 'stop-request',
        method: 'stop',
      });
    };
    await f.orchestrator.cancelActiveRun(f.ctx);
    assert.equal(
      f.store.getActiveRun()?.cancellationDelivery?.state,
      'undeliverable',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await f.orchestrator.getStatusReport();
    assert.equal(attempts, 1);
    f.orchestrator.dispose();
    const next = new FusionOrchestrator({
      rpc: f.rpc,
      runStore: new FusionRunStore({ directory: f.directory }),
    });
    t.onTestFinished(() => next.dispose());
    await next.restore(f.ctx);
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(attempts, 1);
    assert.equal(
      (await next.startRun('replacement', f.ctx)).status,
      'conflict',
    );
    assert.match(
      await next.getStatusReport(),
      /Stop delivery: undeliverable.*No live workflow controller/,
    );
    await next.cancelActiveRun(f.ctx);
    assert.equal(attempts, 2);
    assert.equal(next.getActiveRun()?.recoveryRequired, 'runtime-replaced');
    assert.equal(next.getActiveRun()?.processTerminalProof, undefined);
    assert.equal(f.spawns.length, 0);
  });
}

test('a mismatched stop acknowledgement stays pending and cannot release admission', async (t) => {
  const f = await fixture(t);
  const run = f.store.startRun({
    prompt: 'review',
    profileName: 'quality',
    phase: 'panel',
  });
  f.store.updateRun(run.id, {
    panelRunId: 'exact-native',
    recoveryRequired: 'runtime-replaced',
  });
  f.rpc.stop = async () => ({ runId: 'foreign-native', state: 'stopping' });
  await f.orchestrator.cancelActiveRun(f.ctx);
  assert.equal(f.store.getActiveRun()?.cancellationDelivery?.state, 'pending');
  assert.equal(f.store.getActiveRun()?.recoveryRequired, 'runtime-replaced');
  assert.equal(
    (await f.orchestrator.startRun('new review', f.ctx)).status,
    'conflict',
  );
});

test('proven RPC prelaunch rejection fails without holding admission', async (t) => {
  const f = await fixture(t);
  f.failSpawn(
    new SubagentsRpcRemoteError({
      code: 'invalid_params',
      message: 'Rejected before executor',
      requestId: 'request',
      method: 'spawn',
    }),
  );
  assert.equal(
    (await f.orchestrator.startRun('review', f.ctx)).status,
    'failed',
  );
  assert.equal(f.store.getActiveRun(), undefined);
});

test('exact contract with agreement is a preflight rejection, not an unknown launch', async (t) => {
  const f = await fixture(t);
  const path = join(f.ctx.cwd, '.pi', 'fusion.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.profiles.quality.stopWhenPanelAgrees = true;
  await writeFile(path, JSON.stringify(config));
  const result = await f.orchestrator.startRun(
    {
      prompt: 'review',
      outputContract: 'plan-review-v1',
      profile: 'quality',
    },
    f.ctx,
  );
  assert.equal(result.status, 'failed');
  assert.equal(f.spawns.length, 0);
  assert.equal(f.store.getActiveRun(), undefined);
});
