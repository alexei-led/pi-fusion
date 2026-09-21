import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DurableRunSnapshotStore } from "../../src/durable-run-store.js";
import { FusionRunStore } from "../../src/run-store.js";
import { FusionOrchestrator, type FusionRpcClientLike } from "../../src/orchestrator.js";
import { registerFusionRpc, FUSION_RPC_REQUEST_EVENT, fusionRpcReplyEvent } from "../../src/fusion-rpc.js";
import { FakePi } from "./fake-pi.js";
import type { FusionConfig } from "../../src/types.js";

const [cwd, operationId, mode, fault, capabilities] = process.argv.slice(2);
assert.ok(cwd && operationId && capabilities);
const directory = join(cwd, "runs");
const store = new FusionRunStore({ directory });
const publisher = new DurableRunSnapshotStore(directory);
const admit = publisher.admit.bind(publisher);
DurableRunSnapshotStore.prototype.admit = function (key, data, predecessor) {
  process.send?.({ ready: operationId });
  const deadline = Date.now() + 15_000;
  while (!existsSync(join(cwd, "release"))) {
    if (Date.now() > deadline) throw new Error("Admission barrier timed out.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  admit(key, data, predecessor);
  if (fault === "after-admission") process.exit(78);
};
const config: FusionConfig = { defaultProfile: "quality", profiles: { quality: { panel: [{ id: "one", agent: "panelist" }], judge: { agent: "judge" } } } };
const rpc: FusionRpcClientLike = {
  async ping() { return { capabilities: JSON.parse(capabilities) as unknown }; },
  async spawn(params) {
    assert.ok("operationId" in params && "digest" in params);
    appendFileSync(join(cwd, "launches.jsonl"), `${JSON.stringify(params)}\n`);
    return { operationId: params.operationId, digest: params.digest, runId: "native-panel", effectiveExecutionLifetime: { mode: "unbounded" }, effectiveExecutionOwnership: { mode: "kernel" }, executionRoute: "parallel-data" };
  },
  async lookup(params) { return { state: "absent", ...params }; },
  async cancel(params) { return { state: "cancelled", neverStarted: true, ...params }; },
  async status() { return { state: "running" }; },
  async stop() { return {}; },
  async interrupt() { return {}; },
};
const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
const pi = new FakePi();
const ctx = pi.createContext(cwd);
let response: unknown;
if (mode === "direct") response = await orchestrator.startRun({ prompt: "Concurrent", executionLifetime: { mode: "unbounded" } }, ctx);
else {
  const unregister = registerFusionRpc({ events: pi.events, orchestrator, store, getContext: () => ctx });
  response = await new Promise((resolve) => {
    pi.events.on(fusionRpcReplyEvent(operationId), resolve);
    pi.events.emit(FUSION_RPC_REQUEST_EVENT, { version: 1, requestId: operationId, method: "start", params: { operationId, prompt: "Concurrent", digest: `caller-${operationId}`, executionLifetime: { mode: "unbounded" } } });
  });
  unregister();
}
orchestrator.dispose();
writeFileSync(join(cwd, `${operationId}.result.json`), JSON.stringify(response));
process.disconnect?.();
