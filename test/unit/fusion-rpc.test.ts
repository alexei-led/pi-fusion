import assert from "node:assert/strict";
import test from "node:test";
import {
  FUSION_RPC_METHODS,
  FUSION_RPC_REPLY_EVENT_PREFIX,
  FUSION_RPC_REQUEST_EVENT,
  registerFusionRpc,
} from "../../src/fusion-rpc.js";
import type { FusionCommandResult } from "../../src/orchestrator.js";
import { FUSION_RUN_ENTRY_TYPE, FusionRunStore } from "../../src/run-store.js";
import type { FusionRun } from "../../src/types.js";

const activeRun: FusionRun = {
  id: "fusion-1",
  prompt: "Review this.",
  profileName: "quality",
  operationId: "operation-1",
  phase: "panel",
  createdAt: 1,
  updatedAt: 1,
};

test("Fusion RPC exposes its versioned method contract", async () => {
  const fixture = createFixture();

  const response = fixture.request("ping-1", "ping");

  assert.deepEqual(
    await response,
    success("ping-1", "ping", {
      pong: true,
      version: 1,
      methods: FUSION_RPC_METHODS,
    }),
  );
  fixture.unregister();
});

test("Fusion RPC starts once per operation ID and returns structured replay state", async () => {
  const fixture = createFixture();

  const first = fixture.request("start-1", "start", {
    prompt: "Review this.",
    profile: "quality",
    operationId: "operation-1",
  });
  assert.deepEqual(
    await first,
    success("start-1", "start", {
      operationId: "operation-1",
      replayed: false,
      run: state(activeRun),
    }),
  );

  const replay = fixture.request("start-2", "start", {
    prompt: "Other prompt ignored by operation id.",
    operationId: "operation-1",
  });
  assert.deepEqual(
    await replay,
    success("start-2", "start", {
      operationId: "operation-1",
      replayed: true,
      run: state(activeRun),
    }),
  );
  assert.equal(fixture.starts(), 1);
  fixture.unregister();
});

test("Fusion RPC coalesces concurrent starts for one operation ID", async () => {
  const bus = new FakeEventBus();
  const store = new FusionRunStore();
  let starts = 0;
  let resolveStart:
    ((result: { status: "started"; run: FusionRun }) => void) | undefined;
  const pendingStart = new Promise<{ status: "started"; run: FusionRun }>(
    (resolve) => {
      resolveStart = resolve;
    },
  );
  registerFusionRpc({
    events: bus,
    store,
    getContext: () => fakeContext,
    orchestrator: {
      async startRun() {
        starts += 1;
        return pendingStart;
      },
      async cancelActiveRun() {
        return { status: "ignored" };
      },
    },
  });

  const first = request(bus, "start-1", "start", {
    prompt: "Review this.",
    operationId: "operation-1",
  });
  const second = request(bus, "start-2", "start", {
    prompt: "Review this.",
    operationId: "operation-1",
  });
  assert.equal(starts, 1);
  assert.ok(resolveStart);
  resolveStart({ status: "started", run: activeRun });

  assert.deepEqual(
    await first,
    success("start-1", "start", {
      operationId: "operation-1",
      replayed: false,
      run: state(activeRun),
    }),
  );
  assert.deepEqual(
    await second,
    success("start-2", "start", {
      operationId: "operation-1",
      replayed: true,
      run: state(activeRun),
    }),
  );
});

test("Fusion RPC replays any persisted operation after later runs and restart", async () => {
  const entries: Array<{
    type: "custom";
    customType: string;
    data?: unknown;
  }> = [];
  const original = new FusionRunStore({
    idFactory: sequentialIds("fusion-1", "fusion-2"),
    now: sequentialClock(),
    persistence: {
      appendEntry: (customType, data) =>
        entries.push({ type: "custom", customType, data }),
    },
  });
  const first = original.startRun({
    prompt: "First",
    profileName: "quality",
    operationId: "operation-1",
    phase: "panel",
  });
  original.completeRun(first.id, { report: "First report" });
  const second = original.startRun({
    prompt: "Second",
    profileName: "quality",
    operationId: "operation-2",
    phase: "panel",
  });
  original.completeRun(second.id, { report: "Second report" });

  const restored = new FusionRunStore();
  restored.restoreFromEntries(entries);
  const bus = new FakeEventBus();
  let starts = 0;
  registerFusionRpc({
    events: bus,
    store: restored,
    getContext: () => fakeContext,
    orchestrator: {
      async startRun() {
        starts += 1;
        throw new Error("must not start");
      },
      async cancelActiveRun() {
        return { status: "ignored" };
      },
    },
  });

  const replay = request(bus, "start-restored", "start", {
    prompt: "Ignored retry prompt",
    operationId: "operation-1",
  });
  assert.deepEqual(
    await replay,
    success("start-restored", "start", {
      operationId: "operation-1",
      replayed: true,
      run: {
        runId: "fusion-1",
        operationId: "operation-1",
        phase: "done",
        terminal: true,
        report: "First report",
      },
    }),
  );
  assert.equal(starts, 0);
  assert.equal(
    entries.every((entry) => entry.customType === FUSION_RUN_ENTRY_TYPE),
    true,
  );
});

test("Fusion RPC status, result, and adopt resolve historical runs", async () => {
  const store = new FusionRunStore({
    idFactory: sequentialIds("fusion-1", "fusion-2"),
    now: sequentialClock(),
  });
  const first = store.startRun({
    prompt: "First",
    profileName: "quality",
    operationId: "operation-1",
  });
  store.completeRun(first.id, { report: "First report" });
  const second = store.startRun({
    prompt: "Second",
    profileName: "quality",
    operationId: "operation-2",
  });
  store.completeRun(second.id, { report: "Second report" });
  const fixture = createFixture(store);
  const expected = {
    runId: "fusion-1",
    operationId: "operation-1",
    phase: "done",
    terminal: true,
    report: "First report",
  };

  assert.deepEqual(
    await fixture.request("status-1", "status", {
      operationId: "operation-1",
    }),
    success("status-1", "status", { run: expected }),
  );
  assert.deepEqual(
    await fixture.request("result-1", "result", { runId: "fusion-1" }),
    success("result-1", "result", { run: expected }),
  );
  assert.deepEqual(
    await fixture.request("adopt-1", "adopt", { runId: "fusion-1" }),
    success("adopt-1", "adopt", { adopted: true, run: expected }),
  );
});

test("Fusion RPC result reports not_ready with the current structured state", async () => {
  const store = new FusionRunStore({ idFactory: () => "fusion-1" });
  store.startRun({
    prompt: "Review this.",
    profileName: "quality",
    operationId: "operation-1",
    phase: "judge",
  });
  const fixture = createFixture(store);

  assert.deepEqual(
    await fixture.request("result-1", "result", {
      operationId: "operation-1",
    }),
    failure("result-1", "result", {
      code: "not_ready",
      message: "Fusion run fusion-1 is not terminal.",
      details: {
        run: {
          runId: "fusion-1",
          operationId: "operation-1",
          phase: "judge",
          terminal: false,
        },
      },
    }),
  );
});

test("Fusion RPC cancel targets the selected active run and returns terminal state", async () => {
  const store = new FusionRunStore({ idFactory: () => "fusion-1" });
  store.startRun({
    prompt: "Review this.",
    profileName: "quality",
    operationId: "operation-1",
    phase: "panel",
  });
  let cancels = 0;
  const fixture = createFixture(store, {
    async cancelActiveRun() {
      cancels += 1;
      const cancelled = store.cancelRun("fusion-1", {
        report: "Cancellation report",
        error: "Cancellation requested with stop.",
      });
      return {
        status: "cancelled" as const,
        run: cancelled,
        report: "Cancellation report",
      };
    },
  });

  assert.deepEqual(
    await fixture.request("cancel-1", "cancel", {
      operationId: "operation-1",
    }),
    success("cancel-1", "cancel", {
      cancelled: true,
      run: {
        runId: "fusion-1",
        operationId: "operation-1",
        phase: "cancelled",
        terminal: true,
        report: "Cancellation report",
        error: "Cancellation requested with stop.",
      },
    }),
  );
  assert.equal(cancels, 1);
});

test("Fusion RPC returns typed protocol errors", async () => {
  const bus = new FakeEventBus();
  const fixture = createFixture();

  assert.deepEqual(await fixture.request("method-invalid", "unknown"), {
    version: 1,
    requestId: "method-invalid",
    success: false,
    error: {
      code: "unsupported_method",
      message: "RPC method is unsupported.",
    },
  });

  const wrongVersion = once(bus, replyEvent("version-invalid"));
  registerFusionRpc({
    events: bus,
    store: new FusionRunStore(),
    getContext: () => fakeContext,
    orchestrator: {
      async startRun() {
        return { status: "ignored" };
      },
      async cancelActiveRun() {
        return { status: "ignored" };
      },
    },
  });
  bus.emit(FUSION_RPC_REQUEST_EVENT, {
    version: 2,
    requestId: "version-invalid",
    method: "status",
  });
  assert.deepEqual(
    await wrongVersion,
    failure("version-invalid", "status", {
      code: "invalid_request",
      message: "RPC version must be 1.",
    }),
  );
});

test("Fusion RPC returns typed validation, lookup, availability, and busy errors", async () => {
  const unavailable = createFixture(new FusionRunStore(), {
    getContext: () => undefined,
  });
  assert.deepEqual(
    await unavailable.request("start-unavailable", "start", {
      prompt: "Review this.",
      operationId: "operation-1",
    }),
    failure("start-unavailable", "start", {
      code: "unavailable",
      message: "Fusion session context is unavailable.",
    }),
  );

  const fixture = createFixture();
  assert.deepEqual(
    await fixture.request("adopt-invalid", "adopt", {}),
    failure("adopt-invalid", "adopt", {
      code: "invalid_request",
      message: "adopt runId must be a non-empty string.",
    }),
  );
  assert.deepEqual(
    await fixture.request("status-missing", "status", {
      operationId: "missing",
    }),
    failure("status-missing", "status", {
      code: "not_found",
      message: "Fusion run was not found.",
      details: { operationId: "missing" },
    }),
  );

  const busyStore = new FusionRunStore({ idFactory: () => "active-run" });
  busyStore.startRun({
    prompt: "Existing",
    profileName: "quality",
    phase: "panel",
  });
  const busy = createFixture(busyStore, {
    async startRun() {
      return { status: "conflict", activeRunId: "active-run" };
    },
  });
  assert.deepEqual(
    await busy.request("start-busy", "start", {
      prompt: "New",
      operationId: "operation-new",
    }),
    failure("start-busy", "start", {
      code: "busy",
      message: "Fusion run active-run is already active.",
      details: {
        activeRunId: "active-run",
        run: {
          runId: "active-run",
          phase: "panel",
          terminal: false,
        },
      },
    }),
  );

  const startFailed = createFixture(new FusionRunStore(), {
    async startRun() {
      return { status: "failed", error: "profile invalid" };
    },
  });
  assert.deepEqual(
    await startFailed.request("start-failed", "start", {
      prompt: "Review this.",
      operationId: "operation-failed",
    }),
    failure("start-failed", "start", {
      code: "start_failed",
      message: "profile invalid",
    }),
  );

  const cancelStore = new FusionRunStore({ idFactory: () => "cancel-run" });
  cancelStore.startRun({
    prompt: "Review this.",
    profileName: "quality",
    operationId: "cancel-operation",
    phase: "panel",
  });
  const cancelFailed = createFixture(cancelStore, {
    async cancelActiveRun() {
      return { status: "failed", error: "stop and interrupt failed" };
    },
  });
  const cancelActive = cancelStore.getActiveRun();
  assert.ok(cancelActive);
  assert.deepEqual(
    await cancelFailed.request("cancel-failed", "cancel", {
      operationId: "cancel-operation",
    }),
    failure("cancel-failed", "cancel", {
      code: "cancel_failed",
      message: "stop and interrupt failed",
      details: { run: state(cancelActive) },
    }),
  );
});

interface FixtureOverrides {
  getContext?: () => typeof fakeContext | undefined;
  startRun?: () => Promise<FusionCommandResult>;
  cancelActiveRun?: () => Promise<FusionCommandResult>;
}

function createFixture(
  store = new FusionRunStore({ idFactory: () => "fusion-1", now: () => 1 }),
  overrides: FixtureOverrides = {},
) {
  const bus = new FakeEventBus();
  let starts = 0;
  const unregister = registerFusionRpc({
    events: bus,
    store,
    getContext: overrides.getContext ?? (() => fakeContext),
    orchestrator: {
      async startRun(input) {
        starts += 1;
        if (overrides.startRun) return overrides.startRun();
        const run = store.startRun({
          prompt: input.prompt,
          profileName: input.profile ?? "quality",
          ...(input.operationId ? { operationId: input.operationId } : {}),
          phase: "panel",
        });
        return { status: "started", run };
      },
      async cancelActiveRun() {
        return overrides.cancelActiveRun
          ? overrides.cancelActiveRun()
          : { status: "ignored" };
      },
    },
  });

  return {
    request: (requestId: string, method: string, params?: unknown) =>
      request(bus, requestId, method, params),
    starts: () => starts,
    unregister,
  };
}

function request(
  bus: FakeEventBus,
  requestId: string,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const response = once(bus, replyEvent(requestId));
  bus.emit(FUSION_RPC_REQUEST_EVENT, {
    version: 1,
    requestId,
    method,
    ...(params === undefined ? {} : { params }),
  });
  return response;
}

function state(run: FusionRun) {
  return {
    runId: run.id,
    ...(run.operationId ? { operationId: run.operationId } : {}),
    phase: run.phase,
    terminal:
      run.phase === "done" ||
      run.phase === "failed" ||
      run.phase === "cancelled",
    ...(run.report !== undefined ? { report: run.report } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

function replyEvent(requestId: string): string {
  return `${FUSION_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

function success(requestId: string, method: string, data: unknown) {
  return { version: 1, requestId, method, success: true, data };
}

function failure(requestId: string, method: string, error: unknown) {
  return { version: 1, requestId, method, success: false, error };
}

function once(bus: FakeEventBus, event: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${event}`));
    }, 100);
    const unsubscribe = bus.on(event, (payload) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(payload);
    });
  });
}

function sequentialIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `fusion-${index}`;
}

function sequentialClock(): () => number {
  let value = 0;
  return () => ++value;
}

class FakeEventBus {
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
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

const fakeContext = {
  cwd: "/tmp",
  hasUI: false,
  isProjectTrusted: () => true,
  sessionManager: { getEntries: () => [] },
  ui: {
    notify: () => undefined,
    setStatus: () => undefined,
  },
};
