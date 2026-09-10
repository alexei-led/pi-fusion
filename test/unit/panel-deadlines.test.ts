import assert from "node:assert/strict";
import test from "node:test";
import { planPanelDeadlines } from "../../src/panel-deadlines.js";
import {
  buildPanelSpawnParams,
  resolveEffectiveTimeouts,
} from "../../src/run-builder.js";
import { FusionRunStore, FUSION_RUN_ENTRY_TYPE } from "../../src/run-store.js";
import type { FusionProfile, FusionRun } from "../../src/types.js";

const profile: FusionProfile = {
  panel: [
    { id: "one", agent: "panel" },
    { id: "two", agent: "panel" },
  ],
  judge: { agent: "judge" },
  concurrency: 2,
  panelistSoftTimeoutMs: 600_000,
  panelistTimeoutMs: 960_000,
  panelTimeoutMs: 2_100_000,
};
const run: FusionRun = {
  id: "fusion",
  prompt: "review",
  profileName: "quality",
  phase: "panel",
  createdAt: 1,
  updatedAt: 1,
  panelRunId: "workflow",
  effectiveTimeouts: resolveEffectiveTimeouts(profile),
  profileSnapshot: {
    panel: profile.panel,
    judge: profile.judge,
    minimumSuccessfulPanelists: 2,
  },
};
const child = {
  workflowKey: "panel-1",
  runId: "child-1",
  status: "running",
  startedAt: 10_000,
};

test("soft deadline uses child start time, not workflow queue time", () => {
  assert.deepEqual(planPanelDeadlines(run, [child], 609_999), []);
  const [ask] = planPanelDeadlines(run, [child], 610_000);
  assert.equal(ask?.kind, "ask");
  assert.equal(ask?.state.hardDeadlineAt, 970_000);
  const queuedLater = { ...child, startedAt: 600_000 };
  assert.deepEqual(planPanelDeadlines(run, [queuedLater], 610_000), []);
});

test("no reply requests finalization; a single continuation uses the reserved budget", () => {
  const state = planPanelDeadlines(run, [child], 610_000)[0]!.state;
  const pending = { ...run, panelDeadlines: [state] };
  assert.deepEqual(planPanelDeadlines(pending, [child], 669_999), []);
  assert.equal(
    planPanelDeadlines(pending, [child], 670_000)[0]?.kind,
    "finish",
  );
  const continued: FusionRun = {
    ...run,
    panelDeadlines: [{ ...state, status: "continued" }],
  };
  assert.deepEqual(planPanelDeadlines(continued, [child], 909_999), []);
  assert.equal(
    planPanelDeadlines(continued, [child], 910_000)[0]?.kind,
    "finish",
  );
  assert.deepEqual(planPanelDeadlines(continued, [child], 970_000), []);
});

test("deadline controls skip completed, replaced and ambiguous children", () => {
  const state = planPanelDeadlines(run, [child], 610_000)[0]!.state;
  for (const children of [
    [{ ...child, status: "completed" }],
    [{ ...child, workflowKey: "panel-3" }],
    [child, child],
    [{ ...child, runId: "replacement" }],
  ])
    assert.deepEqual(
      planPanelDeadlines(
        { ...run, panelDeadlines: [state] },
        children,
        700_000,
      ),
      [],
    );
});

test("deadline decisions survive restore without duplicate requests", () => {
  const state = planPanelDeadlines(run, [child], 610_000)[0]!.state;
  const stored = { ...run, panelDeadlines: [state] };
  const store = new FusionRunStore();
  store.restoreFromSession({
    sessionManager: {
      getEntries: () => [
        { type: "custom", customType: FUSION_RUN_ENTRY_TYPE, data: stored },
      ],
    },
  });
  const restored = store.getActiveRun()!;
  assert.deepEqual(restored.panelDeadlines, [state]);
  restored.panelDeadlines[0]!.status = "continued";
  assert.equal(store.getActiveRun()?.panelDeadlines?.[0]?.status, "pending");
  assert.deepEqual(
    planPanelDeadlines(store.getActiveRun()!, [child], 620_000),
    [],
  );
});

test("soft deadlines must leave a finalization reserve under effective caps", () => {
  assert.throws(
    () =>
      resolveEffectiveTimeouts({ ...profile, panelistSoftTimeoutMs: 900_000 }),
    /one minute/,
  );
  assert.throws(
    () => resolveEffectiveTimeouts(profile, { panelTimeoutMs: 610_000 }),
    /one minute/,
  );
  const tasks = buildPanelSpawnParams(profile, "review").workflowScript;
  assert.match(tasks, /Parent supervisor coordination is allowed/);
  assert.equal(resolveEffectiveTimeouts(profile).panelistTimeoutMs, 960_000);
});
