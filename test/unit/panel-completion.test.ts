import assert from "node:assert/strict";
import test from "node:test";
import { decidePanelCompletion } from "../../src/panel-completion.js";
import type {
  FailedPanelSummary,
  FusionProfile,
  FusionRun,
  PanelOutput,
} from "../../src/types.js";

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

test("decidePanelCompletion returns a single-panel report when one panelist succeeds", () => {
  const decision = decidePanelCompletion({
    run: makeRun(),
    profile: PROFILE,
    panelOutputs: [makeOutput(0, "Choose A.")],
    panelFailures: [makeFailure(1, "timed out")],
  });

  assert.equal(decision.kind, "complete");
  assert.match(decision.report, /skipped the judge step/);
  assert.match(decision.report, /Choose A/);
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

  // Under merge the survivor answered ONE facet; returning it would be wrong,
  // not thin. The composer must run so the report can name the missing facets.
  assert.equal(merged.kind, "judge");
});

test("select synthesis still short-circuits on a lone panelist", () => {
  const selected = decidePanelCompletion({
    run: makeRun(),
    profile: PROFILE,
    panelOutputs: [makeOutput(0, "whole answer")],
    panelFailures: [makeFailure(1, "timed out")],
  });

  assert.equal(selected.kind, "complete");
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
