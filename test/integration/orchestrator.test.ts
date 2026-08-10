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

function judgeWorkflowTask(spawn: unknown): { agent: string; task: string } {
  if (!isRecord(spawn) || typeof spawn.workflowScript !== "string") {
    throw new TypeError("Expected a judge workflow spawn.");
  }
  const serialized = spawn.workflowScript.match(
    /^return runs\.run\("judge", (.*)\);$/,
  )?.[1];
  if (!serialized) throw new TypeError("Expected a serialized judge task.");
  const task: unknown = JSON.parse(serialized);
  if (!isJudgeWorkflowTask(task)) {
    throw new TypeError("Expected a serialized judge task payload.");
  }
  return task;
}

function isJudgeWorkflowTask(
  value: unknown,
): value is { agent: string; task: string } {
  return (
    isRecord(value) &&
    typeof value.agent === "string" &&
    typeof value.task === "string"
  );
}

const EXACT_REVIEW_PROMPT = `Review the implementation.

Return either:
- the exact line \`NO_FINDINGS\`, or
- one or more blocks in this exact format:
  \`FINDING: CRITICAL|MAJOR|MINOR | <short title>\`
  \`Evidence: <file:line and concrete failure>\`
  \`Fix: <specific change>\`

Do not write any other prose.`;

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
    merge: {
      panel: [
        {
          id: "security",
          label: "Security",
          agent: "panel-agent",
          question: "Cover ONLY the security surface of: {task}",
        },
        {
          id: "perf",
          label: "Perf",
          agent: "panel-agent",
          question: "Cover ONLY throughput and latency of: {task}",
        },
      ],
      judge: { agent: "pi-fusion.fusion-judge" },
      concurrency: 2,
      context: "fresh",
      synthesis: "merge",
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

test("legacy chain completion validates exact caller output", async () => {
  const fixture = makeFixture();
  fixture.runStore.startRun({
    id: "fusion-1",
    prompt: EXACT_REVIEW_PROMPT,
    profileName: "quality",
    phase: "chain",
  });
  fixture.runStore.updateRun("fusion-1", { chainRunId: "chain-1" });
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "chain",
    state: "running",
    steps: [{ status: "running" }, { status: "running" }],
  });
  await fixture.orchestrator.restore(fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "chain",
    state: "complete",
    results: [
      { agent: "panel-1", success: true, output: "NO_FINDINGS" },
      { agent: "panel-2", success: true, output: "NO_FINDINGS" },
      {
        agent: "judge-agent",
        success: true,
        output: "# Fusion Report\n\n## Summary\nLooks good.",
      },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /violated the exact caller output contract/);
});

test("legacy chain completion fails on judge event/status disagreement", async () => {
  const fixture = makeFixture();
  fixture.runStore.startRun({
    id: "fusion-1",
    prompt: "Compare APIs",
    profileName: "quality",
    phase: "chain",
  });
  fixture.runStore.updateRun("fusion-1", { chainRunId: "chain-1" });
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "chain",
    state: "running",
    steps: [{ status: "running" }, { status: "running" }],
  });
  await fixture.orchestrator.restore(fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "chain",
    state: "failed",
    steps: [
      { status: "completed", output: "Architect" },
      { status: "completed", output: "Tester" },
      { status: "failed", error: "Judge timed out" },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
    state: "failed",
    results: [
      { agent: "panel-1", success: true, output: "Architect" },
      { agent: "panel-2", success: true, output: "Tester" },
      { agent: "judge-agent", success: true, output: "Judge says clean" },
    ],
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /disagree about judge result/);
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

test("panel completion with one success fails closed when quorum is lost", async () => {
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

  assert.equal(result.status, "failed");
  assert.equal(fixture.rpc.spawns.length, 1);
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.match(
    fixture.messages.at(-1)?.content ?? "",
    /Only 1 of 2 fusion panelists completed successfully/,
  );
  assert.match(fixture.messages.at(-1)?.content ?? "", /boom/);
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
  assert.equal(judgeWorkflowTask(fixture.rpc.spawns[1]).agent, "judge-agent");
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

test("terminal workflow status restores failures and blocks incomplete quorum", async () => {
  const config = structuredClone(CONFIG);
  config.profiles.quality!.panel = [
    { id: "architect", label: "Architect", agent: "panel-agent" },
    { id: "tester", label: "Tester", agent: "panel-agent" },
    { id: "skeptic", label: "Skeptic", agent: "panel-agent" },
    { id: "operator", label: "Operator", agent: "panel-agent" },
  ];
  config.profiles.quality!.concurrency = 4;
  const fixture = makeFixture({ config });
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "workflow",
    state: "failed",
    error: "Workflow script timed out after 300000ms.",
    steps: [
      { agent: "panel-1", status: "failed", error: "Failed" },
      { agent: "panel-2", status: "failed", error: "Failed" },
      {
        agent: "panel-3",
        status: "completed",
        output: "Skeptic found no issue.",
      },
      {
        agent: "panel-4",
        status: "completed",
        output: "Operator found no issue.",
      },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
    state: "failed",
    results: [
      { agent: "panel-3", success: true, output: "Skeptic found no issue." },
      { agent: "panel-4", success: true, output: "Operator found no issue." },
    ],
  });

  assert.equal(result.status, "failed");
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
  assert.match(result.error, /Only 2 of 4 fusion panelists/);
  assert.match(result.report ?? "", /Failed panelists: 2/);
});

test("incomplete terminal lifecycle data fails closed", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "workflow",
    state: "complete",
    results: [
      { agent: "panel-1", success: true, output: "Architect answer." },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
    state: "complete",
    results: [
      { agent: "panel-1", success: true, output: "Architect answer." },
    ],
  });

  assert.equal(result.status, "failed");
  assert.match(
    result.error,
    /Terminal subagents status described 1 of 2 configured panel members/,
  );
});

test("partial terminal status cannot be overridden by complete event results", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "workflow",
    state: "complete",
    steps: [
      { agent: "panel-1", status: "completed", output: "Architect answer." },
      { agent: "panel-2", status: "running" },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
    state: "complete",
    results: [
      { agent: "panel-1", success: true, output: "Architect answer." },
      { agent: "panel-2", success: true, output: "Tester answer." },
    ],
  });

  assert.equal(result.status, "failed");
  assert.match(
    result.error,
    /Terminal subagents status described 1 of 2 configured panel members/,
  );
});

test("extra terminal event results fail closed", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set(
    "chain-1",
    completedStatusWithoutResults("chain-1"),
  );

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
    state: "complete",
    results: [
      { agent: "panel-1", success: true, output: "Architect answer." },
      { agent: "panel-2", success: true, output: "Tester answer." },
      { agent: "panel-3", success: true, output: "Unexpected answer." },
    ],
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /contained 3 results for 2 expected workflow steps/);
});

test("complete terminal status takes precedence over conflicting event results", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "workflow",
    state: "failed",
    steps: [
      { agent: "panel-1", status: "completed", output: "Architect answer." },
      { agent: "panel-2", status: "failed", error: "Provider failed." },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
    state: "failed",
    results: [
      { agent: "panel-1", success: true, output: "Architect answer." },
      { agent: "panel-2", success: true, output: "Tester answer." },
    ],
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /Only 1 of 2 fusion panelists completed/);
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
});

test("complete terminal status preserves panel identities when event results are reordered", async () => {
  const fixture = makeFixture();
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "workflow",
    state: "complete",
    steps: [
      { agent: "panel-1", status: "completed", output: "Architect answer." },
      { agent: "panel-2", status: "completed", output: "Tester answer." },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
    state: "complete",
    results: [
      { agent: "panel-2", success: true, output: "Tester answer." },
      { agent: "panel-1", success: true, output: "Architect answer." },
    ],
  });

  assert.equal(result.status, "started");
  assert.deepEqual(
    fixture.orchestrator.getActiveRun()?.panelOutputs?.map(
      ({ index, output }) => ({ index, output }),
    ),
    [
      { index: 0, output: "Architect answer." },
      { index: 1, output: "Tester answer." },
    ],
  );
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

test("workflow panel waits for the result artifact after terminal status is written", async () => {
  const fixture = makeFixture();
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "workflow",
    state: "complete",
    endedAt: Date.now(),
    steps: [
      { agent: "panel-1", status: "complete" },
      { agent: "panel-2", status: "complete" },
    ],
  });

  const pending = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(pending.status, "ignored");
  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "panel");
  assert.equal(fixture.rpc.spawns.length, 1);

  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));
  const completed = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(completed.status, "started");
  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "judge");
  assert.equal(fixture.rpc.spawns.length, 2);
});

test("workflow agreement emit records skipped panelists and starts the judge", async () => {
  const fixture = makeFixture();
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  await fixture.orchestrator.startRun(
    "--profile agreement compare",
    fixture.ctx,
  );
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    mode: "workflow",
    state: "complete",
    workflow: {
      emits: [{ type: "pi-fusion-panel-stop", indices: [2] }],
    },
    results: [
      {
        agent: "panel-1",
        success: true,
        structuredOutput: panelDecision("Choose A"),
      },
      {
        agent: "panel-2",
        success: true,
        structuredOutput: panelDecision("choose A."),
      },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(result.status, "started");
  assert.equal(fixture.orchestrator.getActiveRun()?.phase, "judge");
  assert.equal(
    fixture.orchestrator.getActiveRun()?.panelStopReason,
    "agreement",
  );
  assert.equal(
    fixture.orchestrator.getActiveRun()?.panelFailures?.[0]?.reason,
    "stopped-after-agreement",
  );
  assert.equal(
    fixture.orchestrator.getActiveRun()?.panelOutputs?.[0]?.agent,
    "panel-agent",
  );
});

test("panel completion fails closed when terminal status omits every result", async () => {
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
    /Terminal subagents data described 0 of 2 configured panel members/,
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

test("judge timeout reports the workflow deadline and child exit", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));
  await fixture.orchestrator.handleSubagentComplete({ runId: "chain-1" });
  fixture.rpc.statusResults.set("judge-1", {
    runId: "judge-1",
    mode: "workflow",
    state: "failed",
    error: "Workflow script timed out after 300000ms.",
    steps: [
      {
        agent: "judge-agent",
        status: "failed",
        error: "Judge process exited with code 143.",
      },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "judge-1",
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /Workflow script timed out after 300000ms/);
  assert.match(result.error, /Judge process exited with code 143/);
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
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

test("judge completion fails when synthesis violates an exact caller contract", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun(EXACT_REVIEW_PROMPT, fixture.ctx);
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
        output: "# Fusion Report\n\n## Summary\nEverything looks good.",
      },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "judge-1",
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /violated the exact caller output contract/);
  assert.equal(fixture.orchestrator.getActiveRun(), undefined);
});

test("restored legacy judge completion detects an exact caller contract from the prompt", async () => {
  const fixture = makeFixture();
  fixture.runStore.startRun({
    id: "fusion-1",
    prompt: EXACT_REVIEW_PROMPT,
    profileName: "quality",
    phase: "judge",
  });
  fixture.runStore.updateRun("fusion-1", { judgeRunId: "judge-1" });
  fixture.rpc.statusResults.set("judge-1", {
    runId: "judge-1",
    state: "running",
    results: [],
  });
  await fixture.orchestrator.restore(fixture.ctx);
  fixture.rpc.statusResults.set("judge-1", {
    runId: "judge-1",
    state: "complete",
    results: [
      {
        agent: "judge-agent",
        success: true,
        output: "# Fusion Report\n\n## Summary\nEverything looks good.",
      },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "judge-1",
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /violated the exact caller output contract/);
});

test("judge completion returns a valid exact caller output unchanged", async () => {
  const fixture = makeFixture();
  await fixture.orchestrator.startRun(EXACT_REVIEW_PROMPT, fixture.ctx);
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));
  await fixture.orchestrator.handleSubagentComplete({ runId: "chain-1" });
  fixture.rpc.statusResults.set("judge-1", {
    runId: "judge-1",
    state: "complete",
    results: [
      { agent: "judge-agent", success: true, output: "NO_FINDINGS" },
    ],
  });

  const result = await fixture.orchestrator.handleSubagentComplete({
    runId: "judge-1",
  });

  assert.equal(result.status, "done");
  assert.equal(fixture.messages.at(-1)?.content, "NO_FINDINGS");
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
    "failed",
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

function makeFixture(seed?: {
  entries?: Array<{ type: "custom"; customType: string; data?: unknown }>;
  config?: FusionConfig;
}): {
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
    seed?.entries ?? [];
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
    loadConfig: async () => seed?.config ?? CONFIG,
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

test("merge run reaches done through the composer and emits no new phase", async () => {
  const fixture = makeFixture();
  const phases: string[] = [];
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });

  await fixture.orchestrator.startRun(
    { prompt: "review the release", profile: "merge" },
    fixture.ctx,
  );
  phases.push(fixture.orchestrator.getActiveRun()?.phase ?? "none");

  const panelSpawn = fixture.rpc.spawns[0] as { workflowScript?: string };
  assert.match(
    panelSpawn.workflowScript ?? "",
    /Cover ONLY the security surface of: review the release/,
  );

  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    state: "complete",
    results: [
      { agent: "panel-agent", success: true, output: "Security facet." },
      { agent: "panel-agent", success: true, output: "Perf facet." },
    ],
  });
  const panelResult = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });
  assert.equal(panelResult.status, "started");
  phases.push(fixture.orchestrator.getActiveRun()?.phase ?? "none");

  const synthesisSpawn = judgeWorkflowTask(fixture.rpc.spawns[1]);
  assert.equal(synthesisSpawn.agent, "pi-fusion.fusion-composer");
  assert.match(synthesisSpawn.task, /You are the fusion composer\./);
  assert.match(synthesisSpawn.task, /Facet assignments:/);

  fixture.rpc.statusResults.set("judge-1", {
    runId: "judge-1",
    state: "complete",
    results: [
      {
        agent: "pi-fusion.fusion-composer",
        success: true,
        output:
          "# Fusion Report\n\n## Combined Answer\nShip it.\n\n## Gaps\nMigrations uncovered.",
      },
    ],
  });
  const done = await fixture.orchestrator.handleSubagentComplete({
    runId: "judge-1",
  });

  assert.equal(done.status, "done");
  assert.match(fixture.messages.at(-1)?.content ?? "", /## Combined Answer/);
  assert.match(fixture.messages.at(-1)?.content ?? "", /Migrations uncovered/);

  // No FusionPhase beyond the existing vocabulary: fusion:rpc:v1 consumers with
  // strict enum validators must keep working.
  for (const phase of phases) {
    assert.ok(
      ["panel", "chain", "judge", "done", "failed", "cancelled"].includes(phase),
      `unexpected phase ${phase}`,
    );
  }
});

test("merge run with one failed panelist fails closed", async () => {
  const fixture = makeFixture();
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });

  await fixture.orchestrator.startRun(
    { prompt: "review the release", profile: "merge" },
    fixture.ctx,
  );
  fixture.rpc.statusResults.set("chain-1", {
    runId: "chain-1",
    state: "complete",
    results: [
      { agent: "panel-agent", success: true, output: "Security facet." },
      { agent: "panel-agent", success: false, error: "timed out" },
    ],
  });

  const panelResult = await fixture.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.equal(panelResult.status, "failed");
  assert.equal(fixture.rpc.spawns.length, 1);
  assert.match(panelResult.error, /Only 1 of 2 fusion panelists/);
});

test("select run is unchanged end to end", async () => {
  const fixture = makeFixture();
  fixture.rpc.spawnResults.push({ details: { runId: "judge-1" } });

  await fixture.orchestrator.startRun("compare", fixture.ctx);
  fixture.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));
  await fixture.orchestrator.handleSubagentComplete({ runId: "chain-1" });

  const synthesisSpawn = judgeWorkflowTask(fixture.rpc.spawns[1]);
  assert.equal(synthesisSpawn.agent, "judge-agent");
  assert.match(synthesisSpawn.task, /You are the fusion judge\./);
  assert.doesNotMatch(synthesisSpawn.task, /Facet assignments:/);
});

test("an inline --panel run survives a restore", async () => {
  const first = makeFixture();
  await first.orchestrator.startRun(
    { prompt: "compare", panel: ["opus", "gpt-5.5"] },
    first.ctx,
  );

  const stored = first.orchestrator.getActiveRun();
  assert.ok(stored);
  // The display name is deliberately not a config profile name.
  assert.equal(stored.profileName, "quality (inline panel)");
  assert.deepEqual(stored.inlinePanel, ["opus", "gpt-5.5"]);
  assert.equal(stored.baseProfileName, "quality");

  // Restart: a fresh orchestrator over the same persisted session.
  const second = makeFixture({ entries: first.entries });
  await second.orchestrator.restore(second.ctx);

  const restored = second.orchestrator.getActiveRun();
  assert.ok(restored, "the inline run should still be active after restore");

  // Completing the panel used to fail with "the active profile was not
  // available", because resolving "quality (inline panel)" throws.
  second.rpc.statusResults.set("chain-1", successfulPanelStatus("chain-1"));
  second.rpc.spawnResults.push({ details: { runId: "judge-1" } });
  const result = await second.orchestrator.handleSubagentComplete({
    runId: "chain-1",
  });

  assert.notEqual(result.status, "failed");
  const judgeSpawn = judgeWorkflowTask(second.rpc.spawns.at(-1));
  assert.equal(judgeSpawn.agent, "judge-agent");
});
