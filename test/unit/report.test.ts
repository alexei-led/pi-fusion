import assert from "node:assert/strict";
import test from "node:test";
import {
  renderCancelledReport,
  renderFailureReport,
  renderJudgeReport,
  renderPanelFailureReport,
  renderSinglePanelReport,
} from "../../src/report.js";
import type { FailedPanelSummary, PanelOutput } from "../../src/run-builder.js";

const RUN_PANEL = {
  id: "fusion-1",
  prompt: "Compare APIs\nwith evidence",
  profileName: "quality",
  phase: "panel" as const,
  panelRunId: "panel-1",
  createdAt: 0,
  updatedAt: 1_000,
};

const RUN_JUDGE = {
  ...RUN_PANEL,
  phase: "judge" as const,
  judgeRunId: "judge-1",
};

const ARCHITECT: PanelOutput = {
  index: 0,
  id: "architect",
  label: "Architect",
  agent: "panel-agent",
  output: "Architect recommends A.",
};

const TESTER: PanelOutput = {
  index: 1,
  id: "tester",
  label: "Tester",
  agent: "panel-agent",
  output: "Tester verifies A.",
};

const TIMED_OUT_TESTER: FailedPanelSummary = {
  index: 1,
  id: "tester",
  label: "Tester",
  agent: "panel-agent",
  summary: "Timed out\nstderr tail",
  artifactPath: "/tmp/tester.md",
  sessionPath: "/tmp/tester.jsonl",
};

test("renderJudgeReport renders deterministic success sections", () => {
  const report = renderJudgeReport({
    run: RUN_JUDGE,
    judgeOutput: [
      "# Fusion Report",
      "",
      "## Summary",
      "Use API A.",
      "",
      "## Consensus",
      "Both panelists prefer A.",
      "",
      "## Disagreements",
      "None.",
      "",
      "## Unique Insights",
      "Tester noted rollout safety.",
      "",
      "## Blind Spots",
      "No production traffic sample.",
      "",
      "## Recommendation",
      "Ship API A.",
      "",
      "## Risks",
      "Migration risk remains.",
      "",
      "## Next Step",
      "Write the migration checklist.",
    ].join("\n"),
    panelOutputs: [ARCHITECT, TESTER],
    failures: [],
  });

  assert.equal(
    report,
    [
      "# Fusion Report",
      "",
      "## Summary",
      "Use API A.",
      "",
      "## Agent Status",
      "- Successful panelists: 2",
      "- Failed panelists: 0",
      "- Architect: succeeded",
      "  Agent: panel-agent",
      "- Tester: succeeded",
      "  Agent: panel-agent",
      "- Judge: succeeded",
      "",
      "## Consensus",
      "Both panelists prefer A.",
      "",
      "## Disagreements",
      "None.",
      "",
      "## Unique Insights",
      "Tester noted rollout safety.",
      "",
      "## Blind Spots",
      "No production traffic sample.",
      "",
      "## Recommendation",
      "Ship API A.",
      "",
      "## Risks",
      "Migration risk remains.",
      "",
      "## Next Step",
      "Write the migration checklist.",
      "",
      "## Run Metadata",
      "- Fusion run: fusion-1",
      "- Profile: quality",
      "- Phase: judge",
      "- Prompt: Compare APIs",
      "- Panel run: panel-1",
      "- Judge run: judge-1",
      "- Created: 1970-01-01T00:00:00.000Z",
      "- Updated: 1970-01-01T00:00:01.000Z",
    ].join("\n"),
  );
});

test("renderJudgeReport includes readable per-panel and judge run details", () => {
  const report = renderJudgeReport({
    run: RUN_JUDGE,
    judgeOutput: "Prefer A.",
    panelOutputs: [
      {
        ...ARCHITECT,
        observation: {
          model: "ollama/qwen",
          durationMs: 1200,
          usage: { inputTokens: 100, outputTokens: 40, costUsd: 0 },
        },
      },
      {
        ...TESTER,
        observation: {
          model: "openai/gpt-mini",
          durationMs: 2300,
          usage: { inputTokens: 120, outputTokens: 50, costUsd: 0.02 },
          providerFailures: [
            {
              provider: "openai",
              model: "openai/gpt-mini",
              message: "retry",
              count: 2,
            },
          ],
        },
      },
    ],
    failures: [],
    judgeObservation: {
      model: "anthropic/claude-haiku",
      durationMs: 800,
      usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.01 },
    },
  });

  assert.match(report, /## Run Details/);
  assert.match(report, /Architect.*ollama\/qwen.*1\.2s/);
  assert.match(report, /Tester.*openai\/gpt-mini.*2\.3s/);
  assert.match(report, /Judge.*anthropic\/claude-haiku.*0\.8s/);
  assert.match(report, /Total estimated cost: \$0\.0300/);
  assert.match(report, /openai\/gpt-mini.*retry.*x2/);
});

test("renderJudgeReport distinguishes configured from observed models", () => {
  const report = renderJudgeReport({
    run: RUN_JUDGE,
    judgeOutput: "Prefer A.",
    panelOutputs: [
      {
        ...ARCHITECT,
        model: "deepseek/requested-panel",
        observation: { durationMs: 1200 },
      },
    ],
    failures: [],
    judgeModel: "deepseek/requested-judge",
    judgeObservation: { durationMs: 800 },
  });

  assert.match(report, /Configured model: deepseek\/requested-panel/);
  assert.match(report, /Configured model: deepseek\/requested-judge/);
  assert.match(report, /requested-panel \(configured\).*1\.2s/);
  assert.match(report, /requested-judge \(configured\).*0\.8s/);
  assert.match(report, /Aggregate model time: 2\.0s/);
});

test("renderJudgeReport shows partial success and timed-out panelists", () => {
  const report = renderJudgeReport({
    run: RUN_JUDGE,
    judgeOutput: "Prefer A.",
    panelOutputs: [ARCHITECT],
    failures: [TIMED_OUT_TESTER],
  });

  assert.equal(
    report,
    [
      "# Fusion Report",
      "",
      "## Summary",
      "Fusion completed with 1 successful panelist and 1 failed panelist.",
      "",
      "## Agent Status",
      "- Successful panelists: 1",
      "- Failed panelists: 1",
      "- Architect: succeeded",
      "  Agent: panel-agent",
      "- Tester: failed - Timed out",
      "  Agent: panel-agent",
      "  Artifact: /tmp/tester.md",
      "  Session: /tmp/tester.jsonl",
      "- Judge: succeeded",
      "",
      "## Consensus",
      "Not specified by the judge.",
      "",
      "## Disagreements",
      "Not specified by the judge.",
      "",
      "## Unique Insights",
      "Not specified by the judge.",
      "",
      "## Blind Spots",
      "Not specified by the judge.",
      "",
      "## Recommendation",
      "Prefer A.",
      "",
      "## Risks",
      "Not specified by the judge.",
      "",
      "## Next Step",
      "Review the recommendation and decide whether to act on it.",
      "",
      "## Run Metadata",
      "- Fusion run: fusion-1",
      "- Profile: quality",
      "- Phase: judge",
      "- Prompt: Compare APIs",
      "- Panel run: panel-1",
      "- Judge run: judge-1",
      "- Created: 1970-01-01T00:00:00.000Z",
      "- Updated: 1970-01-01T00:00:01.000Z",
    ].join("\n"),
  );
});

test("renderSinglePanelReport renders the single result with required sections", () => {
  const report = renderSinglePanelReport({
    run: RUN_PANEL,
    output: { ...ARCHITECT, output: "Choose A.\nIt is simpler." },
    failures: [TIMED_OUT_TESTER],
  });

  assert.equal(
    report,
    [
      "# Fusion Report",
      "",
      "## Summary",
      "Only one panelist completed successfully, so pi-fusion skipped the judge step.",
      "",
      "## Agent Status",
      "- Successful panelists: 1",
      "- Failed panelists: 1",
      "- Architect: succeeded",
      "  Agent: panel-agent",
      "- Tester: failed - Timed out",
      "  Agent: panel-agent",
      "  Artifact: /tmp/tester.md",
      "  Session: /tmp/tester.jsonl",
      "- Judge: skipped - one successful panelist",
      "",
      "## Consensus",
      "Only one panelist succeeded; no cross-panel consensus was available.",
      "",
      "## Disagreements",
      "No disagreements were synthesized because the judge did not run.",
      "",
      "## Unique Insights",
      "Single successful panelist: Architect.",
      "",
      "## Blind Spots",
      "The result was not compared against another successful panelist or judge synthesis.",
      "",
      "## Recommendation",
      "Choose A.\nIt is simpler.",
      "",
      "## Risks",
      "Single-panel results can miss disagreements, blind spots, and model-specific failure modes.",
      "",
      "## Next Step",
      "Use this single-panel result directly, or rerun /fusion if you need judge synthesis.",
      "",
      "## Run Metadata",
      "- Fusion run: fusion-1",
      "- Profile: quality",
      "- Phase: panel",
      "- Prompt: Compare APIs",
      "- Panel run: panel-1",
      "- Created: 1970-01-01T00:00:00.000Z",
      "- Updated: 1970-01-01T00:00:01.000Z",
    ].join("\n"),
  );
});

test("renderPanelFailureReport renders all-panel failure", () => {
  const report = renderPanelFailureReport({
    run: RUN_PANEL,
    failures: [
      { ...TIMED_OUT_TESTER, index: 0, id: "architect", label: "Architect" },
      TIMED_OUT_TESTER,
    ],
    error: "No outputs",
  });

  assert.equal(
    report,
    [
      "# Fusion Report",
      "",
      "## Summary",
      "No panelists completed successfully. The fusion run could not produce a recommendation.",
      "",
      "## Agent Status",
      "- Successful panelists: 0",
      "- Failed panelists: 2",
      "- Architect: failed - Timed out",
      "  Agent: panel-agent",
      "  Artifact: /tmp/tester.md",
      "  Session: /tmp/tester.jsonl",
      "- Tester: failed - Timed out",
      "  Agent: panel-agent",
      "  Artifact: /tmp/tester.md",
      "  Session: /tmp/tester.jsonl",
      "- Judge: not run - no successful panelists",
      "",
      "## Consensus",
      "No consensus was available because all panelists failed.",
      "",
      "## Disagreements",
      "No disagreements were synthesized because the judge did not run.",
      "",
      "## Unique Insights",
      "No panel output was available to summarize.",
      "",
      "## Blind Spots",
      "All panelists failed, so the report may be missing every intended review perspective.",
      "",
      "## Recommendation",
      "No recommendation is available.",
      "",
      "## Risks",
      "All panelists failed. Root error: No outputs",
      "",
      "## Next Step",
      "Inspect the failed subagent run IDs or artifacts, then retry /fusion after fixing the cause.",
      "",
      "## Run Metadata",
      "- Fusion run: fusion-1",
      "- Profile: quality",
      "- Phase: panel",
      "- Prompt: Compare APIs",
      "- Panel run: panel-1",
      "- Created: 1970-01-01T00:00:00.000Z",
      "- Updated: 1970-01-01T00:00:01.000Z",
    ].join("\n"),
  );
});

test("renderFailureReport renders judge failure with panel status", () => {
  const report = renderFailureReport({
    run: RUN_JUDGE,
    error: "Judge failed\nstack trace",
    panelOutputs: [ARCHITECT, TESTER],
    failures: [],
  });

  assert.equal(
    report,
    [
      "# Fusion Report",
      "",
      "## Summary",
      "Fusion failed before it could produce a final report.",
      "",
      "## Agent Status",
      "- Successful panelists: 2",
      "- Failed panelists: 0",
      "- Architect: succeeded",
      "  Agent: panel-agent",
      "- Tester: succeeded",
      "  Agent: panel-agent",
      "- Judge: failed - Judge failed",
      "- Phase: judge",
      "",
      "## Consensus",
      "No consensus was available because fusion failed.",
      "",
      "## Disagreements",
      "No disagreements were synthesized because fusion failed.",
      "",
      "## Unique Insights",
      "No unique insights were synthesized because fusion failed.",
      "",
      "## Blind Spots",
      "The failure may hide panel disagreements, missing evidence, or provider-specific errors.",
      "",
      "## Recommendation",
      "No recommendation is available.",
      "",
      "## Risks",
      "Fusion failed in phase judge: Judge failed\nstack trace",
      "",
      "## Next Step",
      "Fix the reported error and retry /fusion.",
      "",
      "## Run Metadata",
      "- Fusion run: fusion-1",
      "- Profile: quality",
      "- Phase: judge",
      "- Prompt: Compare APIs",
      "- Panel run: panel-1",
      "- Judge run: judge-1",
      "- Created: 1970-01-01T00:00:00.000Z",
      "- Updated: 1970-01-01T00:00:01.000Z",
    ].join("\n"),
  );
});

test("renderCancelledReport renders cancellation details", () => {
  const report = renderCancelledReport({
    run: RUN_JUDGE,
    method: "interrupt",
    targetRunId: "judge-1",
    panelOutputs: [ARCHITECT],
    failures: [TIMED_OUT_TESTER],
  });

  assert.equal(
    report,
    [
      "# Fusion Report",
      "",
      "## Summary",
      "Fusion cancellation was requested.",
      "",
      "## Agent Status",
      "- Successful panelists: 1",
      "- Failed panelists: 1",
      "- Architect: succeeded",
      "  Agent: panel-agent",
      "- Tester: failed - Timed out",
      "  Agent: panel-agent",
      "  Artifact: /tmp/tester.md",
      "  Session: /tmp/tester.jsonl",
      "- Judge: cancelled or not completed",
      "- Phase: judge",
      "- Cancellation method: interrupt",
      "- Target run: judge-1",
      "",
      "## Consensus",
      "No final consensus was available because fusion was cancelled.",
      "",
      "## Disagreements",
      "No final disagreements were synthesized because fusion was cancelled.",
      "",
      "## Unique Insights",
      "No final unique insights were synthesized because fusion was cancelled.",
      "",
      "## Blind Spots",
      "Cancellation may leave in-flight panel or judge output incomplete.",
      "",
      "## Recommendation",
      "No recommendation is available.",
      "",
      "## Risks",
      "The target subagent run (judge-1) may still need inspection if it does not stop promptly.",
      "",
      "## Next Step",
      "Inspect the subagent run if it does not stop promptly.",
      "",
      "## Run Metadata",
      "- Fusion run: fusion-1",
      "- Profile: quality",
      "- Phase: judge",
      "- Prompt: Compare APIs",
      "- Panel run: panel-1",
      "- Judge run: judge-1",
      "- Created: 1970-01-01T00:00:00.000Z",
      "- Updated: 1970-01-01T00:00:01.000Z",
    ].join("\n"),
  );
});
