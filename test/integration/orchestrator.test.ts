import assert from "node:assert/strict";
import test from "node:test";
import {
  FusionOrchestrator,
  type FusionCommandContext,
  type FusionMessageSink,
  type FusionRpcClientLike,
} from "../../src/orchestrator.js";
import {
  buildPanelSpawnParams,
  FUSION_ACCEPTANCE_DISABLED,
} from "../../src/run-builder.js";
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
    fast: {
      panel: [
        { id: "architect", label: "Architect", agent: "panel-agent" },
        { id: "tester", label: "Tester", agent: "panel-agent" },
      ],
      judge: { agent: "judge-agent" },
      concurrency: 2,
      context: "fresh",
    },
    agreement: {
      panel: [
        { id: "architect", label: "Architect", agent: "panel-agent" },
        { id: "tester", label: "Tester", agent: "panel-agent" },
        { id: "skeptic", label: "Skeptic", agent: "panel-agent" },
      ],
      judge: { agent: "judge-agent" },
      concurrency: 3,
      context: "fresh",
      stopWhenPanelAgrees: true,
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
  const chainSpawn = fixture.rpc.spawns[0];
  assert.ok(isRecord(chainSpawn));
  assert.deepEqual(
    chainSpawn,
    buildPanelSpawnParams(CONFIG.profiles.quality!, "compare APIs"),
  );
  assert.deepEqual(chainSpawn["acceptance"], FUSION_ACCEPTANCE_DISABLED);
  assert.equal(fixture.orchestrator.getActiveRun()?.panelRunId, "chain-1");
  assert.match(fixture.ui.lastStatus("fusion") ?? "", /chain-1/);
});

test("startRun parses string arguments before launching a profile", async () => {
  const fixture = makeFixture();

  const result = await fixture.orchestrator.startRun(
    "--profile fast compare APIs",
    fixture.ctx,
  );

  assert.equal(result.status, "started");
  assert.equal(fixture.orchestrator.getActiveRun()?.profileName, "fast");
  assert.equal(fixture.orchestrator.getActiveRun()?.prompt, "compare APIs");
  assert.deepEqual(
    fixture.rpc.spawns[0],
    buildPanelSpawnParams(CONFIG.profiles.fast!, "compare APIs"),
  );
});

test("startRun preserves a synchronous subagent model error", async () => {
  const fixture = makeFixture();
  fixture.rpc.spawnResults[0] = {
    isError: true,
    content: [{ type: "text", text: "Error: Model not found gpt-5.6-luna" }],
    details: { results: [] },
  };

  const result = await fixture.orchestrator.startRun(
    "compare APIs",
    fixture.ctx,
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error, "Error: Model not found gpt-5.6-luna");
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.match(fixture.messages.at(-1)?.content ?? "", /Model not found/);
});

test("restore keeps legacy chain runs on the fallback judge path", async () => {
  const fixture = makeFixture();
  fixture.runStore.startRun({
    id: "fusion-1",
    prompt: "compare",
    profileName: "quality",
    phase: "chain",
  });
  fixture.runStore.updateRun("fusion-1", { chainRunId: "chain-1" });
  fixture.rpc.spawnResults[0] = { details: { runId: "judge-1" } };
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));

  await fixture.orchestrator.restore(fixture.ctx);

  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "judge");
  assert.equal(fixture.orchestrator.getActiveRun()?.judgeRunId, "judge-1");
});

test("concurrent starts return one started run and one conflict", async () => {
  const fixture = makeFixture();
  let resolvePing!: (value: unknown) => void;
  fixture.rpc.pingPromise = new Promise((resolve) => {
    resolvePing = resolve;
  });

  const first = fixture.orchestrator.startRun("first", fixture.ctx);
  const second = fixture.orchestrator.startRun("second", fixture.ctx);
  resolvePing({ ok: true });

  const results = await Promise.all([first, second]);
  assert.equal(
    results.filter((result) => result.status === "started").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "conflict").length,
    1,
  );
  assert.equal(fixture.rpc.spawns.length, 1);
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
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    steps: [{ status: "completed" }, { status: "running" }],
  });

  const report = await fixture.orchestrator.showStatus(fixture.ctx);

  assert.match(report, /State: active/);
  assert.match(report, /Panel run: chain-1/);
  assert.match(report, /Progress: 1\/2 done, 1 running, 0 failed/);
  assert.match(report, /Warnings: none/);
  assert.equal(fixture.messages.at(-1)?.customType, "fusion-status");
});

test("chain completion with zero successful panelists fails with a clear report", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    state: "complete",
    results: [
      { agent: "panel-agent", success: false, error: "boom" },
      { agent: "panel-agent", success: false, summary: "timed out" },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
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
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    state: "complete",
    results: [
      { agent: "panel-agent", success: true, output: "Choose A." },
      { agent: "panel-agent", success: false, error: "boom" },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
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

test("panel completion starts a judge and judge completion finishes the run", async () => {
  const fixture = makeFixture();
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));

  const panelResult = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(panelResult.status, "started");
  assert.equal(fixture.rpc.spawns.length, 2);
  fixture.rpc.statusResults.set("judge-1", {
    runId: "judge-1",
    state: "complete",
    results: [
      {
        agent: "judge-agent",
        success: true,
        output: "# Fusion Report\\n\\n## Recommendation\\nUse A.",
      },
    ],
  });

  const judgeResult = await fixture.orchestrator.handleSubagentComplete({
    runId: "judge-1",
  });

  assert.equal(judgeResult.status, "done");
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.match(fixture.messages.at(-1)?.content ?? "", /Use A/);
});

test("panel completion without a judge result spawns a judge", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(result.status, "started");
  assert.equal(fixture.rpc.spawns.length, 2);
  assert.equal(fixture.rpc.spawns[1]?.agent, "judge-agent");
  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "judge");
  assert.equal(fixture.orchestrator.getActiveRun()?.judgeRunId, "judge-1");
  assert.deepEqual(
    fixture.orchestrator.getActiveRun()?.panelOutputs?.map((o) => o.output),
    ["Architect says A.", "Tester says A is testable."],
  );
  assert.deepEqual(fixture.orchestrator.getActiveRun()?.panelFailures, []);
});

test("judge spawn preserves a synchronous subagent model error", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.spawnResults.push({
    isError: true,
    content: [{ type: "text", text: "Error: Model not found gpt-5.6-luna" }],
    details: { results: [] },
  });
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "Error: Model not found gpt-5.6-luna");
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.match(fixture.messages.at(-1)?.content ?? "", /Model not found/);
});

test("panel completion uses event results when RPC status has no result details", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set(
    "chain-1",
    completedStatusWithoutResults("chain-1"),
  );

  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  const result = await fixture.orchestrator.handleSubagentComplete(
    successfulPanelStatus("chain-1"),
  );

  assert.equal(result.status, "started");
  assert.equal(fixture.rpc.spawns.length, 2);
  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "judge");
});

test("partial status results do not finish a running panel", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    state: "running",
    results: [
      { agent: "panel-agent", success: true, output: "Architect says A." },
    ],
  });

  await fixture.orchestrator.restore(fixture.ctx);

  assert.equal(fixture.rpc.spawns.length, 1);
  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "panel");
});

test("matching events with partial results do not finish a running panel", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
    state: "running",
    results: [
      { agent: "panel-agent", success: true, output: "Architect says A." },
    ],
  });

  assert.equal(result.status, "ignored");
  assert.equal(fixture.rpc.spawns.length, 1);
  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "panel");
});

test("terminal child failures finish a running panel without waiting for the deadline", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    state: "running",
    steps: [
      {
        agent: "panel-agent",
        status: "failed",
        error: "Error: Model not found gpt-5.6-luna",
      },
      {
        agent: "panel-agent",
        status: "failed",
        error: "Subagent timed out after 180000ms.",
      },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(result.status, "failed");
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.match(fixture.messages.at(-1)?.content ?? "", /Model not found/);
});

test("terminal subagent errors without child results preserve the provider error", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    state: "failed",
    error: "Error: Model not found gpt-5.6-luna",
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "Error: Model not found gpt-5.6-luna");
  assert.match(fixture.messages.at(-1)?.content ?? "", /Model not found/);
});

test("panel agreement stops unfinished work and still runs the judge", async () => {
  const fixture = makeFixture();
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  await fixture.orchestrator.startRun(
    "--profile agreement compare",
    fixture.ctx,
  );
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    state: "running",
    steps: [
      {
        agent: "panel-agent",
        status: "complete",
        recentOutput: panelDecisionOutput("Choose A"),
      },
      {
        agent: "panel-agent",
        status: "complete",
        recentOutput: panelDecisionOutput("choose A."),
      },
      { agent: "panel-agent", status: "running" },
    ],
  });

  const stopped = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(stopped.status, "started");
  assert.deepEqual(fixture.rpc.stops, [{ id: "chain-1" }]);
  assert.equal(
    fixture.orchestrator.getActiveRun()?.panelStopReason,
    "agreement",
  );
  await fixture.orchestrator.handleSubagentComplete({ runId: "chain-1" });
  assert.deepEqual(fixture.rpc.stops, [{ id: "chain-1" }]);

  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    state: "paused",
    results: [
      {
        agent: "panel-agent",
        success: true,
        structuredOutput: panelDecision("Choose A"),
      },
      {
        agent: "panel-agent",
        success: true,
        structuredOutput: panelDecision("choose A."),
      },
      {
        agent: "panel-agent",
        success: false,
        interrupted: true,
        error: "Stopped after agreement",
      },
    ],
  });

  const judgeStarted = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });
  assert.equal(judgeStarted.status, "started");
  assert.equal(fixture.orchestrator.getActiveRun()?.judgeRunId, "judge-1");
  assert.equal(
    fixture.orchestrator.getActiveRun()?.panelFailures?.[0]?.reason,
    "stopped-after-agreement",
  );

  fixture.rpc.statusResults.set("judge-1", {
    runId: "judge-1",
    state: "complete",
    results: [
      {
        agent: "judge-agent",
        success: true,
        output: "# Fusion Report\\n\\n## Recommendation\\nUse A.",
      },
    ],
  });
  const finished = await fixture.orchestrator.handleSubagentComplete({
    runId: "judge-1",
  });

  assert.equal(finished.status, "done");
  assert.match(
    fixture.messages.at(-1)?.content ?? "",
    /Panel stopped after strong agreement/,
  );
});

test("panel completion treats terminal status text as complete even when event payload has no results", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set(
    "chain-1",
    completedStatusWithoutResults("chain-1"),
  );

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(result.status, "failed");
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.match(
    fixture.messages.at(-1)?.content ?? "",
    /No panelists completed successfully/,
  );
});

test("judge completion treats terminal status text as complete even when event payload has no results", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));
  await fixture.orchestrator.handleSubagentComplete({ runId: "chain-1" });
  fixture.rpc.statusResults.set(
    "judge-1",
    completedStatusWithoutResults("judge-1"),
  );

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "judge-1",
  });

  assert.equal(result.status, "failed");
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.match(
    fixture.messages.at(-1)?.content ?? "",
    /Fusion judge completed without output/,
  );
});

test("judge completion uses event output when RPC status has no result details", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));
  await fixture.orchestrator.handleSubagentComplete({ runId: "chain-1" });
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
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));
  await fixture.orchestrator.handleSubagentComplete({ runId: "chain-1" });
  fixture.rpc.statusResults.set("judge-1", {
    runId: "judge-1",
    state: "complete",
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

test("completion output is replayed after concurrent status polling", async () => {
  const fixture = makeFixture();
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  await fixture.orchestrator.startRun("compare", fixture.ctx);

  let resolveStatus!: (value: unknown) => void;
  fixture.rpc.statusPromise = new Promise((resolve) => {
    resolveStatus = resolve;
  });
  const polling = fixture.orchestrator.getStatusReport();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const completion = fixture.orchestrator.handleSubagentComplete(
    successfulPanelStatus("chain-1"),
  );
  resolveStatus({ runId: "chain-1", state: "running", results: [] });
  await polling;
  await completion;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "judge");
  assert.equal(fixture.orchestrator.getActiveRun()?.judgeRunId, "judge-1");
});

test("cancelling while the judge spawns stops the orphaned judge", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));

  let resolveSpawn!: (value: unknown) => void;
  fixture.rpc.spawnPromise = new Promise((resolve) => {
    resolveSpawn = resolve;
  });
  const completing = fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const cancelled = await fixture.orchestrator.cancelActiveRun(fixture.ctx);
  assert.equal(cancelled.status, "cancelled");
  resolveSpawn({ details: { runId: "late-judge" } });
  assert.equal((await completing).status, "ignored");
  assert.deepEqual(fixture.rpc.stops, [
    { id: "chain-1" },
    { id: "late-judge" },
  ]);
});

test("cancelActiveRun does not throw when completion wins during stop", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);

  let resolveStop!: (value: unknown) => void;
  fixture.rpc.stopPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const cancelling = fixture.orchestrator.cancelActiveRun(fixture.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));

  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    state: "complete",
    results: [
      { agent: "panel-agent", success: true, output: "Choose A." },
      { agent: "panel-agent", success: false, error: "boom" },
    ],
  });
  assert.equal(
    (await fixture.orchestrator.handleSubagentComplete({ runId: "chain-1" }))
      .status,
    "done",
  );

  resolveStop({ ok: true });
  assert.equal((await cancelling).status, "ignored");
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
});

test("cancelActiveRun stops a panel that finishes spawning after local cancellation", async () => {
  const fixture = makeFixture();
  let resolveSpawn!: (value: unknown) => void;
  fixture.rpc.spawnPromise = new Promise((resolve) => {
    resolveSpawn = resolve;
  });

  const starting = fixture.orchestrator.startRun("compare", fixture.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancelled = await fixture.orchestrator.cancelActiveRun(fixture.ctx);
  assert.equal(cancelled.status, "cancelled");

  resolveSpawn({ details: { runId: "late-panel" } });
  const startResult = await starting;
  assert.equal(startResult.status, "cancelled");
  assert.deepEqual(fixture.rpc.stops, [{ id: "late-panel" }]);
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
});

test("cancelActiveRun stops the active run and falls back to interrupt", async () => {
  const fixture = makeFixture();
  fixture.rpc.stopError = new Error("stop unsupported");
  await fixture.orchestrator.startRun("compare", fixture.ctx);

  const result = await fixture.orchestrator.cancelActiveRun(fixture.ctx);

  assert.equal(result.status, "cancelled");
  assert.deepEqual(fixture.rpc.stops, [{ id: "chain-1" }]);
  assert.deepEqual(fixture.rpc.interrupts, [{ id: "chain-1" }]);
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

function successfulPanelStatus(runId = "panel-1"): unknown {
  return {
    runId,
    state: "complete",
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

function panelDecisionOutput(recommendation: string): string[] {
  return [
    "## Recommendation",
    recommendation,
    `<fusion-panel-decision>${JSON.stringify({
      recommendation,
      confidence: "high",
      needsMoreEvidence: false,
    })}</fusion-panel-decision>`,
  ];
}

function panelDecision(recommendation: string): Record<string, unknown> {
  return {
    recommendation,
    confidence: "high",
    needsMoreEvidence: false,
    answerMarkdown: `## Recommendation\\n${recommendation}`,
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
  runStore: FusionRunStore;
  entries: Array<{ type: "custom"; customType: string; data?: unknown }>;
  rpc: FakeRpc;
  ui: FakeUi;
  ctx: FusionCommandContext;
  messages: Array<Parameters<FusionMessageSink["sendMessage"]>[0]>;
} {
  const rpc = new FakeRpc();
  const ui = new FakeUi();
  const entries: Array<{ type: "custom"; customType: string; data?: unknown }> =
    [];
  const ctx: FusionCommandContext = {
    cwd: "/project",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getEntries: () => entries },
    ui,
  };
  const messages: Array<Parameters<FusionMessageSink["sendMessage"]>[0]> = [];
  const runStore = new FusionRunStore({
    idFactory: () => "fusion-1",
    now: () => 1,
    persistence: {
      appendEntry: (customType, data) =>
        entries.push({ type: "custom", customType, data }),
    },
  });
  const orchestrator = new FusionOrchestrator({
    rpc,
    runStore,
    sendMessage: (message) => messages.push(message),
    loadConfig: async () => CONFIG,
  });
  return { orchestrator, rpc, runStore, entries, ui, ctx, messages };
}

class FakeRpc implements FusionRpcClientLike {
  pings = 0;
  readonly spawns: Array<Record<string, unknown>> = [];
  readonly statuses: Array<unknown> = [];
  readonly stops: Array<unknown> = [];
  readonly interrupts: Array<unknown> = [];
  readonly spawnResults: unknown[] = [{ details: { runId: "chain-1" } }];
  readonly statusResults = new Map<string, unknown>();
  pingPromise: Promise<unknown> | undefined;
  spawnPromise: Promise<unknown> | undefined;
  statusPromise: Promise<unknown> | undefined;
  stopPromise: Promise<unknown> | undefined;
  stopError: Error | undefined;
  interruptError: Error | undefined;

  async ping(): Promise<unknown> {
    this.pings++;
    return this.pingPromise ?? { ok: true };
  }

  async spawn(params: object): Promise<unknown> {
    assert.ok(isRecord(params));
    this.spawns.push(params);
    if (this.spawnPromise) return this.spawnPromise;
    const result = this.spawnResults.shift();
    if (result instanceof Error) throw result;
    return result ?? { details: { runId: `run-${this.spawns.length}` } };
  }

  async status(params = {}): Promise<unknown> {
    this.statuses.push(params);
    if (this.statusPromise) return this.statusPromise;
    const id =
      isRecord(params) && typeof params.id === "string" ? params.id : undefined;
    const result = id ? this.statusResults.get(id) : undefined;
    if (result instanceof Error) throw result;
    return result ?? { runId: id, results: [] };
  }

  async stop(params: object): Promise<unknown> {
    this.stops.push(params);
    if (this.stopPromise) return this.stopPromise;
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
