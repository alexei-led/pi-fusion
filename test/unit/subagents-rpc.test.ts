import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  SUBAGENTS_RPC_REQUEST_CHANNEL,
  type SubagentsEventBus,
  SubagentsRpcClient,
  type SubagentsRpcMethod,
  SubagentsRpcProtocolError,
  SubagentsRpcRemoteError,
  SubagentsRpcTimeoutError,
  subagentsRpcReplyChannel,
} from '../../src/subagents-rpc.js';

test('SubagentsRpcClient resolves successful replies and cleans listeners', async () => {
  const bus = new FakeEventBus();
  const client = new SubagentsRpcClient({
    events: bus,
    requestId: () => 'req-success',
    timeoutMs: 100,
  });

  const result = client.request('ping');
  const replyChannel = subagentsRpcReplyChannel('req-success');

  assert.equal(bus.listenerCount(replyChannel), 1);
  assert.deepEqual(bus.lastRequest(), {
    version: 1,
    requestId: 'req-success',
    method: 'ping',
    source: { extension: 'pi-fusion' },
  });

  bus.emit(replyChannel, {
    version: 1,
    requestId: 'req-success',
    method: 'ping',
    success: true,
    data: { ok: true },
  });

  assert.deepEqual(await result, { ok: true });
  assert.equal(bus.listenerCount(replyChannel), 0);
});

test('SubagentsRpcClient rejects failure replies and cleans listeners', async () => {
  const bus = new FakeEventBus();
  const client = new SubagentsRpcClient({
    events: bus,
    requestId: () => 'req-failure',
    timeoutMs: 100,
  });

  const result = client.status({ id: 'run-1' });
  const replyChannel = subagentsRpcReplyChannel('req-failure');

  bus.emit(replyChannel, {
    version: 1,
    requestId: 'req-failure',
    method: 'status',
    success: false,
    error: { code: 'not_found', message: 'missing run' },
  });

  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof SubagentsRpcRemoteError);
    assert.equal(error.code, 'not_found');
    assert.equal(error.message, 'missing run');
    assert.equal(error.method, 'status');
    return true;
  });
  assert.equal(bus.listenerCount(replyChannel), 0);
});

test('SubagentsRpcClient ignores wrong request IDs without cleanup', async () => {
  const bus = new FakeEventBus();
  const client = new SubagentsRpcClient({
    events: bus,
    requestId: () => 'req-right',
    timeoutMs: 100,
  });

  const result = client.ping();
  const replyChannel = subagentsRpcReplyChannel('req-right');

  bus.emit(replyChannel, {
    version: 1,
    requestId: 'req-wrong',
    method: 'ping',
    success: true,
    data: { ignored: true },
  });

  assert.equal(bus.listenerCount(replyChannel), 1);

  bus.emit(replyChannel, {
    version: 1,
    requestId: 'req-right',
    method: 'ping',
    success: true,
    data: { ok: true },
  });

  assert.deepEqual(await result, { ok: true });
  assert.equal(bus.listenerCount(replyChannel), 0);
});

test('a timed-out request does not affect another in-flight request', async () => {
  vi.useFakeTimers();
  const bus = new FakeEventBus();
  const client = new SubagentsRpcClient({ events: bus });
  const timedOut = client.ping({ requestId: 'expired', timeoutMs: 10 });
  const waiting = client.ping({ requestId: 'waiting', timeoutMs: 100 });
  const expiredChannel = subagentsRpcReplyChannel('expired');
  const waitingChannel = subagentsRpcReplyChannel('waiting');

  const rejection = assert.rejects(timedOut, {
    name: SubagentsRpcTimeoutError.name,
    method: 'ping',
    requestId: 'expired',
    timeoutMs: 10,
  });
  await vi.advanceTimersByTimeAsync(10);
  await rejection;
  assert.equal(bus.listenerCount(expiredChannel), 0);
  assert.equal(bus.listenerCount(waitingChannel), 1);
  bus.emit(expiredChannel, {
    version: 1,
    requestId: 'expired',
    success: true,
    data: 'late',
  });
  bus.emit(waitingChannel, {
    version: 1,
    requestId: 'waiting',
    success: true,
    data: 'current',
  });
  assert.equal(await waiting, 'current');
  assert.equal(bus.listenerCount(waitingChannel), 0);
});

test.each([
  {
    name: 'unsupported version',
    reply: { version: 2 },
    error: /unsupported.*version/i,
  },
  {
    name: 'unexpected method',
    reply: { method: 'stop' },
    error: /did not match ping/,
  },
  {
    name: 'invalid success flag',
    reply: { success: 'true' },
    error: /success/,
  },
  {
    name: 'invalid error object',
    reply: { success: false, error: { code: 'missing-message' } },
    error: /code and message/,
  },
])(
  'rejects a matching reply with $name and removes its listener',
  async ({ reply, error }) => {
    const bus = new FakeEventBus();
    const client = new SubagentsRpcClient({ events: bus });
    const requestId = 'malformed';
    const channel = subagentsRpcReplyChannel(requestId);
    const pending = client.ping({ requestId });
    bus.emit(channel, { version: 1, requestId, success: true, ...reply });
    await assert.rejects(pending, (failure: unknown) => {
      assert.ok(failure instanceof SubagentsRpcProtocolError);
      assert.equal(failure.requestId, requestId);
      assert.match(failure.message, error);
      return true;
    });
    assert.equal(bus.listenerCount(channel), 0);
  },
);

test('SubagentsRpcClient helper methods emit typed method envelopes', async () => {
  const specs: Array<{
    method: SubagentsRpcMethod;
    params: unknown;
    run: (client: SubagentsRpcClient) => Promise<unknown>;
  }> = [
    {
      method: 'spawn',
      params: { agent: 'reviewer', task: 'review' },
      run: (client) => client.spawn({ agent: 'reviewer', task: 'review' }),
    },
    {
      method: 'stop',
      params: { runId: 'run-1' },
      run: (client) => client.stop({ runId: 'run-1' }),
    },
    {
      method: 'interrupt',
      params: { dir: '/tmp/run' },
      run: (client) => client.interrupt({ dir: '/tmp/run' }),
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

test('spawn uses the caller-persisted correlation ID without generating another', async () => {
  const bus = new FakeEventBus();
  const client = new SubagentsRpcClient({
    events: bus,
    requestId: () => {
      throw new Error('Must use persisted identity');
    },
  });
  const pending = client.spawn(
    { script: 'return 1' },
    { requestId: 'fusion-1:panel' },
  );
  assert.equal(bus.lastRequest().requestId, 'fusion-1:panel');
  bus.emit(subagentsRpcReplyChannel('fusion-1:panel'), {
    version: 1,
    requestId: 'fusion-1:panel',
    method: 'spawn',
    success: true,
    data: { runId: 'native-1' },
  });
  assert.deepEqual(await pending, { runId: 'native-1' });
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
    assert.ok(event, 'expected a subagents RPC request event');
    assert.ok(isRecord(event.payload));
    return event.payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
