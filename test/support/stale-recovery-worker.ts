import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FusionRunStore } from "../../src/run-store.js";
import { FusionOrchestrator, type FusionRpcClientLike } from "../../src/orchestrator.js";
import { FakePi } from "./fake-pi.js";
import { isRecord } from "../../src/utils.js";
import type { FusionConfig } from "../../src/types.js";

const [cwd, mode] = process.argv.slice(2);
assert.ok(cwd && mode);
const fixture: unknown = JSON.parse(readFileSync(join(cwd, "native-fixture.json"), "utf8"));
assert.ok(isRecord(fixture) && isRecord(fixture.panelLookup));
const panelLookup = fixture.panelLookup;
const store = new FusionRunStore({ directory: join(cwd, "runs") });
let waited = false;
let judge: Record<string, unknown> | undefined;
const barrier = async () => {
  waited = true;
  process.send?.({ waiting: mode });
  const deadline = Date.now() + 15_000;
  while (!existsSync(join(cwd, "release-stale"))) {
    if (Date.now() > deadline) throw new Error("Stale reply barrier timed out.");
    await delay(5);
  }
  if (mode === "lookup-refreshed") store.refreshDurable();
};
const rpc: FusionRpcClientLike = {
  async ping() { return { capabilities: fixture.capabilities }; },
  async lookup(params) {
    if (params.operationId === panelLookup.operationId) {
      if (!waited && mode.startsWith("lookup")) await barrier();
      if (!waited && mode === "spawn") return { state: "absent", operationId: params.operationId };
      return panelLookup;
    }
    const saved: unknown = judge ?? JSON.parse(readFileSync(join(cwd, "judge-launch.json"), "utf8"));
    assert.ok(isRecord(saved));
    return { ...saved, state: "found", runId: "native-judge", effectiveExecutionLifetime: { mode: "unbounded" }, effectiveExecutionOwnership: { mode: "kernel" }, executionRoute: "single-async", statusPayload: { runId: "native-judge", state: "running" } };
  },
  async spawn(params) {
    assert.ok(isRecord(params));
    if (params.operationId === panelLookup.operationId) {
      if (!waited && mode === "spawn") await barrier();
      return panelLookup;
    }
    judge = params;
    appendFileSync(join(cwd, "native-events.jsonl"), `${JSON.stringify({ method: "judge-spawn", params })}\n`);
    writeFileSync(join(cwd, "judge-launch.json"), JSON.stringify(params));
    return { ...params, runId: "native-judge", effectiveExecutionLifetime: { mode: "unbounded" }, effectiveExecutionOwnership: { mode: "kernel" }, executionRoute: "single-async" };
  },
  async cancel(params) {
    appendFileSync(join(cwd, "native-events.jsonl"), `${JSON.stringify({ method: "cancel", params })}\n`);
    return { cancellationRequested: true, ...params };
  },
  async status() { return { state: "running" }; },
  async stop(params) { appendFileSync(join(cwd, "native-events.jsonl"), `${JSON.stringify({ method: "stop", params })}\n`); return {}; },
  async interrupt() { return {}; },
};
const config: FusionConfig = { defaultProfile: "quality", profiles: { quality: { panel: [{ id: "one", agent: "panelist" }, { id: "two", agent: "panelist" }], judge: { agent: "judge" } } } };
const orchestrator = new FusionOrchestrator({ rpc, runStore: store, loadConfig: async () => config });
const ctx = new FakePi().createContext(cwd);
await orchestrator.restore(ctx);
await orchestrator.cancelActiveRun(ctx);
orchestrator.dispose();
process.disconnect?.();
