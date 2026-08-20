import assert from "node:assert/strict";
import test from "node:test";
import {
  AutoDetectingAdapter,
  NICOPREME_ASYNC_COMPLETE_EVENT,
  NICOPREME_READY_EVENT,
  NICOPREME_REQUEST_CHANNEL,
  NicopremeAdapter,
  TINTINWEB_COMPLETED_EVENT,
  TINTINWEB_FAILED_EVENT,
  TINTINWEB_PING_CHANNEL,
  TINTINWEB_READY_EVENT,
  TINTINWEB_SPAWN_CHANNEL,
  TINTINWEB_STOP_CHANNEL,
  TintinwebAdapter,
  type SubagentCompletionResult,
  type SubagentsEventBus,
} from "../../src/subagent-adapter.js";
import { subagentsRpcReplyChannel } from "../../src/subagents-rpc.js";

class LocalTestEventBus implements SubagentsEventBus {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<
    string,
    Set<(payload: unknown) => void>
  >();

  on(event: string, handler: (payload: unknown) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => {
      set.delete(handler);
    };
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of [...set]) handler(payload);
    }
  }
}

test("NicopremeAdapter handles ping, spawn, stop, and onCompletion", async () => {
  const events = new LocalTestEventBus();
  events.on(NICOPREME_REQUEST_CHANNEL, (raw) => {
    const payload = raw as { requestId: string; method: string; params?: unknown };
    if (payload.method === "ping") {
      events.emit(subagentsRpcReplyChannel(payload.requestId), {
        version: 1,
        requestId: payload.requestId,
        method: "ping",
        success: true,
        data: { ok: true },
      });
    } else if (payload.method === "spawn") {
      events.emit(subagentsRpcReplyChannel(payload.requestId), {
        version: 1,
        requestId: payload.requestId,
        method: "spawn",
        success: true,
        data: { details: { runId: "nico-run-1", asyncDir: "/tmp/nico" } },
      });
    } else if (payload.method === "stop") {
      events.emit(subagentsRpcReplyChannel(payload.requestId), {
        version: 1,
        requestId: payload.requestId,
        method: "stop",
        success: true,
        data: { ok: true },
      });
    }
  });

  const adapter = new NicopremeAdapter({ events, timeoutMs: 500 });
  assert.equal(adapter.provider, "nicopreme");

  const pingResult = await adapter.ping();
  assert.equal(pingResult, true);

  const spawnResult = await adapter.spawn("fusion-panelist", "evaluate design", {
    model: "claude-3-7-sonnet:high",
  });
  assert.equal(spawnResult.runId, "nico-run-1");
  assert.equal(spawnResult.asyncDir, "/tmp/nico");

  const stopResult = await adapter.stop("nico-run-1");
  assert.equal(stopResult, true);

  let completionReceived: SubagentCompletionResult | undefined;
  const unsub = adapter.onCompletion("nico-run-1", (res) => {
    completionReceived = res;
  });

  events.emit(NICOPREME_ASYNC_COMPLETE_EVENT, {
    runId: "nico-run-1",
    result: "Design is approved.",
    output: "Design is approved.",
  });

  assert.ok(completionReceived);
  assert.equal(completionReceived?.runId, "nico-run-1");
  assert.equal(completionReceived?.success, true);
  assert.equal(completionReceived?.output, "Design is approved.");

  unsub();
});

test("TintinwebAdapter handles ping, spawn, stop, and onCompletion", async () => {
  const events = new LocalTestEventBus();
  events.on(TINTINWEB_PING_CHANNEL, (raw) => {
    const payload = raw as { requestId: string };
    events.emit(`${TINTINWEB_PING_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
      data: { version: 2 },
    });
  });
  events.on(TINTINWEB_SPAWN_CHANNEL, (raw) => {
    const payload = raw as { requestId: string; type: string; prompt: string; options?: object };
    events.emit(`${TINTINWEB_SPAWN_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
      data: { id: "tintin-agent-42" },
    });
  });
  events.on(TINTINWEB_STOP_CHANNEL, (raw) => {
    const payload = raw as { requestId: string; agentId: string };
    events.emit(`${TINTINWEB_STOP_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
    });
  });

  const adapter = new TintinwebAdapter({ events, timeoutMs: 500 });
  assert.equal(adapter.provider, "tintinweb");

  const pingResult = await adapter.ping();
  assert.equal(pingResult, true);

  const spawnResult = await adapter.spawn("fusion-panelist", "inspect code", {
    model: "gpt-4o",
    description: "Architect panelist",
  });
  assert.equal(spawnResult.runId, "tintin-agent-42");

  const stopResult = await adapter.stop("tintin-agent-42");
  assert.equal(stopResult, true);

  let successCompletion: SubagentCompletionResult | undefined;
  const unsubSuccess = adapter.onCompletion("tintin-agent-42", (res) => {
    successCompletion = res;
  });

  events.emit(TINTINWEB_COMPLETED_EVENT, {
    id: "tintin-agent-42",
    type: "fusion-panelist",
    result: "Analysis complete: all good.",
    tokens: { input: 100, output: 50, total: 150 },
    durationMs: 1200,
  });

  assert.ok(successCompletion);
  assert.equal(successCompletion?.runId, "tintin-agent-42");
  assert.equal(successCompletion?.success, true);
  assert.equal(successCompletion?.output, "Analysis complete: all good.");
  assert.equal(successCompletion?.durationMs, 1200);
  assert.equal(successCompletion?.tokens?.total, 150);

  unsubSuccess();

  let failCompletion: SubagentCompletionResult | undefined;
  const unsubFail = adapter.onCompletion("tintin-agent-error", (res) => {
    failCompletion = res;
  });

  events.emit(TINTINWEB_FAILED_EVENT, {
    id: "tintin-agent-error",
    type: "fusion-panelist",
    error: "Model rate limit exceeded",
    durationMs: 300,
  });

  assert.ok(failCompletion);
  assert.equal(failCompletion?.runId, "tintin-agent-error");
  assert.equal(failCompletion?.success, false);
  assert.equal(failCompletion?.error, "Model rate limit exceeded");

  unsubFail();
});

test("AutoDetectingAdapter selects Nicopreme on subagents:rpc:v1:ready", async () => {
  const events = new LocalTestEventBus();
  const adapter = new AutoDetectingAdapter({ events, timeoutMs: 200 });

  events.emit(NICOPREME_READY_EVENT, {});
  assert.equal(adapter.provider, "nicopreme");
});

test("AutoDetectingAdapter selects Tintinweb on subagents:ready when Nicopreme is absent", async () => {
  const events = new LocalTestEventBus();
  const adapter = new AutoDetectingAdapter({ events, timeoutMs: 200 });

  events.emit(TINTINWEB_READY_EVENT, {});
  assert.equal(adapter.provider, "tintinweb");
});

test("AutoDetectingAdapter defaults to Nicopreme when both announce ready", async () => {
  const events = new LocalTestEventBus();
  const adapter = new AutoDetectingAdapter({ events, timeoutMs: 200 });

  events.emit(TINTINWEB_READY_EVENT, {});
  events.emit(NICOPREME_READY_EVENT, {});
  assert.equal(adapter.provider, "nicopreme");
});

test("AutoDetectingAdapter probes and selects Tintinweb when only Tintinweb responds to ping", async () => {
  const events = new LocalTestEventBus();
  // Only Tintinweb ping is handled
  events.on(TINTINWEB_PING_CHANNEL, (raw) => {
    const payload = raw as { requestId: string };
    events.emit(`${TINTINWEB_PING_CHANNEL}:reply:${payload.requestId}`, {
      success: true,
      data: { version: 2 },
    });
  });

  const adapter = new AutoDetectingAdapter({ events, timeoutMs: 100 });
  const active = await adapter.resolveActiveAdapter();
  assert.equal(active.provider, "tintinweb");
  assert.equal(adapter.provider, "tintinweb");
});

test("AutoDetectingAdapter respects explicit provider configuration", async () => {
  const events = new LocalTestEventBus();
  const adapter = new AutoDetectingAdapter({
    events,
    provider: "tintinweb",
    timeoutMs: 200,
  });

  assert.equal(adapter.provider, "tintinweb");
});

test("AutoDetectingAdapter respects PI_FUSION_SUBAGENT_PROVIDER env var override", async () => {
  const events = new LocalTestEventBus();
  const prev = process.env.PI_FUSION_SUBAGENT_PROVIDER;
  try {
    process.env.PI_FUSION_SUBAGENT_PROVIDER = "tintinweb";
    const adapter = new AutoDetectingAdapter({ events, timeoutMs: 200 });
    assert.equal(adapter.provider, "tintinweb");
  } finally {
    if (prev === undefined) delete process.env.PI_FUSION_SUBAGENT_PROVIDER;
    else process.env.PI_FUSION_SUBAGENT_PROVIDER = prev;
  }
});
