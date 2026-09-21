import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { registerFusionRpc, FUSION_RPC_REQUEST_EVENT, fusionRpcReplyEvent } from "../../src/fusion-rpc.js";
import { FusionOperationJournal } from "../../src/operation-journal.js";
import { FusionOrchestrator, type FusionRpcClientLike } from "../../src/orchestrator.js";
import { FusionRunStore } from "../../src/run-store.js";
import type { FusionConfig } from "../../src/types.js";
import { FakePi } from "../support/fake-pi.js";

const capabilities = {
  executionLifetime: { version: 1, modes: ["unbounded", "bounded"] },
  durableOperations: { version: 1, lookup: true, replay: true, cancelFence: true },
  processTerminalProof: { version: 1 },
  workflowTerminalProof: { version: 1 },
  processTreeOwnership: { version: 1, scope: "owned-process-tree", escapedDescendants: "contained" },
};
const lifetime = { mode: "unbounded" } as const;
const config: FusionConfig = {
  defaultProfile: "quality",
  profiles: { quality: { panel: [{ id: "one", agent: "panelist" }], judge: { agent: "judge" } } },
};

class NativeRuntime implements FusionRpcClientLike {
  spawns: object[] = [];
  loseReply = false;
  proof: unknown;
  cancelled = false;
  statusValue = "running";
  identity: { operationId: unknown; digest: unknown } | undefined;
  async ping(): Promise<unknown> { return { capabilities }; }
  async spawn(params: object): Promise<unknown> {
    this.spawns.push(params);
    assert.ok("operationId" in params && "digest" in params);
    this.identity = { operationId: params.operationId, digest: params.digest };
    if (this.loseReply) throw new Error("spawn reply lost");
    return { ...this.identity, runId: "native-panel", effectiveExecutionLifetime: lifetime };
  }
  async lookup(): Promise<unknown> {
    return { ...this.identity, state: "found", runId: "native-panel", effectiveExecutionLifetime: lifetime, statusPayload: this.payload() };
  }
  async cancel(): Promise<unknown> { this.cancelled = true; return { cancellationRequested: true }; }
  async status(): Promise<unknown> { return this.payload(); }
  async stop(): Promise<unknown> { return { ok: true }; }
  async interrupt(): Promise<unknown> { return { ok: true }; }
  payload(): unknown {
    return { runId: "native-panel", state: this.statusValue, ...(this.proof ? { processTerminalProof: this.proof } : {}), results: [{ agent: "panelist", output: "Answer", success: true }] };
  }
}

function proof() {
  return { version: 1, kind: "workflow", state: "observed", runId: "native-panel", dispatchClosed: true, observedAt: 1, children: [processProof()] };
}

function processProof() {
  return { version: 1, state: "observed", runId: "native-child", runnerProcessInstanceId: "native-instance", observedAt: 1, instances: [], processTreeOwnership: capabilities.processTreeOwnership };
}

test("unbounded launch persists identity and survives old elapsed deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const rpc = new NativeRuntime();
  const store = new FusionRunStore();
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const started = await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, new FakePi().createContext());
  assert.equal(started.status, "started");
  assert.deepEqual(store.getActiveRun()?.effectiveExecutionLifetime, lifetime);
  assert.ok(store.getActiveRun()?.spawnIntent?.requestDigest);
  assert.deepEqual(rpc.spawns[0] && (rpc.spawns[0] as { executionLifetime: unknown }).executionLifetime, lifetime);
  assert.equal("timeoutMs" in rpc.spawns[0]!, false);
  t.mock.timers.tick(120 * 60 * 1000);
  await orchestrator.getStatusReport();
  assert.equal(store.getActiveRun()?.phase, "panel");
  assert.equal(rpc.cancelled, false);
});

test("lost native spawn reply is adopted across restart without duplicate spawn", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "fusion-contract-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, "runs");
  const rpc = new NativeRuntime();
  rpc.loseReply = true;
  const firstStore = new FusionRunStore({ directory });
  const first = new FusionOrchestrator({ rpc, runStore: firstStore, loadConfig: async () => config });
  const ctx = new FakePi().createContext(cwd);
  const started = await first.startRun({ prompt: "Review", operationId: "operation", executionLifetime: lifetime }, ctx);
  assert.equal(started.status, "started");
  assert.equal(firstStore.getActiveRun()?.phase, "panel");
  first.dispose();
  const store = new FusionRunStore({ directory });
  const restored = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => restored.dispose());
  await restored.restore(new FakePi().createContext(cwd));
  assert.equal(rpc.spawns.length, 1);
  assert.equal(store.getActiveRun()?.panelRunId, "native-panel");
  assert.deepEqual(store.getActiveRun()?.effectiveExecutionLifetime, lifetime);
});

test("wrapper terminal and cancel receipt are not native tree exit", async (t) => {
  const rpc = new NativeRuntime();
  const store = new FusionRunStore();
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const ctx = new FakePi().createContext();
  await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, ctx);
  rpc.statusValue = "completed";
  await orchestrator.getStatusReport();
  assert.equal(store.getActiveRun()?.phase, "panel");
  const cancelled = await orchestrator.cancelActiveRun(ctx);
  assert.equal(cancelled.status, "started");
  assert.equal(store.getActiveRun()?.cancellationRequested, true);
  rpc.proof = { ...proof(), runId: "other-run" };
  await orchestrator.getStatusReport();
  assert.equal(store.getActiveRun()?.phase, "panel");
  rpc.proof = proof();
  await orchestrator.getStatusReport();
  assert.equal(store.getLastRunSummary()?.phase, "cancelled");
  assert.equal((store.getLastRunSummary()?.processTerminalProof as { runId: string }).runId, store.getLastRunSummary()?.id);
});

test("unbounded preflight refuses a runtime that only advertises lifetime", async (t) => {
  const rpc = new NativeRuntime();
  rpc.ping = async () => ({ capabilities: { executionLifetime: capabilities.executionLifetime } });
  const orchestrator = new FusionOrchestrator({ rpc, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const result = await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, new FakePi().createContext());
  assert.equal(result.status, "failed");
  assert.equal(rpc.spawns.length, 0);
});

test("stop during an ambiguous launch remains fenced after restart until native exit", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "fusion-stop-race-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, "runs");
  const rpc = new NativeRuntime();
  rpc.loseReply = true;
  const firstStore = new FusionRunStore({ directory });
  const first = new FusionOrchestrator({ rpc, runStore: firstStore, loadConfig: async () => config });
  const ctx = new FakePi().createContext(cwd);
  await first.startRun({ prompt: "Review", operationId: "operation", executionLifetime: lifetime }, ctx);
  await first.cancelActiveRun(ctx);
  assert.equal(firstStore.getActiveRun()?.cancellationRequested, true);
  first.dispose();
  const store = new FusionRunStore({ directory });
  const restored = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => restored.dispose());
  await restored.restore(new FakePi().createContext(cwd));
  assert.equal(store.getActiveRun()?.cancellationRequested, true);
  assert.equal(rpc.spawns.length, 1);
  rpc.proof = proof();
  await restored.getStatusReport();
  assert.equal(store.getLastRunSummary()?.phase, "cancelled");
  assert.equal(rpc.spawns.length, 1);
});

test("workflow closure requires closed dispatch and every native child proof", async (t) => {
  const rpc = new NativeRuntime();
  const store = new FusionRunStore();
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const ctx = new FakePi().createContext();
  await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, ctx);
  await orchestrator.cancelActiveRun(ctx);
  const workflow = { version: 1, kind: "workflow", state: "observed", runId: "native-panel", dispatchClosed: false, observedAt: 2, children: [proof()] };
  rpc.proof = workflow;
  await orchestrator.getStatusReport();
  assert.ok(store.getActiveRun());
  rpc.proof = { ...workflow, dispatchClosed: true, children: [{ ...proof(), state: "pending" }] };
  await orchestrator.getStatusReport();
  assert.ok(store.getActiveRun());
  rpc.proof = { ...workflow, dispatchClosed: true };
  await orchestrator.getStatusReport();
  assert.equal(store.getLastRunSummary()?.phase, "cancelled");
});

test("public RPC preserves durable identity, rejects changed replay, and fences late starts", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "fusion-rpc-contract-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const rpc = new NativeRuntime();
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);
  const store = new FusionRunStore({ directory: join(cwd, "runs") });
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const { registerFusionRpc, FUSION_RPC_REQUEST_EVENT, fusionRpcReplyEvent } = await import("../../src/fusion-rpc.js");
  t.after(registerFusionRpc({ events: pi.events, orchestrator, store, getContext: () => ctx }));
  let next = 0;
  const request = (method: string, params: object): Promise<Record<string, unknown>> => new Promise((resolve) => {
    const requestId = `rpc-${next++}`;
    const off = pi.events.on(fusionRpcReplyEvent(requestId), (value) => {
      assert.ok(typeof value === "object" && value !== null);
      off();
      resolve(value as Record<string, unknown>);
    });
    pi.events.emit(FUSION_RPC_REQUEST_EVENT, { version: 1, requestId, method, params });
  });
  const input = { prompt: "Review", operationId: "rpc-operation", executionLifetime: lifetime };
  assert.equal((await request("start", input)).success, true);
  assert.equal((await request("start", input)).success, true);
  assert.equal(rpc.spawns.length, 1);
  assert.equal((await request("start", { ...input, prompt: "Different" })).success, false);
  const fence = await request("cancel", { operationId: "late-operation" });
  assert.equal(fence.success, true);
  assert.equal((await request("start", { ...input, operationId: "late-operation" })).success, false);
  assert.equal(rpc.spawns.length, 1);
  const busyInput = { ...input, operationId: "busy-operation" };
  assert.equal((await request("start", busyInput)).success, false);
  rpc.proof = proof();
  await request("cancel", { operationId: input.operationId });
  assert.equal((await request("start", busyInput)).success, true);
  assert.equal(rpc.spawns.length, 2);
});

test("closed panel proof cannot acknowledge cancellation of an unresolved judge launch", async (t) => {
  const rpc = new NativeRuntime();
  rpc.proof = proof();
  const store = new FusionRunStore();
  const run = store.startRun({ prompt: "Review", profileName: "quality", executionLifetime: lifetime, phase: "panel" });
  store.updateRun(run.id, {
    panelRunId: "native-panel",
    spawnIntent: { stage: "judge", requestedAt: 1, requestId: `${run.id}:judge`, requestDigest: "digest", params: {} },
  });
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const result = await orchestrator.cancelActiveRun(new FakePi().createContext());
  assert.equal(result.status, "started");
  assert.equal(store.getActiveRun()?.cancellationRequested, true);
  assert.equal(store.getLastRunSummary(), undefined);
});

test("empty process group cannot prove escaped descendants exited", async (t) => {
  const rpc = new NativeRuntime();
  const store = new FusionRunStore();
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const ctx = new FakePi().createContext();
  await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, ctx);
  rpc.proof = { ...proof(), children: [{ ...processProof(), instances: [{ kind: "pi-writer", processTree: { state: "observed", mechanism: "posix-process-group", containment: "unverified" } }] }] };
  await orchestrator.cancelActiveRun(ctx);
  assert.equal(store.getActiveRun()?.cancellationRequested, true);
  assert.equal(store.getLastRunSummary(), undefined);
});

test("explicit dispatch refuses the current group-only ownership capability", async (t) => {
  const rpc = new NativeRuntime();
  rpc.ping = async () => ({ capabilities: { ...capabilities, processTreeOwnership: { version: 1, scope: "posix-process-group", escapedDescendants: "unverified" } } });
  const orchestrator = new FusionOrchestrator({ rpc, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const advertised = await orchestrator.executionCapabilities();
  assert.deepEqual(advertised.processTreeOwnership, { version: 1, scope: "posix-process-group", escapedDescendants: "unverified" });
  const result = await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, new FakePi().createContext());
  assert.equal(result.status, "failed");
  assert.equal(rpc.spawns.length, 0);
});

test("unchanged unbounded activity polls do not grow durable session history", async (t) => {
  const rpc = new NativeRuntime();
  const pi = new FakePi();
  const store = new FusionRunStore({ persistence: pi });
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, pi.createContext());
  await orchestrator.getStatusReport();
  const observations = pi.entries.length;
  await orchestrator.getStatusReport();
  assert.equal(pi.entries.length, observations);
});

test("native workflow stage does not accept a wrapper process proof", async (t) => {
  const rpc = new NativeRuntime();
  const store = new FusionRunStore();
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const ctx = new FakePi().createContext();
  await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, ctx);
  rpc.proof = { ...processProof(), runId: "native-panel" };
  await orchestrator.cancelActiveRun(ctx);
  assert.equal(store.getActiveRun()?.cancellationRequested, true);
  assert.equal(store.getLastRunSummary(), undefined);
});

test("cancellation arriving during native lookup prevents an absent-intent replay", async (t) => {
  const rpc = new NativeRuntime();
  rpc.loseReply = true;
  const store = new FusionRunStore();
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const ctx = new FakePi().createContext();
  await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, ctx);
  let resolveLookup: ((value: unknown) => void) | undefined;
  rpc.lookup = () => new Promise((resolve) => { resolveLookup = resolve; });
  const polling = orchestrator.getStatusReport();
  await orchestrator.cancelActiveRun(ctx);
  assert.ok(resolveLookup);
  resolveLookup({ ...rpc.identity, state: "absent" });
  await polling;
  assert.equal(rpc.spawns.length, 1);
  assert.equal(store.getActiveRun()?.cancellationRequested, true);
});

function rpcHarness(t: TestContext, cwd: string, rpc = new NativeRuntime()) {
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);
  const store = new FusionRunStore({ directory: join(cwd, "runs") });
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  const unregister = registerFusionRpc({ events: pi.events, orchestrator, store, getContext: () => ctx });
  const dispose = () => { unregister(); orchestrator.dispose(); };
  t.after(dispose);
  let next = 0;
  const request = (method: string, params: object): Promise<Record<string, unknown>> => new Promise((resolve) => {
    const requestId = `admission-${next++}`;
    const off = pi.events.on(fusionRpcReplyEvent(requestId), (value) => {
      assert.ok(typeof value === "object" && value !== null);
      off();
      resolve(value as Record<string, unknown>);
    });
    pi.events.emit(FUSION_RPC_REQUEST_EVENT, { version: 1, requestId, method, params });
  });
  return { request, rpc, store, orchestrator, dispose };
}

function responseData(reply: Record<string, unknown>): Record<string, unknown> {
  assert.equal(reply.success, true);
  assert.ok(typeof reply.data === "object" && reply.data !== null);
  return reply.data as Record<string, unknown>;
}

test("RPC cancellation before claim proves no launch across restart and delayed start", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "fusion-before-claim-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const first = rpcHarness(t, cwd);
  const selector = { operationId: "never-admitted" };
  assert.deepEqual(responseData(await first.request("status", selector)), { ...selector, state: "absent", replaySafe: true });
  const cancelled = responseData(await first.request("cancel", selector));
  assert.deepEqual(cancelled, { ...selector, cancelled: true, state: "cancelled", replaySafe: false, cancellationRequested: true, neverStarted: true });
  first.dispose();
  const restored = rpcHarness(t, cwd, first.rpc);
  const status = responseData(await restored.request("status", selector));
  assert.equal(status.neverStarted, true);
  assert.equal(status.operationId, selector.operationId);
  assert.equal(status.replaySafe, false);
  assert.equal((await restored.request("start", { ...selector, prompt: "Delayed", executionLifetime: lifetime, digest: "caller-digest" })).success, false);
  assert.equal(first.rpc.spawns.length, 0);
});

test("RPC cancellation after claim beats delayed native admission and retains caller digest", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "fusion-after-claim-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const rpc = new NativeRuntime();
  let resolvePing: ((value: unknown) => void) | undefined;
  rpc.ping = () => new Promise((resolve) => { resolvePing = resolve; });
  const first = rpcHarness(t, cwd, rpc);
  const input = { operationId: "claimed", prompt: "Delayed", executionLifetime: lifetime, digest: "caller-frozen-digest" };
  const starting = first.request("start", input);
  assert.ok(resolvePing);
  const beforeCancel = responseData(await first.request("status", { operationId: input.operationId }));
  assert.equal(beforeCancel.state, "pending");
  assert.equal(beforeCancel.replaySafe, false);
  const cancellation = responseData(await first.request("cancel", { operationId: input.operationId }));
  assert.equal(cancellation.neverStarted, true);
  assert.equal(cancellation.requestDigest, input.digest);
  assert.equal(typeof cancellation.fusionRequestDigest, "string");
  resolvePing({ capabilities });
  assert.equal((await starting).success, false);
  assert.equal(rpc.spawns.length, 0);
  first.dispose();
  const restored = rpcHarness(t, cwd, rpc);
  const status = responseData(await restored.request("status", { operationId: input.operationId }));
  assert.equal(status.neverStarted, true);
  assert.equal(status.requestDigest, input.digest);
  assert.equal((await restored.request("start", input)).success, false);
  assert.equal(rpc.spawns.length, 0);
});

test("RPC cancellation after native admission cannot claim never started", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "fusion-after-admission-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const rpc = new NativeRuntime();
  let resolveSpawn: (() => void) | undefined;
  let enteredSpawn: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enteredSpawn = resolve; });
  const actualSpawn = rpc.spawn.bind(rpc);
  rpc.spawn = async (params) => {
    const result = await actualSpawn(params);
    enteredSpawn?.();
    await new Promise<void>((resolve) => { resolveSpawn = resolve; });
    return result;
  };
  const first = rpcHarness(t, cwd, rpc);
  const input = { operationId: "native-admitted", prompt: "Delayed", executionLifetime: lifetime, digest: "caller-digest" };
  const starting = first.request("start", input);
  await entered;
  const cancel = responseData(await first.request("cancel", { operationId: input.operationId }));
  assert.notEqual(cancel.neverStarted, true);
  assert.equal(cancel.cancelled, false);
  assert.equal(first.store.getActiveRun()?.cancellationRequested, true);
  assert.ok(resolveSpawn);
  resolveSpawn();
  await starting;
  first.dispose();
  const restored = rpcHarness(t, cwd, rpc);
  const status = responseData(await restored.request("status", { operationId: input.operationId }));
  assert.notEqual(status.neverStarted, true);
  const journal = new FusionOperationJournal(join(cwd, ".pi", "fusion", "operations"));
  assert.equal(journal.lookup(input.operationId).neverStarted, false);
  assert.equal(rpc.spawns.length, 1);
});

test("RPC restart with admitted identity but no bound run stays unresolved", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "fusion-orphan-admission-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const journal = new FusionOperationJournal(join(cwd, ".pi", "fusion", "operations"));
  journal.claim("admitted", "internal-digest", "caller-digest");
  assert.equal(journal.beginDispatch("admitted", "internal-digest"), true);
  const restarted = rpcHarness(t, cwd);
  const evidence = responseData(await restarted.request("cancel", { operationId: "admitted" }));
  assert.equal(evidence.neverStarted, false);
  assert.equal(evidence.cancelled, false);
  assert.equal(evidence.requestDigest, "caller-digest");
  const status = responseData(await restarted.request("status", { operationId: "admitted" }));
  assert.equal(status.neverStarted, false);
  assert.equal(status.replaySafe, false);
  assert.equal(restarted.rpc.spawns.length, 0);
});
