import assert from "node:assert/strict";
import test from "node:test";
import {
  FUSION_RUN_ENTRY_TYPE,
  FusionRunStore,
  FusionRunStoreError,
  readFusionRunStates,
  readFusionRunSummaries,
  readLastFusionRunState,
  readLastFusionRunSummary,
  type FusionTerminalPhase,
} from "../../src/run-store.js";

test("FusionRunStore starts one active run at a time", () => {
  const store = new FusionRunStore({
    idFactory: () => "run-1",
    now: () => 10,
  });

  const run = store.startRun({ prompt: "compare", profileName: "quality" });

  assert.equal(run.id, "run-1");
  assert.equal(run.phase, "chain");
  assert.equal(run.createdAt, 10);
  assert.equal(run.updatedAt, 10);
  assert.equal(store.getActiveRun()?.id, "run-1");
  assert.throws(
    () => store.startRun({ prompt: "again", profileName: "quality" }),
    FusionRunStoreError,
  );
});

test("FusionRunStore leaves no in-memory run after initial persistence fails", () => {
  const persistenceError = new Error("persistence unavailable");
  let appendAttempts = 0;
  let id = 0;
  const store = new FusionRunStore({
    idFactory: () => `run-${++id}`,
    persistence: {
      appendEntry: () => {
        appendAttempts++;
        if (appendAttempts === 1) throw persistenceError;
      },
    },
  });

  assert.throws(
    () =>
      store.startRun({
        prompt: "first",
        profileName: "quality",
        operationId: "operation-1",
      }),
    (error) => error === persistenceError,
  );
  assert.equal(store.getActiveRun(), undefined);
  assert.equal(store.getRunById("run-1"), undefined);
  assert.equal(store.getRunByOperationId("operation-1"), undefined);

  const laterRun = store.startRun({
    prompt: "later",
    profileName: "quality",
    operationId: "operation-1",
  });
  assert.equal(laterRun.id, "run-2");
  assert.equal(store.getActiveRun()?.id, "run-2");
  assert.equal(store.getRunByOperationId("operation-1")?.id, "run-2");
});

test("FusionRunStore updates active run fields", () => {
  let clock = 20;
  const store = new FusionRunStore({
    idFactory: () => "run-1",
    now: () => ++clock,
  });
  store.startRun({ prompt: "compare", profileName: "quality", createdAt: 20 });

  const updated = store.updateRun("run-1", {
    phase: "judge",
    panelRunId: "panel-1",
    judgeRunId: "judge-1",
  });

  assert.equal(updated.phase, "judge");
  assert.equal(updated.panelRunId, "panel-1");
  assert.equal(updated.judgeRunId, "judge-1");
  assert.equal(updated.updatedAt, 21);
  assert.equal(store.getActiveRun()?.phase, "judge");
  assert.throws(() => store.updateRun("missing", {}), /not active/);
});

test("FusionRunStore persists done, failed, and cancelled transitions", () => {
  const phases: FusionTerminalPhase[] = ["done", "failed", "cancelled"];

  for (const phase of phases) {
    const entries: Array<{ customType: string; data?: unknown }> = [];
    const store = new FusionRunStore({
      idFactory: () => `run-${phase}`,
      now: () => 30,
      persistence: {
        appendEntry: (customType, data) => entries.push({ customType, data }),
      },
    });
    const run = store.startRun({ prompt: phase, profileName: "quality" });

    const finished = store.transitionRun(run.id, phase, {
      ...(phase === "done" ? { report: "report" } : {}),
      ...(phase === "failed" ? { error: "boom" } : {}),
      updatedAt: 40,
    });

    assert.equal(finished.phase, phase);
    assert.equal(finished.updatedAt, 40);
    assert.equal(store.getActiveRun(), undefined);
    assert.equal(store.getLastRunSummary()?.phase, phase);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.customType, FUSION_RUN_ENTRY_TYPE);
    assert.equal(entries[1]?.customType, FUSION_RUN_ENTRY_TYPE);
    assert.deepEqual(entries[1]?.data, store.getLastRunSummary());
  }
});

test("FusionRunStore persists deferred failed-slot recovery metadata", () => {
  const entries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
  const store = new FusionRunStore({
    idFactory: () => "run-recovery",
    persistence: { appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) },
  });
  store.startRun({ prompt: "compare", profileName: "quality" });
  store.failRun("run-recovery", {
    recovery: { retryDeferred: true, failedPanelIndices: [1, 3] },
    error: "two panelists failed",
  });

  assert.deepEqual(store.getLastRunSummary()?.recovery, {
    retryDeferred: true,
    failedPanelIndices: [1, 3],
  });
  const restored = new FusionRunStore();
  restored.restoreFromEntries(entries);
  assert.deepEqual(restored.getLastRunSummary()?.recovery?.failedPanelIndices, [1, 3]);
});

test("FusionRunStore persists panel stop and judge observations", () => {
  const entries: Array<{ type: "custom"; customType: string; data?: unknown }> =
    [];
  const store = new FusionRunStore({
    idFactory: () => "run-active",
    now: () => 10,
    persistence: {
      appendEntry: (customType, data) =>
        entries.push({ type: "custom", customType, data }),
    },
  });

  store.startRun({ prompt: "compare", profileName: "quality", phase: "panel" });
  store.updateRun("run-active", {
    panelRunId: "panel-1",
    panelAsyncDir: "/tmp/panel-1",
    panelStopReason: "agreement",
    panelStoppedIndices: [2],
    panelOutputs: [
      {
        index: 0,
        agent: "panel",
        output: "Choose A.",
        model: "anthropic/observed",
        configuredModel: "openai/requested",
      },
    ],
    judgeObservation: {
      model: "ollama/qwen",
      durationMs: 500,
      usage: { inputTokens: 20, outputTokens: 10, costUsd: 0 },
    },
  });

  const restoredStore = new FusionRunStore();
  restoredStore.restoreFromEntries(entries);
  const restored = restoredStore.getActiveRun();
  assert.equal(restored?.panelAsyncDir, "/tmp/panel-1");
  assert.equal(restored?.panelStopReason, "agreement");
  assert.deepEqual(restored?.panelStoppedIndices, [2]);
  assert.equal(
    restored?.panelOutputs?.[0]?.configuredModel,
    "openai/requested",
  );
  assert.deepEqual(restored?.judgeObservation?.usage, {
    inputTokens: 20,
    outputTokens: 10,
    costUsd: 0,
  });
});

test("FusionRunStore restores durable run and operation lookups across history", () => {
  const entries: Array<{ type: "custom"; customType: string; data?: unknown }> =
    [];
  let id = 0;
  const store = new FusionRunStore({
    idFactory: () => `run-${++id}`,
    now: () => id,
    persistence: {
      appendEntry: (customType, data) =>
        entries.push({ type: "custom", customType, data }),
    },
  });

  const first = store.startRun({
    prompt: "first",
    profileName: "quality",
    operationId: "operation-1",
  });
  store.completeRun(first.id, { report: "first report" });
  const second = store.startRun({
    prompt: "second",
    profileName: "quality",
    operationId: "operation-2",
  });
  store.completeRun(second.id, { report: "second report" });

  const restored = new FusionRunStore();
  restored.restoreFromEntries(entries);

  assert.equal(restored.getRunById("run-1")?.report, "first report");
  assert.equal(restored.getRunByOperationId("operation-1")?.id, "run-1");
  assert.equal(restored.getRunByOperationId("operation-2")?.id, "run-2");
  assert.throws(
    () =>
      restored.startRun({
        prompt: "duplicate",
        profileName: "quality",
        operationId: "operation-1",
      }),
    /already has a run/,
  );
});

test("FusionRunStore persists and restores active run snapshots", () => {
  const entries: Array<{ type: "custom"; customType: string; data?: unknown }> =
    [];
  const store = new FusionRunStore({
    idFactory: () => "run-active",
    now: () => 10,
    persistence: {
      appendEntry: (customType, data) =>
        entries.push({ type: "custom", customType, data }),
    },
  });

  store.startRun({ prompt: "compare", profileName: "quality" });
  store.updateRun("run-active", { panelRunId: "panel-1" });

  assert.equal(entries.length, 2);
  assert.equal(readLastFusionRunState(entries)?.panelRunId, "panel-1");
  assert.deepEqual(
    readFusionRunStates(entries).map((state) => state.phase),
    ["chain", "chain"],
  );

  const restoredStore = new FusionRunStore();
  restoredStore.restoreFromEntries(entries);

  assert.equal(restoredStore.getActiveRun()?.id, "run-active");
  assert.equal(restoredStore.getActiveRun()?.panelRunId, "panel-1");
  assert.equal(restoredStore.getLastRunSummary(), undefined);
});

test("FusionRunStore convenience terminal helpers use transition phases", () => {
  const doneStore = new FusionRunStore({
    idFactory: () => "done",
    now: () => 1,
  });
  doneStore.startRun({ prompt: "done", profileName: "quality" });
  assert.equal(doneStore.completeRun("done").phase, "done");

  const failedStore = new FusionRunStore({
    idFactory: () => "failed",
    now: () => 1,
  });
  failedStore.startRun({ prompt: "failed", profileName: "quality" });
  assert.equal(
    failedStore.failRun("failed", { error: "boom" }).phase,
    "failed",
  );
  assert.equal(failedStore.getLastRunSummary()?.error, "boom");

  const cancelledStore = new FusionRunStore({
    idFactory: () => "cancelled",
    now: () => 1,
  });
  cancelledStore.startRun({ prompt: "cancelled", profileName: "quality" });
  assert.equal(cancelledStore.cancelRun("cancelled").phase, "cancelled");
});

test("FusionRunStore retains durable spawn intent and refuses a corrupt newest snapshot", () => {
  const entries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
  const store = new FusionRunStore({
    idFactory: () => "run-1",
    persistence: { appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) },
  });
  store.startRun({ prompt: "compare", profileName: "quality", phase: "panel" });
  store.updateRun("run-1", {
    spawnIntent: { stage: "panel", requestedAt: 42 },
  });
  assert.deepEqual(entries.at(-1)?.data, {
    ...store.getActiveRun(),
  });

  entries.push({ type: "custom", customType: FUSION_RUN_ENTRY_TYPE, data: { corrupt: true } });
  const restored = new FusionRunStore();
  restored.restoreFromEntries(entries);
  assert.equal(restored.getActiveRun(), undefined);
  assert.match(restored.getRestoreError() ?? "", /Latest persisted fusion run snapshot is invalid/);

  // The newest envelope is still a fusion entry when its data member was
  // never written; do not skip it and recover this older active snapshot.
  entries.push({ type: "custom", customType: FUSION_RUN_ENTRY_TYPE });
  const missingData = new FusionRunStore();
  missingData.restoreFromEntries(entries);
  assert.equal(missingData.getActiveRun(), undefined);
  assert.match(missingData.getRestoreError() ?? "", /Latest persisted fusion run snapshot is invalid/);
});

test("FusionRunStore refuses an untrusted malformed profile snapshot", () => {
  const entries = [
    {
      type: "custom",
      customType: FUSION_RUN_ENTRY_TYPE,
      data: {
        id: "run-1",
        prompt: "compare",
        profileName: "quality",
        phase: "panel",
        createdAt: 1,
        updatedAt: 1,
        profileSnapshot: {
          panel: [],
          judge: { agent: "judge-agent" },
          minimumSuccessfulPanelists: 1,
        },
      },
    },
  ];

  const store = new FusionRunStore();
  store.restoreFromEntries(entries);
  assert.equal(store.getActiveRun(), undefined);
  assert.match(store.getRestoreError() ?? "", /Latest persisted fusion run snapshot is invalid/);
});

test("FusionRunStore rejects snapshot slot bounds and contradictory quorum records", () => {
  const snapshot = {
    panel: [
      { id: "architect", agent: "panel-agent" },
      { id: "tester", agent: "panel-agent" },
    ],
    judge: { agent: "judge-agent" },
    minimumSuccessfulPanelists: 1,
  };
  const base = {
    id: "run-1",
    prompt: "compare",
    profileName: "quality",
    phase: "panel",
    panelRunId: "panel-1",
    createdAt: 1,
    updatedAt: 1,
    profileSnapshot: snapshot,
  };

  for (const invalidSlots of [
    { panelOutputs: [{ index: 2, agent: "panel-agent", output: "outside" }] },
    { panelFailures: [{ index: -1, agent: "panel-agent", summary: "negative" }] },
    { panelStoppedIndices: [0.5] },
    { recovery: { retryDeferred: true as const, failedPanelIndices: [2] } },
  ]) {
    const store = new FusionRunStore();
    store.restoreFromEntries([
      {
        type: "custom",
        customType: FUSION_RUN_ENTRY_TYPE,
        data: { ...base, ...invalidSlots },
      },
    ]);
    assert.equal(store.getActiveRun(), undefined);
    assert.match(store.getRestoreError() ?? "", /Latest persisted fusion run snapshot is invalid/);
  }

  const contradictory = new FusionRunStore();
  contradictory.restoreFromEntries([
    {
      type: "custom",
      customType: FUSION_RUN_ENTRY_TYPE,
      data: { ...base, minimumSuccessfulPanelists: "all" },
    },
  ]);
  assert.equal(contradictory.getActiveRun(), undefined);
  assert.match(contradictory.getRestoreError() ?? "", /Latest persisted fusion run snapshot is invalid/);
});

test("fusion run summary restore helpers read the latest valid session entry", () => {
  const entries = [
    { type: "custom", customType: "other", data: { id: "ignored" } },
    { type: "custom", customType: FUSION_RUN_ENTRY_TYPE, data: { bad: true } },
    {
      type: "custom",
      customType: FUSION_RUN_ENTRY_TYPE,
      data: {
        id: "first",
        prompt: "one",
        profileName: "quality",
        phase: "done",
        createdAt: 1,
        updatedAt: 2,
        report: "one report",
      },
    },
    {
      type: "custom",
      customType: FUSION_RUN_ENTRY_TYPE,
      data: {
        id: "second",
        prompt: "two",
        profileName: "fast",
        phase: "cancelled",
        createdAt: 3,
        updatedAt: 4,
      },
    },
  ];

  assert.deepEqual(
    readFusionRunSummaries(entries).map((summary) => summary.id),
    ["first", "second"],
  );
  assert.equal(readLastFusionRunSummary(entries)?.id, "second");

  const store = new FusionRunStore();
  const restored = store.restoreFromSession({
    sessionManager: { getEntries: () => entries },
  });

  assert.equal(restored?.id, "second");
  assert.equal(store.getLastRunSummary()?.profileName, "fast");
});
