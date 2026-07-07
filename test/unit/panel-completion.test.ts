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
  assert.equal(decision.params.agent, "judge-agent");
  assert.match(decision.params.task, /Architect says A/);
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
