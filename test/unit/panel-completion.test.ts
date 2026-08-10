import assert from "node:assert/strict";
import test from "node:test";
import { decidePanelCompletion } from "../../src/panel-completion.js";
import type {
  FailedPanelSummary,
  FusionProfile,
  FusionRun,
  PanelOutput,
} from "../../src/types.js";

const EXACT_REVIEW_PROMPT = `Review the implementation.

Return either:
- the exact line \`NO_FINDINGS\`, or
- one or more blocks in this exact format:
  \`FINDING: CRITICAL|MAJOR|MINOR | <short title>\`
  \`Evidence: <file:line and concrete failure>\`
  \`Fix: <specific change>\`

Do not write any other prose.`;

const PROFILE: FusionProfile = {
  panel: [
    { id: "architect", label: "Architect", agent: "panel-agent" },
    { id: "tester", label: "Tester", agent: "panel-agent" },
  ],
  judge: { agent: "judge-agent", model: "judge-model", thinking: "high" },
  context: "fresh",
};

function makeRun(): FusionRun {
  return {
    id: "fusion-1",
    prompt: "compare APIs",
    profileName: "quality",
    phase: "chain",
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeOutput(index: number, output: string): PanelOutput {
  return { index, agent: "panel-agent", output };
}

function makeFailure(index: number, summary: string): FailedPanelSummary {
  return { index, agent: "panel-agent", summary };
}

function judgeWorkflowTask(workflowScript: string): { agent: string; task: string } {
  const serialized = workflowScript.match(
    /^return runs\.run\("judge", (.*)\);$/,
  )?.[1];
  assert.ok(serialized);
  return JSON.parse(serialized) as { agent: string; task: string };
}

test("decidePanelCompletion returns a failure report when no panelists succeed", () => {
  const decision = decidePanelCompletion({
    run: makeRun(),
    profile: PROFILE,
    panelOutputs: [],
    panelFailures: [makeFailure(0, "boom")],
  });

  assert.equal(decision.kind, "fail");
  assert.equal(decision.error, "No fusion panelists completed successfully.");
  assert.match(decision.report, /No panelists completed successfully/);
});

test("decidePanelCompletion fails closed when only one of multiple panelists succeeds", () => {
  const decision = decidePanelCompletion({
    run: makeRun(),
    profile: PROFILE,
    panelOutputs: [makeOutput(0, "Choose A.")],
    panelFailures: [makeFailure(1, "timed out")],
  });

  assert.equal(decision.kind, "fail");
  assert.match(decision.error, /Only 1 of 2 fusion panelists completed/);
  assert.match(decision.report, /timed out/);
});

test("decidePanelCompletion does not treat one stopped survivor as agreement", () => {
  const decision = decidePanelCompletion({
    run: makeRun(),
    profile: { ...PROFILE, stopWhenPanelAgrees: true },
    panelOutputs: [makeOutput(0, "Choose A.")],
    panelFailures: [
      {
        ...makeFailure(1, "Stopped after strong panel agreement."),
        reason: "stopped-after-agreement",
      },
    ],
  });

  assert.equal(decision.kind, "fail");
});

test("decidePanelCompletion completes a configured single-member panel", () => {
  const decision = decidePanelCompletion({
    run: makeRun(),
    profile: { ...PROFILE, panel: [PROFILE.panel[0]!] },
    panelOutputs: [makeOutput(0, "Choose A.")],
    panelFailures: [],
  });

  assert.equal(decision.kind, "complete");
  assert.match(decision.report, /skipped the judge step/);
  assert.match(decision.report, /Choose A/);
});

test("decidePanelCompletion rejects invalid exact output from a single-member panel", () => {
  const decision = decidePanelCompletion({
    run: {
      ...makeRun(),
      prompt: EXACT_REVIEW_PROMPT,
      outputContract: "plan-review-v1",
    },
    profile: { ...PROFILE, panel: [PROFILE.panel[0]!] },
    panelOutputs: [makeOutput(0, "## Summary\nLooks good.")],
    panelFailures: [],
  });

  assert.equal(decision.kind, "fail");
  assert.match(decision.error, /violated the exact caller output contract/);
});

test("decidePanelCompletion prepares a standard judge spawn when multiple panelists succeed", () => {
  const decision = decidePanelCompletion({
    run: makeRun(),
    profile: PROFILE,
    panelOutputs: [
      makeOutput(0, "Architect says A."),
      makeOutput(1, "Tester says A is testable."),
    ],
    panelFailures: [],
  });

  assert.equal(decision.kind, "judge");
  if (decision.kind !== "judge") return;
  const params = judgeWorkflowTask(decision.params.workflowScript);
  assert.equal(params.agent, "judge-agent");
  assert.match(params.task, /Architect says A/);
  assert.equal(decision.notification, "Fusion judge started");
  assert.equal(
    decision.missingRunIdError,
    "pi-subagents spawn did not return a judge run ID.",
  );
});

test("decidePanelCompletion labels fallback judge spawns explicitly", () => {
  const decision = decidePanelCompletion({
    run: makeRun(),
    profile: PROFILE,
    panelOutputs: [
      makeOutput(0, "Architect says A."),
      makeOutput(1, "Tester says A is testable."),
    ],
    panelFailures: [],
    fallbackJudge: true,
  });

  assert.equal(decision.kind, "judge");
  assert.equal(decision.notification, "Fusion fallback judge started");
  assert.equal(
    decision.missingRunIdError,
    "pi-subagents spawn did not return a fallback judge run ID.",
  );
});

test("merge synthesis never returns a lone panelist as the answer", () => {
  const mergeProfile = { ...PROFILE, synthesis: "merge" as const };

  const merged = decidePanelCompletion({
    run: makeRun(),
    profile: mergeProfile,
    panelOutputs: [makeOutput(0, "security facet only")],
    panelFailures: [makeFailure(1, "timed out")],
  });

  assert.equal(merged.kind, "fail");
  assert.match(merged.error, /Only 1 of 2 fusion panelists/);
});

test("select synthesis reports every failed panelist when quorum is lost", () => {
  const selected = decidePanelCompletion({
    run: makeRun(),
    profile: PROFILE,
    panelOutputs: [makeOutput(0, "whole answer")],
    panelFailures: [makeFailure(1, "provider unavailable")],
  });

  assert.equal(selected.kind, "fail");
  assert.match(selected.report, /provider unavailable/);
});

test("merge synthesis still fails when no panelist succeeds", () => {
  const decision = decidePanelCompletion({
    run: makeRun(),
    profile: { ...PROFILE, synthesis: "merge" as const },
    panelOutputs: [],
    panelFailures: [makeFailure(0, "boom")],
  });

  assert.equal(decision.kind, "fail");
});

test("merge synthesis spawns the composer for a full panel", () => {
  const decision = decidePanelCompletion({
    run: makeRun(),
    profile: { ...PROFILE, synthesis: "merge" as const },
    panelOutputs: [makeOutput(0, "facet one"), makeOutput(1, "facet two")],
    panelFailures: [],
  });

  assert.equal(decision.kind, "judge");
  if (decision.kind !== "judge") return;
  const params = judgeWorkflowTask(decision.params.workflowScript);
  assert.match(params.task, /You are the fusion composer\./);
  assert.match(params.task, /## Coverage Map/);
});
