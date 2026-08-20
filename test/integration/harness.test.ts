import assert from "node:assert/strict";
import test from "node:test";
import {
  calls,
  createTestSession,
  says,
  when,
  type TestSession,
} from "@gaodes/pi-test-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  TINTINWEB_COMPLETED_EVENT,
  TINTINWEB_PING_CHANNEL,
  TINTINWEB_READY_EVENT,
  TINTINWEB_SPAWN_CHANNEL,
  NICOPREME_READY_EVENT,
  NICOPREME_REQUEST_CHANNEL,
  NICOPREME_ASYNC_COMPLETE_EVENT,
} from "../../src/subagent-adapter.js";
import { resolve } from "node:path";
import { subagentsRpcReplyChannel } from "../../src/subagents-rpc.js";

const EXTENSION_PATH = resolve(import.meta.dirname, "../../src/index.ts");

test("Harness Scenario 1: Extension discovers and registers start_fusion_review tool in real Pi session", async (t) => {
  const session: TestSession = await createTestSession({
    extensions: [EXTENSION_PATH],
    mockTools: {},
  });
  t.after(async () => {
    session.dispose();
  });

  // Verify start_fusion_review tool is registered and callable
  await session.run(
    when("Please run a fusion review on architecture", [
      calls("start_fusion_review", {
        prompt: "Review architecture design",
      }),
      says("Fusion review initiated."),
    ]),
  );

  const fusionToolCalls = session.events.toolCallsFor("start_fusion_review");
  assert.equal(fusionToolCalls.length, 1);
  assert.equal(fusionToolCalls[0]?.input?.prompt, "Review architecture design");
});

test("Harness Scenario 2: Playbook-driven panel and judge under Tintinweb protocol", async (t) => {
  const spawnedAgents: string[] = [];
  let capturedEvents: ExtensionAPI["events"] | undefined;

  const mockTintinwebExtension = (pi: ExtensionAPI) => {
    capturedEvents = pi.events;
    pi.events.on(TINTINWEB_PING_CHANNEL, (raw: unknown) => {
      const payload = raw as { requestId: string };
      pi.events.emit(`${TINTINWEB_PING_CHANNEL}:reply:${payload.requestId}`, {
        success: true,
        data: { version: 2 },
      });
    });

    pi.events.on(TINTINWEB_SPAWN_CHANNEL, (raw: unknown) => {
      const payload = raw as { requestId: string; type: string };
      const id = `tintin-${payload.type}-${spawnedAgents.length + 1}`;
      spawnedAgents.push(id);
      pi.events.emit(`${TINTINWEB_SPAWN_CHANNEL}:reply:${payload.requestId}`, {
        success: true,
        data: { id },
      });
    });

    // Announce Tintinweb readiness
    pi.events.emit(TINTINWEB_READY_EVENT, {});
  };

  const session: TestSession = await createTestSession({
    extensions: [EXTENSION_PATH],
    extensionFactories: [mockTintinwebExtension],
    mockTools: {},
  });
  t.after(async () => {
    session.dispose();
  });

  await session.run(
    when("Run fusion review with Tintinweb", [
      calls("start_fusion_review", {
        prompt: "Assess database performance",
      }),
      says("Review has started."),
    ]),
  );

  const results = session.events.toolResultsFor("start_fusion_review");
  assert.equal(results.length, 1);

  // 3 panelists spawned
  assert.equal(spawnedAgents.length, 3);

  // Emit panelist completion
  for (let i = 0; i < 3; i++) {
    capturedEvents?.emit(TINTINWEB_COMPLETED_EVENT, {
      id: spawnedAgents[i],
      type: "fusion-panelist",
      result: `Panelist ${i + 1} analysis: Excellent scalability.`,
    });
  }

  await new Promise((r) => setTimeout(r, 50));

  // Judge should now be spawned as the 4th agent
  assert.equal(spawnedAgents.length, 4);
  const judgeId = spawnedAgents[3];

  capturedEvents?.emit(TINTINWEB_COMPLETED_EVENT, {
    id: judgeId,
    type: "fusion-judge",
    result: "# Fusion Report\n\n## Summary\nAll panelists agree on scalability.",
  });

  await new Promise((r) => setTimeout(r, 50));
});

test("Harness Scenario 3: Playbook-driven panel and judge under Nicopreme protocol", async (t) => {
  const spawnedWorkflows: string[] = [];
  let capturedEvents: ExtensionAPI["events"] | undefined;

  const mockNicopremeExtension = (pi: ExtensionAPI) => {
    capturedEvents = pi.events;
    pi.events.on(NICOPREME_REQUEST_CHANNEL, (raw: unknown) => {
      const payload = raw as { requestId: string; method: string; params?: unknown };
      if (payload.method === "ping") {
        pi.events.emit(subagentsRpcReplyChannel(payload.requestId), {
          version: 1,
          requestId: payload.requestId,
          method: "ping",
          success: true,
          data: { ok: true },
        });
      } else if (payload.method === "spawn") {
        const runId = `nico-workflow-${spawnedWorkflows.length + 1}`;
        spawnedWorkflows.push(runId);
        pi.events.emit(subagentsRpcReplyChannel(payload.requestId), {
          version: 1,
          requestId: payload.requestId,
          method: "spawn",
          success: true,
          data: { details: { runId, asyncDir: `/tmp/${runId}` } },
        });
      } else if (payload.method === "status" || payload.method === "stop") {
        pi.events.emit(subagentsRpcReplyChannel(payload.requestId), {
          version: 1,
          requestId: payload.requestId,
          method: payload.method,
          success: true,
          data: { ok: true },
        });
      }
    });

    pi.events.emit(NICOPREME_READY_EVENT, {});
  };

  const session: TestSession = await createTestSession({
    extensions: [EXTENSION_PATH],
    extensionFactories: [mockNicopremeExtension],
    mockTools: {},
  });
  t.after(async () => {
    session.dispose();
  });

  await session.run(
    when("Run fusion review with Nicopreme", [
      calls("start_fusion_review", {
        prompt: "Review system caching",
      }),
      says("Workflow spawned."),
    ]),
  );

  assert.equal(spawnedWorkflows.length, 1);
  const panelWorkflowId = spawnedWorkflows[0];

  capturedEvents?.emit(NICOPREME_ASYNC_COMPLETE_EVENT, {
    runId: panelWorkflowId,
    state: "complete",
    results: [
      { agent: "pi-fusion.fusion-panelist", success: true, output: "Use Redis." },
      { agent: "pi-fusion.fusion-panelist", success: true, output: "Use Redis cluster." },
      { agent: "pi-fusion.fusion-panelist", success: true, output: "Redis handles load." },
    ],
  });

  await new Promise((r) => setTimeout(r, 50));

  // Judge workflow spawned
  assert.equal(spawnedWorkflows.length, 2);
  const judgeWorkflowId = spawnedWorkflows[1];

  capturedEvents?.emit(NICOPREME_ASYNC_COMPLETE_EVENT, {
    runId: judgeWorkflowId,
    state: "complete",
    results: [
      {
        agent: "pi-fusion.fusion-judge",
        success: true,
        output: "# Fusion Report\n\n## Summary\nRedis is selected.",
      },
    ],
  });

  await new Promise((r) => setTimeout(r, 50));
});

test("Harness Scenario 4: Auto-detection priority and fallback edge cases", async (t) => {
  let nicoPingReceived = false;

  const mockBothExtension = (pi: ExtensionAPI) => {
    pi.events.on(NICOPREME_REQUEST_CHANNEL, (raw: unknown) => {
      const payload = raw as { requestId: string; method: string };
      if (payload.method === "ping") {
        nicoPingReceived = true;
        pi.events.emit(subagentsRpcReplyChannel(payload.requestId), {
          version: 1,
          requestId: payload.requestId,
          method: "ping",
          success: true,
          data: { ok: true },
        });
      } else if (payload.method === "spawn") {
        pi.events.emit(subagentsRpcReplyChannel(payload.requestId), {
          version: 1,
          requestId: payload.requestId,
          method: "spawn",
          success: true,
          data: { details: { runId: "nico-priority-1" } },
        });
      }
    });

    // Emit both readiness signals
    pi.events.emit(TINTINWEB_READY_EVENT, {});
    pi.events.emit(NICOPREME_READY_EVENT, {});
  };

  const session: TestSession = await createTestSession({
    extensions: [EXTENSION_PATH],
    extensionFactories: [mockBothExtension],
    mockTools: {},
  });
  t.after(async () => {
    session.dispose();
  });

  await session.run(
    when("Test priority", [
      calls("start_fusion_review", {
        prompt: "Priority check",
      }),
      says("Started."),
    ]),
  );

  assert.equal(nicoPingReceived, true);
});
