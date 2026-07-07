import assert from "node:assert/strict";
import test from "node:test";
import {
  appendThinkingSuffix,
  buildFusionChainSpawnParams,
  buildJudgeSpawnParams,
  buildPanelSpawnParams,
  FUSION_ACCEPTANCE_DISABLED,
  type PanelOutput,
  type FailedPanelSummary,
} from "../../src/run-builder.js";
import type { FusionProfile } from "../../src/types.js";

const PROFILE: FusionProfile = {
  panel: [
    {
      id: "architect",
      label: "Architect",
      agent: "pi-fusion.fusion-panelist",
      model: "openai/gpt-5.5",
      thinking: "xhigh",
      role: "architecture and tradeoffs",
    },
    {
      id: "tester",
      label: "Tester",
      agent: "pi-fusion.fusion-panelist",
      model: "anthropic/claude:medium",
      thinking: "high",
      role: "test strategy",
    },
    {
      id: "generalist",
      label: "Generalist",
      agent: "pi-fusion.fusion-panelist",
      thinking: "low",
    },
  ],
  judge: {
    agent: "pi-fusion.fusion-judge",
    model: "openai/gpt-5.5",
    thinking: "high",
  },
  concurrency: 2,
  timeoutMs: 300_000,
  context: "fresh",
};

test("appendThinkingSuffix appends only when a model exists and no suffix exists", () => {
  assert.equal(
    appendThinkingSuffix("openai/gpt-5.5", "xhigh"),
    "openai/gpt-5.5:xhigh",
  );
  assert.equal(
    appendThinkingSuffix("openai/gpt-5.5:high", "xhigh"),
    "openai/gpt-5.5:high",
  );
  assert.equal(appendThinkingSuffix(undefined, "xhigh"), undefined);
  assert.equal(
    appendThinkingSuffix("openai/gpt-5.5", undefined),
    "openai/gpt-5.5",
  );
});

test("buildPanelSpawnParams creates async parallel panel tasks", () => {
  const params = buildPanelSpawnParams(PROFILE, "Compare two API designs");

  assert.equal(params.async, true);
  assert.equal(params.clarify, false);
  assert.equal(params.concurrency, 2);
  assert.equal(params.timeoutMs, 300_000);
  assert.equal(params.context, "fresh");
  assert.deepEqual(params.acceptance, FUSION_ACCEPTANCE_DISABLED);
  assert.equal("action" in params, false);
  assert.equal("chain" in params, false);
  assert.equal("worktree" in params, false);

  const tasks = params.tasks;
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0]?.agent, "pi-fusion.fusion-panelist");
  assert.equal(tasks[0]?.model, "openai/gpt-5.5:xhigh");
  assert.equal(tasks[1]?.model, "anthropic/claude:medium");
  assert.equal("model" in (tasks[2] ?? {}), false);
  assert.equal(tasks[0]?.output, true);
  assert.equal(tasks[0]?.outputMode, "inline");
  assert.equal(tasks[0]?.skill, false);
  assert.deepEqual(tasks[0]?.acceptance, FUSION_ACCEPTANCE_DISABLED);
});

test("buildPanelSpawnParams includes role, prompt, contract, and read-only instruction", () => {
  const params = buildPanelSpawnParams(PROFILE, "Compare two API designs");
  const task = params.tasks[0]?.task ?? "";

  assert.match(task, /Panel member: Architect/);
  assert.match(task, /Role: architecture and tradeoffs/);
  assert.match(task, /Compare two API designs/);
  assert.match(
    task,
    /Read-only: inspect only; leave files, git state, and the workspace untouched\./,
  );
  assert.match(task, /Do not run subagents/);
  assert.doesNotMatch(task, /Do not edit files/);
  assert.doesNotMatch(task, /destructive commands/);
  assert.doesNotMatch(task, /commit changes/);
  assert.match(task, /## Summary/);
  assert.match(task, /## Recommendation/);
  assert.match(task, /## Confidence/);
});

test("buildFusionChainSpawnParams creates a parallel panel step followed by a judge step", () => {
  const params = buildFusionChainSpawnParams(
    PROFILE,
    "Compare two API designs",
  );

  assert.equal(params.async, true);
  assert.equal(params.clarify, false);
  assert.equal(params.context, "fresh");
  assert.equal(params.task, "Compare two API designs");
  assert.deepEqual(params.acceptance, FUSION_ACCEPTANCE_DISABLED);
  assert.equal(params.chain.length, 2);

  const panelStep = params.chain[0];
  assert.equal(panelStep.concurrency, 2);
  assert.equal(panelStep.failFast, false);
  assert.equal(panelStep.parallel.length, 3);
  assert.equal(panelStep.parallel[0]?.label, "Architect");
  assert.equal(panelStep.parallel[0]?.phase, "Panel");
  assert.equal(panelStep.parallel[0]?.as, "architect");
  assert.equal(panelStep.parallel[0]?.model, "openai/gpt-5.5:xhigh");
  assert.deepEqual(
    panelStep.parallel[0]?.acceptance,
    FUSION_ACCEPTANCE_DISABLED,
  );

  const judgeStep = params.chain[1];
  assert.equal(judgeStep.agent, "pi-fusion.fusion-judge");
  assert.equal(judgeStep.label, "Judge");
  assert.equal(judgeStep.phase, "Judge");
  assert.equal(judgeStep.model, "openai/gpt-5.5:high");
  assert.match(judgeStep.task, /Original task:\n\{task\}/);
  assert.match(judgeStep.task, /\{outputs\.architect\}/);
  assert.match(judgeStep.task, /\{outputs\.tester\}/);
  assert.match(judgeStep.task, /# Fusion Report/);
});

test("buildJudgeSpawnParams includes prompt, panel status, outputs, failures, and report contract", () => {
  const outputs: PanelOutput[] = [
    {
      index: 0,
      id: "architect",
      label: "Architect",
      agent: "pi-fusion.fusion-panelist",
      output: "Architecture says choose A.",
    },
    {
      index: 2,
      id: "generalist",
      label: "Generalist",
      agent: "pi-fusion.fusion-panelist",
      output: "Generalist says choose B if latency matters.",
      artifactPath: "/tmp/generalist.md",
    },
  ];
  const failedPanelists: FailedPanelSummary[] = [
    {
      index: 1,
      id: "tester",
      label: "Tester",
      agent: "pi-fusion.fusion-panelist",
      summary: "Timed out",
      artifactPath: "/tmp/tester.md",
    },
  ];

  const params = buildJudgeSpawnParams({
    profile: PROFILE,
    prompt: "Compare two API designs",
    panelOutputs: outputs,
    failedPanelists,
  });

  assert.equal(params.async, true);
  assert.equal(params.clarify, false);
  assert.equal(params.agent, "pi-fusion.fusion-judge");
  assert.equal(params.model, "openai/gpt-5.5:high");
  assert.equal(params.context, "fresh");
  assert.equal(params.timeoutMs, 300_000);
  assert.equal(params.output, true);
  assert.equal(params.outputMode, "inline");
  assert.equal(params.skill, false);
  assert.deepEqual(params.acceptance, FUSION_ACCEPTANCE_DISABLED);

  assert.match(params.task, /Read-only synthesis only\./);
  assert.doesNotMatch(params.task, /Do not edit files/);
  assert.match(params.task, /Original task/);
  assert.match(params.task, /Compare two API designs/);
  assert.match(params.task, /Panel status/);
  assert.match(params.task, /Architect: succeeded/);
  assert.match(params.task, /Tester: failed - Timed out/);
  assert.match(params.task, /Architecture says choose A/);
  assert.match(params.task, /Generalist says choose B/);
  assert.match(params.task, /\/tmp\/tester\.md/);
  assert.match(params.task, /# Fusion Report/);
  assert.match(params.task, /## Disagreements/);
});
