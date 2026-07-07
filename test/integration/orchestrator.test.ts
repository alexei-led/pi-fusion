import assert from "node:assert/strict";
import test from "node:test";
import {
  FusionOrchestrator,
  type FusionCommandContext,
  type FusionMessageSink,
  type FusionRpcClientLike,
} from "../../src/orchestrator.js";
import { FUSION_ACCEPTANCE_DISABLED } from "../../src/run-builder.js";
import { FusionRunStore } from "../../src/run-store.js";
import type { FusionConfig } from "../../src/types.js";

const CONFIG: FusionConfig = {
  defaultProfile: "quality",
  profiles: {
    quality: {
      panel: [
        { id: "architect", label: "Architect", agent: "panel-agent" },
        { id: "tester", label: "Tester", agent: "panel-agent" },
      ],
      judge: { agent: "judge-agent" },
      concurrency: 2,
      context: "fresh",
    },
  },
};

test("startRun pings subagents, starts a panel run, and publishes UI status", async () => {
  const fixture = makeFixture();

  const result = await fixture.orchestrator.startRun(
    "compare APIs",
    fixture.ctx,
  );

  assert.equal(result.status, "started");
  assert.equal(fixture.rpc.pings, 1);
  assert.equal(fixture.rpc.spawns.length, 1);
  const panelSpawn = fixture.rpc.spawns[0];
  assert.ok(isRecord(panelSpawn));
  const panelTasks = panelSpawn.tasks;
  assert.ok(Array.isArray(panelTasks));
  assert.deepEqual(panelSpawn["acceptance"], FUSION_ACCEPTANCE_DISABLED);
  assert.equal(panelTasks.length, 2);
  assert.ok(isRecord(panelTasks[0]));
  assert.deepEqual(panelTasks[0]["acceptance"], FUSION_ACCEPTANCE_DISABLED);
  assert.equal(fixture.orchestrator.getActiveRun()?.panelRunId, "panel-1");
  assert.match(fixture.ui.lastStatus("fusion") ?? "", /panel-1/);
});

test("startRun rejects an active-run conflict without spawning another panel", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("first", fixture.ctx);

  const result = await fixture.orchestrator.startRun("second", fixture.ctx);

  assert.equal(result.status, "conflict");
  assert.equal(fixture.rpc.spawns.length, 1);
  assert.match(
    fixture.ui.notifications.at(-1)?.message ?? "",
    /already active/,
  );
});

test("showStatus reports active run IDs, progress counts, and warnings", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("panel-1", {
    runId: "panel-1",
    details: {
      progress: [{ status: "completed" }, { status: "running" }],
    },
  });

  const report = await fixture.orchestrator.showStatus(fixture.ctx);

  assert.match(report, /State: active/);
  assert.match(report, /Panel run: panel-1/);
  assert.match(report, /Progress: 1\/2 done, 1 running, 0 failed/);
  assert.match(report, /Warnings: none/);
  assert.equal(fixture.messages.at(-1)?.customType, "fusion-status");
});

test("panel completion with zero successful panelists fails with a clear report", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("panel-1", {
    runId: "panel-1",
    results: [
      { agent: "panel-agent", success: false, error: "boom" },
      { agent: "panel-agent", success: false, summary: "timed out" },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "panel-1",
  });

  assert.equal(result.status, "failed");
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.equal(fixture.rpc.spawns.length, 1);
  assert.match(
    fixture.messages.at(-1)?.content ?? "",
    /No panelists completed successfully/,
  );
  assert.equal(fixture.ui.lastStatus("fusion"), undefined);
});

test("panel completion with one success skips judge and completes the run", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("panel-1", {
    runId: "panel-1",
    results: [
      { agent: "panel-agent", success: true, output: "Choose A." },
      { agent: "panel-agent", success: false, error: "boom" },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "panel-1",
  });

  assert.equal(result.status, "done");
  assert.equal(fixture.rpc.spawns.length, 1);
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.match(
    fixture.messages.at(-1)?.content ?? "",
    /skipped the judge step/,
  );
  assert.match(fixture.messages.at(-1)?.content ?? "", /Choose A/);
});

test("panel completion with multiple successes spawns and stores a judge run", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  fixture.rpc.statusResults.set("panel-1", successfulPanelStatus());

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "panel-1",
  });

  assert.equal(result.status, "started");
  assert.equal(fixture.rpc.spawns.length, 2);
  assert.equal(fixture.rpc.spawns[1]?.agent, "judge-agent");
  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "judge");
  assert.equal(fixture.orchestrator.getActiveRun()?.judgeRunId, "judge-1");
});

test("panel completion uses event results when RPC status has no result details", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  fixture.rpc.statusResults.set(
    "panel-1",
    completedStatusWithoutResults("panel-1"),
  );

  const result = await fixture.orchestrator.handleSubagentComplete(
    successfulPanelStatus(),
  );

  assert.equal(result.status, "started");
  assert.equal(fixture.rpc.spawns.length, 2);
  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "judge");
  assert.equal(fixture.orchestrator.getActiveRun()?.judgeRunId, "judge-1");
});

test("judge completion uses event output when RPC status has no result details", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  fixture.rpc.statusResults.set("panel-1", successfulPanelStatus());
  await fixture.orchestrator.handleSubagentComplete({ runId: "panel-1" });
  fixture.rpc.statusResults.set(
    "judge-1",
    completedStatusWithoutResults("judge-1"),
  );

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "judge-1",
    results: [
      {
        agent: "judge-agent",
        success: true,
        output: "# Fusion Report\n\n## Summary\nUse event output.",
      },
    ],
  });

  assert.equal(result.status, "done");
  assert.match(fixture.messages.at(-1)?.content ?? "", /Use event output/);
});

test("judge completion renders the final judge report and clears active UI", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  fixture.rpc.statusResults.set("panel-1", successfulPanelStatus());
  await fixture.orchestrator.handleSubagentComplete({ runId: "panel-1" });
  fixture.rpc.statusResults.set("judge-1", {
    runId: "judge-1",
    results: [
      {
        agent: "judge-agent",
        success: true,
        output: "# Fusion Report\n\n## Summary\nUse A.",
      },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "judge-1",
  });

  assert.equal(result.status, "done");
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.match(fixture.messages.at(-1)?.content ?? "", /Use A/);
  assert.equal(fixture.ui.lastStatus("fusion"), undefined);
});

test("cancelActiveRun stops the active run and falls back to interrupt", async () => {
  const fixture = makeFixture();
  fixture.rpc.stopError = new Error("stop unsupported");
  await fixture.orchestrator.startRun("compare", fixture.ctx);

  const result = await fixture.orchestrator.cancelActiveRun(fixture.ctx);

  assert.equal(result.status, "cancelled");
  assert.deepEqual(fixture.rpc.stops, [{ id: "panel-1" }]);
  assert.deepEqual(fixture.rpc.interrupts, [{ id: "panel-1" }]);
  assert.match(
    fixture.messages.at(-1)?.content ?? "",
    /Cancellation method: interrupt/,
  );
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
});

test("clearUi clears the fusion status key", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);

  fixture.orchestrator.clearUi();

  assert.equal(fixture.ui.lastStatus("fusion"), undefined);
});

function successfulPanelStatus(): unknown {
  return {
    runId: "panel-1",
    results: [
      { agent: "panel-agent", success: true, output: "Architect says A." },
      {
        agent: "panel-agent",
        success: true,
        output: "Tester says A is testable.",
      },
    ],
  };
}

function completedStatusWithoutResults(runId: string): unknown {
  return {
    text: `Run: ${runId}\nState: complete`,
    details: { mode: "single", results: [] },
  };
}

function makeFixture(): {
  orchestrator: FusionOrchestrator;
  rpc: FakeRpc;
  ui: FakeUi;
  ctx: FusionCommandContext;
  messages: Array<Parameters<FusionMessageSink["sendMessage"]>[0]>;
} {
  const rpc = new FakeRpc();
  const ui = new FakeUi();
  const ctx: FusionCommandContext = {
    cwd: "/project",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getEntries: () => [] },
    ui,
  };
  const messages: Array<Parameters<FusionMessageSink["sendMessage"]>[0]> = [];
  const orchestrator = new FusionOrchestrator({
    rpc,
    runStore: new FusionRunStore({ idFactory: () => "fusion-1", now: () => 1 }),
    sendMessage: (message) => messages.push(message),
    loadConfig: async () => CONFIG,
  });
  return { orchestrator, rpc, ui, ctx, messages };
}

class FakeRpc implements FusionRpcClientLike {
  pings = 0;
  readonly spawns: Array<Record<string, unknown>> = [];
  readonly statuses: Array<unknown> = [];
  readonly stops: Array<unknown> = [];
  readonly interrupts: Array<unknown> = [];
  readonly spawnResults: unknown[] = [{ details: { runId: "panel-1" } }];
  readonly statusResults = new Map<string, unknown>();
  stopError: Error | undefined;
  interruptError: Error | undefined;

  async ping(): Promise<unknown> {
    this.pings++;
    return { ok: true };
  }

  async spawn(params: object): Promise<unknown> {
    assert.ok(isRecord(params));
    this.spawns.push(params);
    const result = this.spawnResults.shift();
    if (result instanceof Error) throw result;
    return result ?? { details: { runId: `run-${this.spawns.length}` } };
  }

  async status(params = {}): Promise<unknown> {
    this.statuses.push(params);
    const id =
      isRecord(params) && typeof params.id === "string" ? params.id : undefined;
    const result = id ? this.statusResults.get(id) : undefined;
    if (result instanceof Error) throw result;
    return result ?? { runId: id, results: [] };
  }

  async stop(params: object): Promise<unknown> {
    this.stops.push(params);
    if (this.stopError) throw this.stopError;
    return { ok: true };
  }

  async interrupt(params: object): Promise<unknown> {
    this.interrupts.push(params);
    if (this.interruptError) throw this.interruptError;
    return { ok: true };
  }
}

class FakeUi {
  readonly statuses: Array<{ key: string; text: string | undefined }> = [];
  readonly notifications: Array<{ message: string; type: string | undefined }> =
    [];

  setStatus(key: string, text: string | undefined): void {
    this.statuses.push({ key, text });
  }

  notify(message: string, type?: string): void {
    this.notifications.push({ message, type });
  }

  lastStatus(key: string): string | undefined {
    return this.statuses.findLast((entry) => entry.key === key)?.text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
