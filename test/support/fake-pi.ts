import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { getFusionConfigTemplate } from '../../src/config.js';
import {
  SUBAGENTS_RPC_REQUEST_CHANNEL,
  subagentsRpcReplyChannel,
} from '../../src/subagents-rpc.js';

/** The parts of a registered tool that tests assert on. */
export interface RegisteredTool {
  name: string;
  description: string;
  parameters: {
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: FakeCommandContext,
  ): Promise<unknown>;
}

export interface RegisteredCommand {
  description?: string;
  handler(args: string, ctx: FakeCommandContext): unknown;
}

export interface FakeCommandContext {
  isIdle(): boolean;
  cwd: string;
  hasUI: boolean;
  isProjectTrusted(): boolean;
  sessionManager: { getEntries(): readonly unknown[]; getSessionId(): string };
  ui: FakeUi;
}

export interface FakeCustomEntry {
  type: 'custom';
  customType: string;
  data?: unknown;
}

export interface FakeMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

export class FakePi {
  idle = true;
  readonly userMessages: Array<{ content: string; deliverAs?: string }> = [];
  sessionId = 'test-session';
  readonly messageOptions: Array<
    { triggerTurn?: boolean; deliverAs?: string } | undefined
  > = [];
  readonly commands = new Map<string, RegisteredCommand>();
  readonly events = new FakeEventBus();
  readonly messages: FakeMessage[] = [];
  readonly entries: FakeCustomEntry[];
  private readonly lifecycleHandlers = new Map<
    string,
    Set<(event: unknown, ctx: FakeCommandContext) => unknown>
  >();

  constructor(entries: readonly FakeCustomEntry[] = []) {
    this.entries = entries.map((entry) => ({ ...entry }));
  }

  asExtensionApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }

  readonly tools = new Map<string, RegisteredTool>();

  registerCommand(name: string, command: RegisteredCommand): void {
    this.commands.set(name, command);
  }

  registerTool(definition: unknown): void {
    assert.ok(isRecord(definition) && typeof definition.name === 'string');
    this.tools.set(definition.name, definition as unknown as RegisteredTool);
  }

  on(
    event: string,
    handler: (payload: unknown, ctx: FakeCommandContext) => unknown,
  ): void {
    const handlers = this.lifecycleHandlers.get(event) ?? new Set();
    handlers.add(handler);
    this.lifecycleHandlers.set(event, handlers);
  }

  sendMessage(
    message: FakeMessage,
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ): void {
    this.messages.push(message);
    this.messageOptions.push(options);
  }

  sendUserMessage(content: string, options?: { deliverAs?: string }): void {
    this.userMessages.push({
      content,
      ...(options?.deliverAs ? { deliverAs: options.deliverAs } : {}),
    });
  }

  appendEntry(customType: string, data?: unknown): void {
    this.entries.push({ type: 'custom', customType, data });
  }

  createContext(cwd = '/project'): FakeCommandContext {
    return {
      isIdle: () => this.idle,
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      sessionManager: {
        getEntries: () => this.entries,
        getSessionId: () => this.sessionId,
      },
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

export class FakeEventBus {
  pingResult: unknown = {
    ok: true,
    events: {
      childStatus: 'subagent:child-status',
      processTerminal: 'subagent:process-terminal',
    },
  };
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  readonly statusResults = new Map<string, unknown>();
  readonly spawnAsyncDirs = new Map<string, string>();
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
    if (event === SUBAGENTS_RPC_REQUEST_CHANNEL) {
      this.replyToRpcRequest(payload);
    }
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  private replyToRpcRequest(payload: unknown): void {
    assert.ok(isRecord(payload));
    assert.equal(payload.version, 1);
    if (typeof payload.requestId !== 'string') {
      throw new TypeError('RPC requestId must be a string.');
    }
    if (typeof payload.method !== 'string') {
      throw new TypeError('RPC method must be a string.');
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

  readonly spawns: Record<string, unknown>[] = [];

  private rpcData(method: string, params: unknown): unknown {
    if (method === 'ping') return this.pingResult;
    if (method === 'spawn') return this.spawnData(params);
    if (method === 'status') return this.statusData(params);
    if (method === 'stop' || method === 'interrupt') return { ok: true };
    throw new Error(`Unexpected RPC method: ${method}`);
  }

  private spawnData(params: unknown): unknown {
    if (!isRecord(params) || typeof params.script !== 'string') {
      throw new TypeError('Subagent spawn must use script.');
    }
    assert.equal('clarify' in params, false);
    assert.equal('agent' in params, false);
    assert.equal('task' in params, false);
    this.spawns.push(params);
    const runId = params.script.includes('runs.run("judge",')
      ? 'judge-1'
      : 'panel-1';
    return {
      details: {
        runId,
        ...(this.spawnAsyncDirs.has(runId)
          ? { asyncDir: this.spawnAsyncDirs.get(runId) }
          : {}),
      },
    };
  }

  private statusData(params: unknown): unknown {
    assert.ok(isRecord(params));
    if (typeof params.id !== 'string') {
      throw new TypeError('RPC status id must be a string.');
    }
    return (
      this.statusResults.get(params.id) ?? { runId: params.id, results: [] }
    );
  }
}

export class FakeUi {
  readonly statuses: Array<{ key: string; text: string | undefined }> = [];
  readonly notifications: Array<{
    message: string;
    type: 'info' | 'warning' | 'error' | undefined;
  }> = [];

  setStatus(key: string, text: string | undefined): void {
    this.statuses.push({ key, text });
  }

  notify(message: string, type?: 'info' | 'warning' | 'error'): void {
    this.notifications.push({ message, type });
  }

  lastStatus(key: string): string | undefined {
    return this.statuses.findLast((entry) => entry.key === key)?.text;
  }
}

export async function createProjectDir(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-fusion-test-'));
  t.onTestFinished(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  const configDir = join(cwd, '.pi');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'fusion.json'), getFusionConfigTemplate());
  return cwd;
}

export async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
