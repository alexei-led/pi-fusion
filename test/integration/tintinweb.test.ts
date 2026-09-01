import assert from "node:assert/strict";
import test from "node:test";
import fusionExtension from "../../src/index.js";
import {
  TINTINWEB_COMPLETED_EVENT,
  TINTINWEB_PING_CHANNEL,
  TINTINWEB_READY_EVENT,
  TINTINWEB_SPAWN_CHANNEL,
  TINTINWEB_STOP_CHANNEL,
  TintinwebAdapter,
} from "../../src/subagent-adapter.js";
import { FusionOrchestrator } from "../../src/orchestrator.js";
import { createProjectDir, FakePi, nextTick } from "../support/fake-pi.js";

test("FusionOrchestrator runs full 3-panelist + judge deliberation with TintinwebAdapter", async (t) => {
  const cwd = await createProjectDir(t);
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);

  const adapter = new TintinwebAdapter({ events: pi.events, timeoutMs: 500 });
  const messages: Array<{ customType: string; content: string }> = [];
  const orchestrator = new FusionOrchestrator({
    adapter,
    sendMessage: (msg) => messages.push(msg),
  });

  const spawnedAgents: Array<{ id: string; type: string; prompt: string }> = [];

  pi.events.on(TINTINWEB_PING_CHANNEL, (raw) => {
    const payload = raw as { requestId: string };
    pi.events.emit(`${TINTINWEB_PING_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
      data: { version: 2 },
    });
  });

  pi.events.on(TINTINWEB_SPAWN_CHANNEL, (raw) => {
    const payload = raw as {
      requestId: string;
      type: string;
      prompt: string;
      options?: object;
    };
    const id = `tintin-agent-${spawnedAgents.length + 1}`;
    spawnedAgents.push({ id, type: payload.type, prompt: payload.prompt });
    pi.events.emit(`${TINTINWEB_SPAWN_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
      data: { id },
    });
  });

  const startResult = await orchestrator.startRun("Choose between Postgres and SQLite", ctx);
  assert.equal(startResult.status, "started");
  assert.equal(spawnedAgents.length, 3); // 3 panelists spawned in parallel

  // Emit completions for all 3 panelists
  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: spawnedAgents[0]?.id,
    type: spawnedAgents[0]?.type,
    result: "Architect: Postgres offers better concurrent write throughput.",
  });
  await nextTick();

  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: spawnedAgents[1]?.id,
    type: spawnedAgents[1]?.type,
    result: "Implementer: Postgres has rich data types and jsonb support.",
  });
  await nextTick();

  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: spawnedAgents[2]?.id,
    type: spawnedAgents[2]?.type,
    result: "Tester: Postgres handles multi-connection transactions cleanly.",
  });
  await nextTick();

  // After 3 panelists finish, judge should have been spawned
  assert.equal(spawnedAgents.length, 4);
  const judgeAgent = spawnedAgents[3];
  assert.ok(judgeAgent);
  assert.match(judgeAgent.prompt, /Original task:/);

  // Emit judge completion
  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: judgeAgent.id,
    type: judgeAgent.type,
    result: "# Fusion Report\n\n## Summary\nPostgres is unanimously recommended.",
  });
  await nextTick();

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.customType, "fusion-report");
  assert.match(messages[0]?.content ?? "", /Postgres is unanimously recommended/);
});

test("FusionOrchestrator handles early panel agreement stop with TintinwebAdapter", async (t) => {
  const cwd = await createProjectDir(t);
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);

  const stoppedAgentIds: string[] = [];
  pi.events.on(TINTINWEB_PING_CHANNEL, (raw) => {
    const payload = raw as { requestId: string };
    pi.events.emit(`${TINTINWEB_PING_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
      data: { version: 2 },
    });
  });

  const spawnedAgents: Array<{ id: string; type: string }> = [];
  pi.events.on(TINTINWEB_SPAWN_CHANNEL, (raw) => {
    const payload = raw as { requestId: string; type: string };
    const id = `tintin-agent-${spawnedAgents.length + 1}`;
    spawnedAgents.push({ id, type: payload.type });
    pi.events.emit(`${TINTINWEB_SPAWN_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
      data: { id },
    });
  });

  pi.events.on(TINTINWEB_STOP_CHANNEL, (raw) => {
    const payload = raw as { requestId: string; agentId: string };
    stoppedAgentIds.push(payload.agentId);
    pi.events.emit(`${TINTINWEB_STOP_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
    });
  });

  const adapter = new TintinwebAdapter({ events: pi.events });
  const messages: Array<{ customType: string; content: string }> = [];
  const orchestrator = new FusionOrchestrator({
    adapter,
    sendMessage: (msg) => messages.push(msg),
    loadConfig: async () => ({
      defaultProfile: "early-stop",
      profiles: {
        "early-stop": {
          panel: [
            { id: "p1", agent: "fusion-panelist" },
            { id: "p2", agent: "fusion-panelist" },
            { id: "p3", agent: "fusion-panelist" },
          ],
          judge: { agent: "fusion-judge" },
          stopWhenPanelAgrees: true,
        },
      },
    }),
  });

  await orchestrator.startRun("Which database?", ctx);
  assert.equal(spawnedAgents.length, 3);

  // Panelist 1 and Panelist 2 agree with high confidence
  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: spawnedAgents[0]?.id,
    type: spawnedAgents[0]?.type,
    result: "Use Postgres.\n<fusion-panel-decision>{\"recommendation\":\"Postgres\",\"confidence\":\"high\",\"needsMoreEvidence\":false}</fusion-panel-decision>",
  });
  await nextTick();

  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: spawnedAgents[1]?.id,
    type: spawnedAgents[1]?.type,
    result: "Use Postgres.\n<fusion-panel-decision>{\"recommendation\":\"Postgres\",\"confidence\":\"high\",\"needsMoreEvidence\":false}</fusion-panel-decision>",
  });
  await nextTick();

  // Panelist 3 should have been stopped
  assert.ok(stoppedAgentIds.includes(spawnedAgents[2]?.id ?? ""));

  // Judge should have been spawned
  assert.equal(spawnedAgents.length, 4);

  // Judge completes
  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: spawnedAgents[3]?.id,
    type: spawnedAgents[3]?.type,
    result: "# Fusion Report\n\n## Summary\nAgreed on Postgres.",
  });
  await nextTick();

  assert.equal(messages.length, 1);
  assert.match(messages[0]?.content ?? "", /Agreed on Postgres/);
});

test("FusionOrchestrator handles cancellation under TintinwebAdapter", async (t) => {
  const cwd = await createProjectDir(t);
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);

  const stoppedAgentIds: string[] = [];
  pi.events.on(TINTINWEB_PING_CHANNEL, (raw) => {
    const payload = raw as { requestId: string };
    pi.events.emit(`${TINTINWEB_PING_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
      data: { version: 2 },
    });
  });

  const spawnedAgents: Array<{ id: string; type: string }> = [];
  pi.events.on(TINTINWEB_SPAWN_CHANNEL, (raw) => {
    const payload = raw as { requestId: string; type: string };
    const id = `tintin-agent-${spawnedAgents.length + 1}`;
    spawnedAgents.push({ id, type: payload.type });
    pi.events.emit(`${TINTINWEB_SPAWN_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
      data: { id },
    });
  });

  pi.events.on(TINTINWEB_STOP_CHANNEL, (raw) => {
    const payload = raw as { requestId: string; agentId: string };
    stoppedAgentIds.push(payload.agentId);
    pi.events.emit(`${TINTINWEB_STOP_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
    });
  });

  const adapter = new TintinwebAdapter({ events: pi.events });
  const orchestrator = new FusionOrchestrator({ adapter });

  await orchestrator.startRun("Long running task", ctx);
  assert.equal(spawnedAgents.length, 3);

  const cancelResult = await orchestrator.cancelActiveRun(ctx);
  assert.equal(cancelResult.status, "cancelled");
  assert.equal(stoppedAgentIds.length, 3);
});

test("fusionExtension integration with Tintinweb subagents via AutoDetectingAdapter", async (t) => {
  const cwd = await createProjectDir(t);
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);

  // Set mode to tintinweb on event bus
  pi.events.mode = "tintinweb";

  fusionExtension(pi.asExtensionApi());
  await pi.emitLifecycle("session_start", {}, ctx);

  // Announce Tintinweb readiness
  pi.events.emit(TINTINWEB_READY_EVENT, {});
  await nextTick();

  await pi.runCommand("fusion", "evaluate architecture", ctx);

  // 3 panelists spawned
  assert.equal(pi.events.spawns.length, 3);

  // Emit completion for panelist 1, 2, 3
  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: "panel-1",
    type: "fusion-panelist",
    result: "Panelist 1: Architecture is sound.",
  });
  await nextTick();

  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: "panel-2",
    type: "fusion-panelist",
    result: "Panelist 2: Architecture scales well.",
  });
  await nextTick();

  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: "panel-3",
    type: "fusion-panelist",
    result: "Panelist 3: Architecture is reliable.",
  });
  await nextTick();

  // Judge spawned as 4th spawn
  assert.equal(pi.events.spawns.length, 4);

  pi.events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: "judge-4",
    type: "fusion-judge",
    result: "# Fusion Report\n\n## Summary\nArchitecture is approved.",
  });
  await nextTick();

  assert.equal(pi.messages.at(-1)?.customType, "fusion-report");
  assert.match(pi.messages.at(-1)?.content ?? "", /Architecture is approved/);
});
