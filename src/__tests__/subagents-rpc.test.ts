import assert from "node:assert/strict";
import {
  SUBAGENTS_RPC_REQUEST_CHANNEL,
  SubagentsRpcClient,
  SubagentsRpcRemoteError,
  SubagentsRpcTimeoutError,
  subagentsRpcReplyChannel,
  type SubagentsEventBus,
  type SubagentsRpcMethod,
} from "../subagents-rpc.js";

await test("SubagentsRpcClient resolves successful replies and cleans listeners", async () => {
  const bus = new FakeEventBus();
  const client = new SubagentsRpcClient({
    events: bus,
    requestId: () => "req-success",
    timeoutMs: 100,
  });

  const result = client.request("ping");
  const replyChannel = subagentsRpcReplyChannel("req-success");

  assert.equal(bus.listenerCount(replyChannel), 1);
  assert.deepEqual(bus.lastRequest(), {
    version: 1,
    requestId: "req-success",
    method: "ping",
    source: { extension: "pi-fusion" },
  });

  bus.emit(replyChannel, {
    version: 1,
    requestId: "req-success",
    method: "ping",
    success: true,
    data: { ok: true },
  });

  assert.deepEqual(await result, { ok: true });
  assert.equal(bus.listenerCount(replyChannel), 0);
});

await test("SubagentsRpcClient rejects failure replies and cleans listeners", async () => {
  const bus = new FakeEventBus();
  const client = new SubagentsRpcClient({
    events: bus,
    requestId: () => "req-failure",
    timeoutMs: 100,
  });

  const result = client.status({ id: "run-1" });
  const replyChannel = subagentsRpcReplyChannel("req-failure");

  bus.emit(replyChannel, {
    version: 1,
    requestId: "req-failure",
    method: "status",
    success: false,
    error: { code: "not_found", message: "missing run" },
  });

  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof SubagentsRpcRemoteError);
    assert.equal(error.code, "not_found");
    assert.equal(error.message, "missing run");
    assert.equal(error.method, "status");
    return true;
  });
  assert.equal(bus.listenerCount(replyChannel), 0);
});

await test("SubagentsRpcClient ignores wrong request IDs without cleanup", async () => {
  const bus = new FakeEventBus();
  const client = new SubagentsRpcClient({
    events: bus,
    requestId: () => "req-right",
    timeoutMs: 100,
  });

  const result = client.ping();
  const replyChannel = subagentsRpcReplyChannel("req-right");

  bus.emit(replyChannel, {
    version: 1,
    requestId: "req-wrong",
    method: "ping",
    success: true,
    data: { ignored: true },
  });

  assert.equal(bus.listenerCount(replyChannel), 1);

  bus.emit(replyChannel, {
    version: 1,
    requestId: "req-right",
    method: "ping",
    success: true,
    data: { ok: true },
  });

  assert.deepEqual(await result, { ok: true });
  assert.equal(bus.listenerCount(replyChannel), 0);
});

await test("SubagentsRpcClient times out and cleans listeners", async () => {
  const bus = new FakeEventBus();
  const client = new SubagentsRpcClient({
    events: bus,
    requestId: () => "req-timeout",
    timeoutMs: 100,
  });

  const result = client.ping({ timeoutMs: 1 });
  const replyChannel = subagentsRpcReplyChannel("req-timeout");

  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof SubagentsRpcTimeoutError);
    assert.equal(error.method, "ping");
    assert.equal(error.requestId, "req-timeout");
    return true;
  });
  assert.equal(bus.listenerCount(replyChannel), 0);
});

await test("SubagentsRpcClient helper methods emit typed method envelopes", async () => {
  const specs: Array<{
    method: SubagentsRpcMethod;
    params: unknown;
    run: (client: SubagentsRpcClient) => Promise<unknown>;
  }> = [
    {
      method: "spawn",
      params: { agent: "reviewer", task: "review" },
      run: (client) => client.spawn({ agent: "reviewer", task: "review" }),
    },
    {
      method: "status",
      params: { id: "run-1" },
      run: (client) => client.status({ id: "run-1" }),
    },
    {
      method: "stop",
      params: { runId: "run-1" },
      run: (client) => client.stop({ runId: "run-1" }),
    },
    {
      method: "interrupt",
      params: { dir: "/tmp/run" },
      run: (client) => client.interrupt({ dir: "/tmp/run" }),
    },
  ];

  for (const spec of specs) {
    const bus = new FakeEventBus();
    const requestId = `req-${spec.method}`;
    const client = new SubagentsRpcClient({
      events: bus,
      requestId: () => requestId,
      timeoutMs: 100,
    });

    const result = spec.run(client);
    const request = bus.lastRequest();
    assert.equal(request.method, spec.method);
    assert.deepEqual(request.params, spec.params);

    bus.emit(subagentsRpcReplyChannel(requestId), {
      version: 1,
      requestId,
      method: spec.method,
      success: true,
      data: { method: spec.method },
    });

    assert.deepEqual(await result, { method: spec.method });
  }
});

class FakeEventBus implements SubagentsEventBus {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<
    string,
    Set<(payload: unknown) => void>
  >();

  on(event: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(event);
    };
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) handler(payload);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  lastRequest(): Record<string, unknown> {
    const event = this.emitted.findLast(
      (entry) => entry.event === SUBAGENTS_RPC_REQUEST_CHANNEL,
    );
    assert.ok(event, "expected a subagents RPC request event");
    assert.ok(isRecord(event.payload));
    return event.payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
