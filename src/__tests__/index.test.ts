import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fusionExtension from "../index.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../orchestrator.js";
import {
  SUBAGENTS_RPC_REQUEST_CHANNEL,
  subagentsRpcReplyChannel,
} from "../subagents-rpc.js";
import { getFusionConfigTemplate } from "../config.js";
import { FUSION_RUN_ENTRY_TYPE } from "../run-store.js";

interface RegisteredCommand {
  description?: string;
  handler(args: string, ctx: FakeCommandContext): unknown;
}

interface FakeCommandContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted(): boolean;
  sessionManager: { getEntries(): readonly unknown[] };
  ui: FakeUi;
}

test("fusionExtension registers documented commands", () => {
  const pi = new FakePi();

  fusionExtension(pi.asExtensionApi());

  assert.deepEqual([...pi.commands.keys()].sort(), [
    "fusion",
    "fusion-cancel",
    "fusion-init",
    "fusion-status",
  ]);
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

class FakePi {
  readonly commands = new Map<string, RegisteredCommand>();
  readonly events = new FakeEventBus();
  readonly messages: Array<{
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  }> = [];
  readonly entries: Array<{
    type: "custom";
    customType: string;
    data?: unknown;
  }>;
  private readonly lifecycleHandlers = new Map<
    string,
    Set<(event: unknown, ctx: FakeCommandContext) => unknown>
  >();

  constructor(
    entries: readonly {
      type: "custom";
      customType: string;
      data?: unknown;
    }[] = [],
  ) {
    this.entries = entries.map((entry) => ({ ...entry }));
  }

  asExtensionApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }

  registerCommand(name: string, command: RegisteredCommand): void {
    this.commands.set(name, command);
  }

  on(
    event: string,
    handler: (payload: unknown, ctx: FakeCommandContext) => unknown,
  ): void {
    const handlers = this.lifecycleHandlers.get(event) ?? new Set();
    handlers.add(handler);
    this.lifecycleHandlers.set(event, handlers);
  }

  sendMessage(message: {
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  }): void {
    this.messages.push(message);
  }

  appendEntry(customType: string, data?: unknown): void {
    this.entries.push({ type: "custom", customType, data });
  }

  createContext(cwd = "/project"): FakeCommandContext {
    return {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      sessionManager: { getEntries: () => this.entries },
      ui: new FakeUi(),
    };
  }

  async runCommand(
    name: string,
    args: string,
    ctx: FakeCommandContext,
  ): Promise<void> {
    const command = this.commands.get(name);
    assert.ok(command, `expected /${name} to be registered`);
    await command.handler(args, ctx);
  }

  async emitLifecycle(
    event: string,
    payload: unknown,
    ctx: FakeCommandContext,
  ): Promise<void> {
    const handlers = this.lifecycleHandlers.get(event) ?? new Set();
    for (const handler of handlers) await handler(payload, ctx);
  }
}

class FakeEventBus {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  readonly statusResults = new Map<string, unknown>();
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
    if (handlers) {
      for (const handler of [...handlers]) handler(payload);
    }
    if (event === SUBAGENTS_RPC_REQUEST_CHANNEL)
      this.replyToRpcRequest(payload);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  private replyToRpcRequest(payload: unknown): void {
    assert.ok(isRecord(payload));
    assert.equal(payload.version, 1);
    if (typeof payload.requestId !== "string") {
      throw new TypeError("RPC requestId must be a string.");
    }
    if (typeof payload.method !== "string") {
      throw new TypeError("RPC method must be a string.");
    }

    const requestId = payload.requestId;
    const method = payload.method;
    const data = this.rpcData(method, payload.params);
    this.emit(subagentsRpcReplyChannel(requestId), {
      version: 1,
      requestId,
      method,
      success: true,
      data,
    });
  }

  private rpcData(method: string, params: unknown): unknown {
    if (method === "ping") return { ok: true };
    if (method === "spawn") return this.spawnData(params);
    if (method === "status") return this.statusData(params);
    if (method === "stop" || method === "interrupt") return { ok: true };
    throw new Error(`Unexpected RPC method: ${method}`);
  }

  private spawnData(params: unknown): unknown {
    assert.ok(isRecord(params));
    return Array.isArray(params.tasks)
      ? { details: { runId: "panel-1" } }
      : { details: { runId: "judge-1" } };
  }

  private statusData(params: unknown): unknown {
    assert.ok(isRecord(params));
    if (typeof params.id !== "string") {
      throw new TypeError("RPC status id must be a string.");
    }
    return (
      this.statusResults.get(params.id) ?? { runId: params.id, results: [] }
    );
  }
}

class FakeUi {
  readonly statuses: Array<{ key: string; text: string | undefined }> = [];

  setStatus(key: string, text: string | undefined): void {
    this.statuses.push({ key, text });
  }

  notify(_message: string, _type?: "info" | "warning" | "error"): void {}

  lastStatus(key: string): string | undefined {
    return this.statuses.findLast((entry) => entry.key === key)?.text;
  }
}

async function createProjectDir(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-fusion-test-"));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  const configDir = join(cwd, ".pi");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "fusion.json"), getFusionConfigTemplate());
  return cwd;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
