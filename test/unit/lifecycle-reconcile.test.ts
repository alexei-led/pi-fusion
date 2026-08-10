import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePanelResults } from "../../src/lifecycle-reconcile.js";
import type {
  ExtractPanelResultsSuccess,
} from "../../src/result-extract.js";
import type { FusionProfile } from "../../src/types.js";

const PROFILE: FusionProfile = {
  panel: [
    { id: "architect", agent: "panel-agent" },
    { id: "tester", agent: "panel-agent" },
    { id: "operator", agent: "panel-agent" },
    { id: "skeptic", agent: "panel-agent" },
  ],
  judge: { agent: "judge-agent" },
};

const eventSuccesses = (outputs: string[]): ExtractPanelResultsSuccess => ({
  ok: true,
  outputs: outputs.map((output, index) => ({
    index,
    agent: "panel-agent",
    output,
  })),
  failures: [],
});

test("uses complete status steps to restore failures omitted by compact events", () => {
  const result = reconcilePanelResults(
    eventSuccesses(["operator", "skeptic"]),
    {
      steps: [
        { status: "failed", error: "Timed out" },
        { status: "failed", error: "Provider failed" },
        { status: "completed", output: "operator" },
        { status: "completed", output: "skeptic" },
        { status: "completed", output: "judge" },
      ],
    },
    PROFILE,
    { results: [{ output: "operator" }, { output: "skeptic" }] },
    { allowedTrailingResults: 1 },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.outputs.map(({ index }) => index), [2, 3]);
    assert.deepEqual(result.failures.map(({ index }) => index), [0, 1]);
  }
});

test("rejects an explicit empty terminal steps array", () => {
  const result = reconcilePanelResults(
    eventSuccesses(["a", "b", "c", "d"]),
    { steps: [] },
    PROFILE,
    { results: [{ output: "a" }, { output: "b" }, { output: "c" }, { output: "d" }] },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /status described 0 of 4/);
});

test("rejects extra status steps instead of truncating them", () => {
  const result = reconcilePanelResults(
    eventSuccesses(["a", "b", "c", "d"]),
    { steps: [{ status: "completed" }, { status: "completed" }, { status: "completed" }, { status: "completed" }, { status: "completed" }, { status: "completed" }] },
    PROFILE,
    { results: [{ output: "a" }, { output: "b" }, { output: "c" }, { output: "d" }] },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /contained 6 steps/);
});

test("rejects partial status even when the event looks complete", () => {
  const result = reconcilePanelResults(
    eventSuccesses(["a", "b", "c", "d"]),
    {
      steps: [
        { status: "completed", output: "a" },
        { status: "completed", output: "b" },
        { status: "running" },
      ],
    },
    PROFILE,
    { results: [{ output: "a" }, { output: "b" }, { output: "c" }, { output: "d" }] },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /status described 2 of 4/);
});

test("allows status gaps only for explicitly stopped panel members", () => {
  const result = reconcilePanelResults(
    {
      ...eventSuccesses(["a", "b"]),
      failures: [
        { index: 2, agent: "panel-agent", summary: "Stopped", reason: "stopped-after-agreement" },
        { index: 3, agent: "panel-agent", summary: "Stopped", reason: "stopped-after-agreement" },
      ],
    },
    {
      steps: [
        { status: "completed", output: "a" },
        { status: "completed", output: "b" },
      ],
    },
    PROFILE,
    { results: [{ output: "a" }, { output: "b" }] },
    { stoppedPanelIndices: [2, 3] },
  );

  assert.equal(result.ok, true);
});
