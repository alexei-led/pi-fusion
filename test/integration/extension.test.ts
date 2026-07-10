import assert from "node:assert/strict";
import test from "node:test";
import fusionExtension from "../../src/index.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/orchestrator.js";
import { FUSION_RUN_ENTRY_TYPE } from "../../src/run-store.js";
import { createProjectDir, FakePi, nextTick } from "../support/fake-pi.js";

test("fusionExtension registers documented commands", () => {
  const pi = new FakePi();

  fusionExtension(pi.asExtensionApi());

  assert.deepEqual([...pi.commands.keys()].sort(), ["fusion"]);
});

test("fusionExtension shows a short help message for bare /fusion", async (t) => {
  const pi = new FakePi();
  const ctx = pi.createContext(await createProjectDir(t));
  fusionExtension(pi.asExtensionApi());

  await pi.runCommand("fusion", "", ctx);

  assert.match(ctx.ui.notifications.at(-1)?.message ?? "", /Fusion commands/);
  assert.match(ctx.ui.notifications.at(-1)?.message ?? "", /\/fusion status/);
});

test("fusionExtension routes /fusion status through the simple command namespace", async (t) => {
  const pi = new FakePi();
  const ctx = pi.createContext(await createProjectDir(t));
  fusionExtension(pi.asExtensionApi());

  await pi.runCommand("fusion", "status", ctx);

  assert.equal(pi.messages.at(-1)?.customType, "fusion-status");
  assert.match(pi.messages.at(-1)?.content ?? "", /State: idle/);
});

test("fusionExtension starts and completes a run through pi-subagents RPC events", async (t) => {
  const pi = new FakePi();
  const ctx = pi.createContext(await createProjectDir(t));
  fusionExtension(pi.asExtensionApi());

  await pi.runCommand("fusion", "compare APIs", ctx);

  assert.match(ctx.ui.lastStatus("fusion") ?? "", /panel-1/);
  assert.equal(pi.entries.length, 2);
  assert.equal(pi.entries.at(-1)?.customType, FUSION_RUN_ENTRY_TYPE);

  pi.events.statusResults.set("panel-1", {
    runId: "panel-1",
    state: "complete",
    results: [
      {
        agent: "pi-fusion.fusion-panelist",
        success: true,
        output: "Choose A.",
      },
    ],
  });
  pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "panel-1" });
  await nextTick();

  assert.equal(pi.messages.at(-1)?.customType, "fusion-report");
  assert.match(pi.messages.at(-1)?.content ?? "", /Choose A/);
  assert.equal(ctx.ui.lastStatus("fusion"), undefined);
});

test("fusionExtension restores an active run on session_start and unsubscribes on shutdown", async (t) => {
  const cwd = await createProjectDir(t);
  const firstPi = new FakePi();
  const firstCtx = firstPi.createContext(cwd);
  fusionExtension(firstPi.asExtensionApi());
  await firstPi.runCommand("fusion", "compare APIs", firstCtx);

  const restoredPi = new FakePi(firstPi.entries);
  const restoredCtx = restoredPi.createContext(cwd);
  fusionExtension(restoredPi.asExtensionApi());

  await restoredPi.emitLifecycle("session_start", {}, restoredCtx);

  assert.match(restoredCtx.ui.lastStatus("fusion") ?? "", /panel-1/);

  restoredPi.events.statusResults.set("panel-1", {
    runId: "panel-1",
    state: "complete",
    results: [
      {
        agent: "pi-fusion.fusion-panelist",
        success: true,
        output: "Restored output.",
      },
    ],
  });
  restoredPi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "panel-1" });
  await nextTick();

  assert.match(restoredPi.messages.at(-1)?.content ?? "", /Restored output/);

  const listenerCountBeforeShutdown = restoredPi.events.listenerCount(
    SUBAGENT_ASYNC_COMPLETE_EVENT,
  );
  await restoredPi.emitLifecycle("session_shutdown", {}, restoredCtx);

  assert.equal(listenerCountBeforeShutdown, 1);
  assert.equal(
    restoredPi.events.listenerCount(SUBAGENT_ASYNC_COMPLETE_EVENT),
    0,
  );
  assert.equal(restoredCtx.ui.lastStatus("fusion"), undefined);
});
