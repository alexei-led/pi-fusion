import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { registerFusionRpc, FUSION_RPC_REQUEST_EVENT, fusionRpcReplyEvent } from "../../src/fusion-rpc.js";
import { FusionOperationJournal } from "../../src/operation-journal.js";
import { requestDigest } from "../../src/runtime-contract.js";
import { FusionOrchestrator, type FusionRpcClientLike } from "../../src/orchestrator.js";
import { FusionRunStore } from "../../src/run-store.js";
import type { FusionConfig } from "../../src/types.js";
import { FakePi } from "../support/fake-pi.js";

const capabilities = {
  executionLifetime: { version: 1, modes: ["unbounded", "bounded"] },
  durableOperations: { version: 1, lookup: true, replay: true, cancelFence: true },
  processTerminalProof: { version: 1 },
  workflowTerminalProof: { version: 1 },
  processTreeOwnership: { version: 1, scope: "owned-process-tree", escapedDescendants: "contained", requestMode: "kernel", routes: ["single-async", "parallel-data"] },
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
  route = "parallel-data";
  runId = "native-panel";
  async ping(): Promise<unknown> { return { capabilities }; }
  async spawn(params: object): Promise<unknown> {
    this.spawns.push(params);
    assert.ok("operationId" in params && "digest" in params);
    this.identity = { operationId: params.operationId, digest: params.digest };
    this.route = "ownedWorkflow" in params ? "parallel-data" : "single-async";
    this.runId = this.route === "parallel-data" ? "native-panel" : "native-judge";
    if (this.loseReply) throw new Error("spawn reply lost");
    return { ...this.identity, runId: this.runId, effectiveExecutionLifetime: lifetime, effectiveExecutionOwnership: { mode: "kernel" }, executionRoute: this.route };
  }
  async lookup(): Promise<unknown> {
    return { ...this.identity, state: "found", runId: this.runId, effectiveExecutionLifetime: lifetime, effectiveExecutionOwnership: { mode: "kernel" }, executionRoute: this.route, statusPayload: this.payload() };
  }
  async cancel(): Promise<unknown> { this.cancelled = true; return { cancellationRequested: true }; }
  async status(): Promise<unknown> { return this.payload(); }
  async stop(): Promise<unknown> { return { ok: true }; }
  async interrupt(): Promise<unknown> { return { ok: true }; }
  payload(): unknown {
    return { runId: this.runId, state: this.statusValue, ...(this.proof ? { processTerminalProof: this.proof } : {}), results: [{ agent: "panelist", output: "Answer", success: true }] };
  }
}

function proof(rpc: NativeRuntime) {
  assert.ok(rpc.identity);
  const binding = { operationId: `kernel:${String(rpc.identity.operationId)}`, requestDigest: `kernel:${String(rpc.identity.digest)}`, hostId: "11111111-2222-3333-4444-555555555555", bootId: "66666666-7777-8888-9999-aaaaaaaaaaaa" };
  const identity = { version: 1, backend: "darwin-resource-coalition-v1", ...binding, coalitionId: rpc.route === "parallel-data" ? "123" : "124", leader: { pid: 1234, uniqueId: rpc.route === "parallel-data" ? "123456" : "123457", pidVersion: 0 } };
  return {
    version: 1, state: "observed", runId: rpc.runId, runnerProcessInstanceId: "native-instance", observedAt: 1,
    processTreeOwnership: capabilities.processTreeOwnership,
    nativeOperation: rpc.identity,
    kernelBinding: binding,
    kernelProof: { status: "retired", binding, identity, proof: { kind: "darwin-coalition-retired", ...binding, identity, observedAt: "2026-09-21T00:00:00.000Z" } },
  };
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
  rpc.proof = { ...proof(rpc), runId: "other-run" };
  await orchestrator.getStatusReport();
  assert.equal(store.getActiveRun()?.phase, "panel");
  rpc.proof = proof(rpc);
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
  rpc.proof = proof(rpc);
  await restored.getStatusReport();
  assert.equal(store.getLastRunSummary()?.phase, "cancelled");
  assert.equal(rpc.spawns.length, 1);
});

test("owned root requires kernel retirement even when a workflow claims closed dispatch", async (t) => {
  const rpc = new NativeRuntime();
  const store = new FusionRunStore();
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const ctx = new FakePi().createContext();
  await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, ctx);
  await orchestrator.cancelActiveRun(ctx);
  const workflow = { version: 1, kind: "workflow", state: "observed", runId: "native-panel", dispatchClosed: false, observedAt: 2, children: [proof(rpc)] };
  rpc.proof = workflow;
  await orchestrator.getStatusReport();
  assert.ok(store.getActiveRun());
  rpc.proof = { ...workflow, dispatchClosed: true, children: [{ ...proof(rpc), state: "pending" }] };
  await orchestrator.getStatusReport();
  assert.ok(store.getActiveRun());
  rpc.proof = { ...workflow, dispatchClosed: true };
  await orchestrator.getStatusReport();
  assert.ok(store.getActiveRun());
  rpc.proof = proof(rpc);
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
  rpc.proof = proof(rpc);
  await request("cancel", { operationId: input.operationId });
  assert.equal((await request("start", busyInput)).success, true);
  assert.equal(rpc.spawns.length, 2);
});

test("closed panel proof cannot acknowledge cancellation of an unresolved judge launch", async (t) => {
  const rpc = new NativeRuntime();
  rpc.proof = { ...processProof(), runId: "native-panel" };
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
  rpc.proof = { ...processProof(), runId: "native-panel", instances: [{ kind: "pi-writer", processTree: { state: "observed", mechanism: "posix-process-group", containment: "unverified" } }] };
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

function rpcHarness(t: TestContext, cwd: string, rpc = new NativeRuntime(), configuration = config) {
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);
  const store = new FusionRunStore({ directory: join(cwd, "runs") });
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => configuration });
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

test("strict Fusion refuses ownership without both native data routes", async (t) => {
  const rpc = new NativeRuntime();
  rpc.ping = async () => ({ capabilities: { ...capabilities, processTreeOwnership: { version: 1, scope: "owned-process-tree", escapedDescendants: "contained", requestMode: "kernel", routes: ["single-async"] } } });
  const store = new FusionRunStore();
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const result = await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, new FakePi().createContext());
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /parallel-data/);
  assert.equal(rpc.spawns.length, 0);
  assert.equal(store.getActiveRun(), undefined);
});

test("strict agreement policy refusal happens before admission while service lookup remains available", async (t) => {
  const rpc = new NativeRuntime();
  const store = new FusionRunStore();
  const agreement: FusionConfig = { defaultProfile: "quality", profiles: { quality: { ...config.profiles.quality!, stopWhenPanelAgrees: true } } };
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => agreement });
  t.after(() => orchestrator.dispose());
  const result = await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, new FakePi().createContext());
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /stopWhenPanelAgrees/);
  assert.equal(rpc.spawns.length, 0);
  assert.equal(store.getActiveRun(), undefined);
  assert.ok((await orchestrator.executionCapabilities()).executionLifetime);
});

test("native ownership route downgrade remains an unresolved launch", async (t) => {
  const rpc = new NativeRuntime();
  const originalSpawn = rpc.spawn.bind(rpc);
  rpc.spawn = async (params) => {
    await originalSpawn(params);
    return { ...rpc.identity, runId: "native-panel", effectiveExecutionLifetime: lifetime, effectiveExecutionOwnership: { mode: "kernel" }, executionRoute: "single-async" };
  };
  rpc.lookup = async () => ({ ...rpc.identity, state: "found", runId: "native-panel", effectiveExecutionLifetime: lifetime, effectiveExecutionOwnership: { mode: "kernel" }, executionRoute: "single-async" });
  const store = new FusionRunStore();
  const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
  t.after(() => orchestrator.dispose());
  const result = await orchestrator.startRun({ prompt: "Review", executionLifetime: lifetime }, new FakePi().createContext());
  assert.equal(result.status, "started");
  assert.equal(store.getActiveRun()?.panelRunId, undefined);
  assert.equal(store.getActiveRun()?.effectiveExecutionLifetime, undefined);
  await orchestrator.getStatusReport();
  assert.equal(store.getActiveRun()?.panelRunId, undefined);
  assert.equal(rpc.spawns.length, 1);
  assert.ok(rpc.spawns[0] && "ownedWorkflow" in rpc.spawns[0]);
  assert.equal("workflowScript" in rpc.spawns[0], false);
});

test("owned panel and direct judge close under separate native identities bound to one caller", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "fusion-owned-stages-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const panelConfig: FusionConfig = { defaultProfile: "quality", profiles: { quality: { panel: [{ id: "one", agent: "panelist" }, { id: "two", agent: "panelist" }], judge: { agent: "judge" }, concurrency: 2 } } };
  class StageRuntime extends NativeRuntime {
    override async spawn(params: object): Promise<unknown> {
      const result = await super.spawn(params);
      this.statusValue = "running";
      this.proof = undefined;
      return result;
    }
    override payload(): unknown {
      return {
        runId: this.runId, state: this.statusValue,
        ...(this.proof ? { processTerminalProof: this.proof } : {}),
        results: this.route === "parallel-data"
          ? [{ agent: "panelist", workflowKey: "panel-1", output: "NO_FINDINGS", success: true }, { agent: "panelist", workflowKey: "panel-2", output: "NO_FINDINGS", success: true }]
          : [{ agent: "judge", output: "NO_FINDINGS", success: true }],
      };
    }
  }
  const rpc = new StageRuntime();
  const fixture = rpcHarness(t, cwd, rpc, panelConfig);
  const input = { operationId: "caller-operation", digest: "caller-frozen-digest", prompt: "Review", outputContract: "plan-review-v1", executionLifetime: lifetime };
  const started = responseData(await fixture.request("start", input));
  assert.deepEqual(started.effectiveExecutionOwnership, { mode: "kernel" });
  assert.equal(started.executionRoute, "parallel-data");
  rpc.statusValue = "completed";
  rpc.proof = proof(rpc);
  await fixture.orchestrator.getStatusReport();
  assert.equal(fixture.store.getActiveRun()?.phase, "judge");
  assert.equal(rpc.spawns.length, 2);
  assert.ok(rpc.spawns[0] && "ownedWorkflow" in rpc.spawns[0]);
  assert.ok(rpc.spawns[1] && "agent" in rpc.spawns[1]);
  assert.equal("workflowScript" in rpc.spawns[0], false);
  assert.equal("workflowScript" in rpc.spawns[1], false);
  rpc.statusValue = "completed";
  const retired = proof(rpc);
  rpc.proof = { ...retired, kernelProof: { ...retired.kernelProof, status: "active" } };
  await fixture.orchestrator.getStatusReport();
  assert.equal(fixture.store.getActiveRun()?.phase, "judge");
  rpc.proof = retired;
  await fixture.orchestrator.getStatusReport();
  const completed = responseData(await fixture.request("result", { operationId: input.operationId }));
  assert.deepEqual(completed.callerOutput, { contract: "plan-review-v1", output: "NO_FINDINGS" });
  const closure = completed.workflowTerminalProof;
  assert.ok(typeof closure === "object" && closure !== null && "callerBinding" in closure && "children" in closure);
  assert.deepEqual(closure.callerBinding, { operationId: input.operationId, requestDigest: input.digest });
  assert.ok(Array.isArray(closure.children));
  assert.equal(closure.children.length, 2);
  const children: unknown[] = closure.children;
  for (const child of children) {
    assert.ok(typeof child === "object" && child !== null && "nativeOperation" in child && "kernelBinding" in child);
    assert.notDeepEqual(child.nativeOperation, closure.callerBinding);
    assert.notDeepEqual(child.kernelBinding, closure.callerBinding);
  }
});

function fixtureGit(args: string[]): string {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith("GIT_")) delete environment[name];
  return execFileSync("git", args, { encoding: "utf8", env: environment }).trim();
}

async function candidateRepositories(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "fusion-candidate-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionCwd = join(root, "session-a");
  const candidateCwd = join(root, "candidate-b");
  for (const [cwd, label] of [[sessionCwd, "session"], [candidateCwd, "candidate"]]) {
    assert.ok(cwd && label);
    await mkdir(cwd);
    fixtureGit(["init", "--quiet", cwd]);
    await writeFile(join(cwd, "marker.txt"), label);
    fixtureGit(["-C", cwd, "add", "marker.txt"]);
    fixtureGit(["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", label]);
  }
  const head = (cwd: string) => fixtureGit(["-C", cwd, "rev-parse", "HEAD"]);
  return { sessionCwd, candidateCwd, sessionCommit: head(sessionCwd), reviewedCommit: head(candidateCwd) };
}

test("candidate context uses repository B for panel and restored judge while Pi stays in A", async (t) => {
  const candidate = await candidateRepositories(t);
  const panelConfig: FusionConfig = { defaultProfile: "quality", profiles: { quality: { panel: [{ id: "one", agent: "panelist" }, { id: "two", agent: "panelist" }], judge: { agent: "judge" }, concurrency: 2 } } };
  class CandidateRuntime extends NativeRuntime {
    override async spawn(params: object): Promise<unknown> {
      const result = await super.spawn(params);
      this.statusValue = "running";
      this.proof = undefined;
      return result;
    }
    override payload(): unknown {
      return { runId: this.runId, state: this.statusValue, ...(this.proof ? { processTerminalProof: this.proof } : {}), results: this.route === "parallel-data"
        ? [{ agent: "panelist", output: "First", success: true }, { agent: "panelist", output: "Second", success: true }]
        : [{ agent: "judge", output: "# Fusion Report\n\n## Summary\nReviewed candidate.", success: true }] };
    }
  }
  const rpc = new CandidateRuntime();
  const first = rpcHarness(t, candidate.sessionCwd, rpc, panelConfig);
  const context = { cwd: candidate.candidateCwd, reviewedCommit: candidate.reviewedCommit };
  const input = { operationId: "candidate-review", digest: "caller-candidate-digest", prompt: "Review", executionLifetime: lifetime, ...context };
  assert.equal((await first.request("start", input)).success, true);
  assert.deepEqual(first.store.getActiveRun()?.reviewContext, context);
  const panelSpawn = rpc.spawns[0];
  assert.ok(panelSpawn && "cwd" in panelSpawn && "operationId" in panelSpawn && "digest" in panelSpawn);
  assert.equal(panelSpawn.cwd, candidate.candidateCwd);
  const { operationId, digest, ...params } = panelSpawn;
  assert.equal(operationId, first.store.getActiveRun()?.spawnIntent?.requestId);
  assert.equal(digest, requestDigest({ params, reviewContext: context }));
  assert.equal((await first.request("start", { ...input, cwd: candidate.sessionCwd, reviewedCommit: candidate.sessionCommit })).success, false);
  assert.equal(rpc.spawns.length, 1);
  first.dispose();
  const restored = rpcHarness(t, candidate.sessionCwd, rpc, panelConfig);
  rpc.statusValue = "completed";
  rpc.proof = proof(rpc);
  await restored.orchestrator.restore(new FakePi().createContext(candidate.sessionCwd));
  assert.equal(restored.store.getActiveRun()?.phase, "judge");
  assert.deepEqual(restored.store.getActiveRun()?.reviewContext, context);
  const judgeSpawn = rpc.spawns[1];
  assert.ok(judgeSpawn && "cwd" in judgeSpawn && "agent" in judgeSpawn);
  assert.equal(judgeSpawn.cwd, candidate.candidateCwd);
  assert.equal(judgeSpawn.agent, "judge");
  rpc.statusValue = "completed";
  rpc.proof = proof(rpc);
  await restored.orchestrator.getStatusReport();
  assert.equal(restored.store.getLastRunSummary()?.phase, "done");
  assert.deepEqual(new FusionRunStore({ directory: join(candidate.sessionCwd, "runs") }).getRunByOperationId(input.operationId)?.reviewContext, context);
});

test("candidate HEAD mismatch rejects before native admission and leaves cancellation available", async (t) => {
  const candidate = await candidateRepositories(t);
  const fixture = rpcHarness(t, candidate.sessionCwd);
  const operationId = "mismatched-candidate";
  const response = await fixture.request("start", { operationId, digest: "caller-digest", prompt: "Review", executionLifetime: lifetime, cwd: candidate.candidateCwd, reviewedCommit: candidate.sessionCommit });
  assert.equal(response.success, false);
  assert.match(JSON.stringify(response), /does not match reviewedCommit/);
  assert.equal(fixture.rpc.spawns.length, 0);
  assert.equal(fixture.store.getActiveRun(), undefined);
  assert.deepEqual(responseData(await fixture.request("status", { operationId })), { operationId, state: "absent", replaySafe: true });
  assert.equal(responseData(await fixture.request("cancel", { operationId })).neverStarted, true);
});

test("candidate HEAD drift cannot produce an accepted report and does not prevent cancellation", async (t) => {
  const candidate = await candidateRepositories(t);
  const fixture = rpcHarness(t, candidate.sessionCwd);
  await fixture.request("start", { operationId: "drifting-candidate", digest: "caller-digest", prompt: "Review", executionLifetime: lifetime, cwd: candidate.candidateCwd, reviewedCommit: candidate.reviewedCommit });
  fixtureGit(["-C", candidate.candidateCwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "changed candidate"]);
  fixture.rpc.statusValue = "completed";
  fixture.rpc.proof = proof(fixture.rpc);
  await assert.rejects(fixture.orchestrator.getStatusReport(), /does not match reviewedCommit/);
  assert.equal(fixture.store.getActiveRun()?.phase, "panel");
  assert.equal(fixture.store.getLastRunSummary(), undefined);
  assert.equal(fixture.rpc.spawns.length, 1);
  const cancelled = responseData(await fixture.request("cancel", { operationId: "drifting-candidate" }));
  assert.equal(cancelled.cancelled, true);
  assert.equal(fixture.store.getLastRunSummary()?.phase, "cancelled");
});

test("review context requires a complete absolute directory and immutable commit pair", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "fusion-context-validation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const fixture = rpcHarness(t, cwd);
  for (const [index, context] of [
    { cwd },
    { reviewedCommit: "a".repeat(40) },
    { cwd: "relative", reviewedCommit: "a".repeat(40) },
    { cwd, reviewedCommit: "HEAD" },
  ].entries()) {
    const response = await fixture.request("start", { operationId: `invalid-context-${index}`, prompt: "Review", executionLifetime: lifetime, digest: "caller-digest", ...context });
    assert.equal(response.success, false);
    assert.match(JSON.stringify(response), /invalid_request/);
  }
  assert.equal(fixture.rpc.spawns.length, 0);
});

test("lost-launch replay retains candidate context and native digest after restart", async (t) => {
  const candidate = await candidateRepositories(t);
  const rpc = new NativeRuntime();
  rpc.loseReply = true;
  const first = rpcHarness(t, candidate.sessionCwd, rpc);
  const input = { operationId: "candidate-replay", digest: "caller-digest", prompt: "Review", executionLifetime: lifetime, cwd: candidate.candidateCwd, reviewedCommit: candidate.reviewedCommit };
  assert.equal((await first.request("start", input)).success, true);
  const original = rpc.spawns[0];
  assert.ok(original);
  first.dispose();
  rpc.loseReply = false;
  rpc.lookup = async () => ({ operationId: rpc.identity?.operationId, state: "absent" });
  const restored = rpcHarness(t, candidate.sessionCwd, rpc);
  await restored.orchestrator.restore(new FakePi().createContext(candidate.sessionCwd));
  assert.equal(rpc.spawns.length, 2);
  assert.deepEqual(rpc.spawns[1], original);
  assert.deepEqual(restored.store.getActiveRun()?.reviewContext, { cwd: candidate.candidateCwd, reviewedCommit: candidate.reviewedCommit });
  assert.equal(restored.store.getActiveRun()?.panelRunId, "native-panel");
});

test("candidate verification cannot be redirected by inherited Git repository variables", async (t) => {
  const candidate = await candidateRepositories(t);
  const fixture = rpcHarness(t, candidate.sessionCwd);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(candidate.sessionCwd, ".git");
  try {
    const response = await fixture.request("start", { operationId: "git-environment-candidate", digest: "caller-digest", prompt: "Review", executionLifetime: lifetime, cwd: candidate.candidateCwd, reviewedCommit: candidate.sessionCommit });
    assert.equal(response.success, false);
    assert.match(JSON.stringify(response), /does not match reviewedCommit/);
    assert.equal(fixture.rpc.spawns.length, 0);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test("fixture Git commands isolate inherited hook selectors from a disposable sentinel repository", async (t) => {
  const sentinel = await candidateRepositories(t);
  const sentinelGitDir = join(sentinel.sessionCwd, ".git");
  const beforeHead = fixtureGit(["-C", sentinel.sessionCwd, "rev-parse", "HEAD"]);
  const beforeRefs = fixtureGit(["-C", sentinel.sessionCwd, "show-ref", "--heads"]);
  const beforeConfig = await readFile(join(sentinelGitDir, "config"));
  const beforeIndex = await readFile(join(sentinelGitDir, "index"));
  const originalGitEnvironment = Object.entries(process.env).filter(([name]) => name.startsWith("GIT_"));
  const injected = {
    GIT_DIR: sentinelGitDir,
    GIT_WORK_TREE: sentinel.sessionCwd,
    GIT_COMMON_DIR: sentinelGitDir,
    GIT_INDEX_FILE: join(sentinelGitDir, "index"),
    GIT_OBJECT_DIRECTORY: join(sentinelGitDir, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(sentinelGitDir, "objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_PARAMETERS: "'core.bare=true'",
  };
  Object.assign(process.env, injected);
  try {
    const isolated = await candidateRepositories(t);
    assert.notEqual(isolated.sessionCommit, isolated.reviewedCommit);
    assert.equal(fixtureGit(["-C", sentinel.sessionCwd, "rev-parse", "HEAD"]), beforeHead);
    assert.equal(fixtureGit(["-C", sentinel.sessionCwd, "show-ref", "--heads"]), beforeRefs);
    assert.deepEqual(await readFile(join(sentinelGitDir, "config")), beforeConfig);
    assert.deepEqual(await readFile(join(sentinelGitDir, "index")), beforeIndex);
    assert.equal(fixtureGit(["-C", sentinel.sessionCwd, "status", "--short"]), "");
  } finally {
    for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
    for (const [name, value] of originalGitEnvironment) if (value !== undefined) process.env[name] = value;
  }
});
