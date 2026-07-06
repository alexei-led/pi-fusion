import assert from "node:assert/strict";
import {
  FUSION_RUN_ENTRY_TYPE,
  FusionRunStore,
  FusionRunStoreError,
  readFusionRunSummaries,
  readLastFusionRunSummary,
  type FusionTerminalPhase,
} from "../run-store.js";

await test("FusionRunStore starts one active run at a time", () => {
  const store = new FusionRunStore({
    idFactory: () => "run-1",
    now: () => 10,
  });

  const run = store.startRun({ prompt: "compare", profileName: "quality" });

  assert.equal(run.id, "run-1");
  assert.equal(run.phase, "panel");
  assert.equal(run.createdAt, 10);
  assert.equal(run.updatedAt, 10);
  assert.equal(store.getActiveRun()?.id, "run-1");
  assert.throws(
    () => store.startRun({ prompt: "again", profileName: "quality" }),
    FusionRunStoreError,
  );
});

await test("FusionRunStore updates active run fields", () => {
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

await test("FusionRunStore persists done, failed, and cancelled transitions", () => {
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
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.customType, FUSION_RUN_ENTRY_TYPE);
    assert.deepEqual(entries[0]?.data, store.getLastRunSummary());
  }
});

await test("FusionRunStore convenience terminal helpers use transition phases", () => {
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

await test("fusion run summary restore helpers read the latest valid session entry", () => {
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

async function test(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error: unknown) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
