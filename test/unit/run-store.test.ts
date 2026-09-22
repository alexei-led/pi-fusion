import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableRunConflictError, DurableRunSnapshotStore, durableSnapshotFileName } from "../../src/durable-run-store.js";
import { requestDigest } from "../../src/runtime-contract.js";
import {
  FUSION_RUN_ENTRY_TYPE,
  FusionRunConflictError,
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

test("stale constructors cannot overwrite an atomically published run identity", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fusion-atomic-construction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new FusionRunStore({ directory });
  const stale = new FusionRunStore({ directory });
  const run = first.startRun({ id: "same-run", prompt: "Frozen", profileName: "quality" });
  first.updateRun(run.id, { cancellationRequested: true });
  assert.throws(() => stale.startRun({ id: "same-run", prompt: "Changed", profileName: "changed" }), /already active/);
  const saved = new FusionRunStore({ directory }).getRunById(run.id);
  assert.equal(saved?.prompt, "Frozen");
  assert.equal(saved?.cancellationRequested, true);
});

test("terminal admission survives snapshot failure and fences stale writers and sessions", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fusion-terminal-admission-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new FusionRunStore({ directory, now: () => 10 });
  const run = first.startRun({ id: "first", prompt: "Frozen", profileName: "quality" });
  const stale = new FusionRunStore({ directory, now: () => 100 });
  const writer = new DurableRunSnapshotStore(directory);
  const write = writer.write.bind(writer);
  const fault = t.mock.method(DurableRunSnapshotStore.prototype, "write", (key: string, data: unknown, exclusive?: boolean, expected?: unknown) => {
    if (key === run.id) throw new Error("crash after terminal admission");
    write(key, data, exclusive, expected);
  });
  assert.throws(() => first.cancelRun(run.id, { report: "cancelled" }), /crash after terminal/);
  fault.mock.restore();
  assert.throws(
    () => stale.updateRun(run.id, { panelRunId: "stale-worker", updatedAt: 999 }),
    FusionRunConflictError,
  );
  const restarted = new FusionRunStore({ directory });
  assert.equal(restarted.getActiveRun(), undefined);
  assert.equal(restarted.getRunById(run.id)?.phase, "cancelled");
  restarted.restoreFromEntries([{ type: "custom", customType: FUSION_RUN_ENTRY_TYPE, data: { ...run, updatedAt: 1000 } }]);
  assert.equal(restarted.getActiveRun(), undefined);
  assert.equal(restarted.getRunById(run.id)?.phase, "cancelled");
  const next = restarted.startRun({ id: "next", prompt: "Next", profileName: "quality" });
  assert.equal(new FusionRunStore({ directory }).getActiveRun()?.id, next.id);
  assert.throws(
    () => stale.completeRun(run.id, { report: "stale success" }),
    /No active fusion run/,
  );
  const fenced = new FusionRunStore({ directory });
  assert.equal(fenced.getRunById(run.id)?.phase, "cancelled");
  assert.equal(fenced.getRunById(run.id)?.report, "cancelled");
  assert.equal(fenced.getActiveRun()?.id, next.id);
});

test("revision compaction keeps one tip snapshot per run", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fusion-revision-compaction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new FusionRunStore({ directory, idFactory: () => "run", now: () => 1 });
  const run = store.startRun({ prompt: "compare", profileName: "quality" });
  for (let index = 0; index < 25; index += 1)
    store.updateRun(run.id, { panelRunId: `panel-${index}`, updatedAt: index + 2 });
  const revisions = readdirSync(join(directory, ".revisions", durableSnapshotFileName(run.id)));
  assert.deepEqual(revisions, ["25.json"]);
  const restored = new FusionRunStore({ directory });
  assert.equal(restored.getRunById(run.id)?.updatedAt, 26);
  assert.equal(restored.getRunById(run.id)?.panelRunId, "panel-24");
});

for (const successor of ["chained", "unrelated"] as const) {
  test(`recreating a compacted revision is ${successor === "chained" ? "accepted" : "rejected"} from its successor`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "fusion-revision-recreate-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new DurableRunSnapshotStore(directory);
    const base = { id: "race", prompt: "compare", profileName: "quality", phase: "panel", createdAt: 1, updatedAt: 1 };
    store.write("race", base);
    const first = { ...base, updatedAt: 2 };
    store.write("race", first, false, base);
    const revisionDirectory = join(directory, ".revisions", durableSnapshotFileName("race"));
    const stale = { ...base, updatedAt: 3 };
    const internal = store as unknown as { readRevision: (key: string) => { data: unknown; sequence: number; previous?: string } | undefined };
    const original = internal.readRevision.bind(store);
    let calls = 0;
    internal.readRevision = (key: string) => {
      const tip = original(key);
      if (++calls === 1) {
        // Peers advance past this write and compact away the file it recreates.
        writeFileSync(join(revisionDirectory, "3.json"), `${JSON.stringify({
          version: 1, key, sequence: 3,
          previous: successor === "chained" ? requestDigest(stale) : "another-write",
          data: { ...base, updatedAt: 9 },
        })}\n`);
      }
      return tip;
    };
    if (successor === "chained") store.write("race", stale, false, first);
    else assert.throws(() => store.write("race", stale, false, first), DurableRunConflictError);
  });
}

test("an older unfinished legacy snapshot is never hidden by a newer terminal run", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fusion-legacy-active-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writer = new DurableRunSnapshotStore(directory);
  writer.write("older", { id: "older", prompt: "Old", profileName: "quality", phase: "panel", createdAt: 1, updatedAt: 1 });
  writer.write("newer", { id: "newer", prompt: "New", profileName: "quality", phase: "done", createdAt: 2, updatedAt: 2 });
  const store = new FusionRunStore({ directory });
  assert.equal(store.getActiveRun()?.id, "older");
  assert.throws(() => store.startRun({ prompt: "Another", profileName: "quality" }), /already active/);
  store.cancelRun("older", { report: "Cancelled old run" });
  assert.equal(new FusionRunStore({ directory }).getRunById("older")?.phase, "cancelled");
});

test("an aliased active snapshot cannot override an immutable terminal identity", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fusion-aliased-snapshot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new FusionRunStore({ directory });
  const run = store.startRun({ id: "run", prompt: "Review", profileName: "quality" });
  store.cancelRun(run.id, { report: "cancelled" });
  writeFileSync(join(directory, "zzz.json"), JSON.stringify({ ...run, updatedAt: run.updatedAt + 1_000 }));
  const restored = new FusionRunStore({ directory });
  assert.equal(restored.getActiveRun(), undefined);
  assert.match(restored.getRestoreError() ?? "", /filename does not match/);
});

test("unknown unfinished runs and malformed admission chains fail closed", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fusion-invalid-admission-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new FusionRunStore({ directory });
  store.startRun({ id: "admitted", prompt: "One", profileName: "quality" });
  const writer = new DurableRunSnapshotStore(directory);
  writer.write("unknown", { id: "unknown", prompt: "Other", profileName: "quality", phase: "panel", createdAt: 2, updatedAt: 2 });
  const conflicted = new FusionRunStore({ directory });
  assert.match(conflicted.getRestoreError() ?? "", /Multiple unfinished/);
  assert.equal(conflicted.getRunById("unknown")?.phase, "panel");
  assert.throws(() => conflicted.startRun({ prompt: "Another", profileName: "quality" }), /restore is blocked/);
  writer.finish("unknown", { id: "unknown", prompt: "Other", profileName: "quality", phase: "cancelled", createdAt: 2, updatedAt: 3 });
  conflicted.refreshDurable();
  assert.equal(conflicted.getRestoreError(), undefined);
  assert.equal(conflicted.getActiveRun()?.id, "admitted");
  writeFileSync(join(directory, ".admissions", `after-${durableSnapshotFileName("unknown")}`), JSON.stringify({ version: 1, key: "orphan", predecessor: "unknown", data: { id: "orphan" } }));
  assert.match(new FusionRunStore({ directory }).getRestoreError() ?? "", /Unreachable Fusion admission/);
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

test("FusionRunStore keeps project snapshots across sessions and restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-fusion-run-store-"));
  try {
    const first = new FusionRunStore({
      directory,
      idFactory: () => "project-run",
      now: () => 10,
    });
    const started = first.startRun({
      prompt: "compare",
      profileName: "quality",
      operationId: "operation-1",
      requestDigest: "digest-1",
      executionLifetime: { mode: "bounded", timeoutMs: 60_000 },
    });
    first.updateRun(started.id, {
      spawnIntent: {
        stage: "panel",
        requestedAt: 11,
        requestId: "request-1",
        requestDigest: "digest-1",
        params: { prompt: "compare", panel: ["one", "two"] },
      },
      processTerminalProof: { source: { state: "running" } },
      observation: { nested: { attempts: [1, 2] } },
    });

    const snapshotFiles = readdirSync(directory).filter((file) =>
      file.endsWith(".json"),
    );
    assert.equal(snapshotFiles.length, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, snapshotFiles[0]!), "utf8")),
      first.getActiveRun(),
    );

    const restarted = new FusionRunStore({ directory });
    assert.equal(restarted.getDirectory(), directory);
    assert.equal(restarted.getActiveRun()?.id, "project-run");
    assert.deepEqual(restarted.getRunByOperationId("operation-1"), {
      ...first.getActiveRun(),
    });

    restarted.restoreFromSession({ sessionManager: { getEntries: () => [] } });
    assert.equal(restarted.getActiveRun()?.id, "project-run");
    assert.deepEqual(restarted.getActiveRun()?.spawnIntent?.params, {
      prompt: "compare",
      panel: ["one", "two"],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FusionRunStore fails closed when a project snapshot is corrupt", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-fusion-run-store-"));
  try {
    const entries: Array<{ customType: string; data?: unknown }> = [];
    const original = new FusionRunStore({
      directory,
      idFactory: () => "project-run",
      persistence: {
        appendEntry: (customType, data) => entries.push({ customType, data }),
      },
    });
    original.startRun({ prompt: "compare", profileName: "quality" });

    const snapshotFile = readdirSync(directory).find((file) =>
      file.endsWith(".json"),
    );
    assert.ok(snapshotFile);
    writeFileSync(join(directory, snapshotFile), "{ corrupt", "utf8");

    const restored = new FusionRunStore({ directory });
    assert.equal(restored.getActiveRun(), undefined);
    assert.match(
      restored.getRestoreError() ?? "",
      /Latest persisted fusion run snapshot is invalid/,
    );

    restored.restoreFromSession({
      sessionManager: {
        getEntries: () =>
          entries.map((entry) => ({
            type: "custom",
            ...entry,
          })),
      },
    });
    assert.equal(restored.getActiveRun(), undefined);
    assert.match(
      restored.getRestoreError() ?? "",
      /Latest persisted fusion run snapshot is invalid/,
    );
    assert.throws(
      () => restored.startRun({ prompt: "new", profileName: "quality" }),
      /Cannot start a fusion run while restore is blocked/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("FusionRunStore refreshes newer project snapshots in a long-lived reader", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-fusion-run-store-"));
  try {
    const writer = new FusionRunStore({
      directory,
      idFactory: () => "project-run",
      now: () => 10,
    });
    writer.startRun({ prompt: "compare", profileName: "quality" });

    const reader = new FusionRunStore({ directory });
    writer.updateRun("project-run", {
      observation: { state: "running", attempt: 2 },
      updatedAt: 20,
    });
    assert.equal(reader.getActiveRun()?.updatedAt, 10);

    reader.refreshDurable();
    assert.equal(reader.getActiveRun()?.updatedAt, 20);
    assert.deepEqual(reader.getActiveRun()?.observation, {
      state: "running",
      attempt: 2,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
