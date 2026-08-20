import { randomUUID } from "node:crypto";
import {
  SubagentsRpcClient,
  type SubagentsEventBus,
  type SubagentsRpcClientOptions,
} from "./subagents-rpc.js";

export type { SubagentsEventBus };
import {
  extractSubagentAsyncDir,
  extractSubagentRunId,
} from "./orchestrator.js";

export type SubagentProvider = "auto" | "nicopreme" | "tintinweb";

export const TINTINWEB_PING_CHANNEL = "subagents:rpc:ping";
export const TINTINWEB_SPAWN_CHANNEL = "subagents:rpc:spawn";
export const TINTINWEB_STOP_CHANNEL = "subagents:rpc:stop";
export const TINTINWEB_READY_EVENT = "subagents:ready";
export const TINTINWEB_COMPLETED_EVENT = "subagents:completed";
export const TINTINWEB_FAILED_EVENT = "subagents:failed";

export const NICOPREME_READY_EVENT = "subagents:rpc:v1:ready";
export const NICOPREME_REQUEST_CHANNEL = "subagents:rpc:v1:request";
export const NICOPREME_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export const DEFAULT_ADAPTER_TIMEOUT_MS = 15_000;

export interface SubagentSpawnOptions {
  model?: string;
  description?: string;
  isBackground?: boolean;
  cwd?: string;
  context?: "fresh" | "fork";
  timeoutMs?: number;
  workflowScript?: string;
  [key: string]: unknown;
}

export interface SubagentSpawnResult {
  runId: string;
  asyncDir?: string;
  raw?: unknown;
  [key: string]: unknown;
}

export interface SubagentTokens {
  input?: number;
  output?: number;
  total?: number;
}

export interface SubagentCompletionResult {
  runId: string;
  success: boolean;
  output?: string;
  error?: string;
  tokens?: SubagentTokens;
  usage?: unknown;
  durationMs?: number;
  raw?: unknown;
}

export interface ISubagentRPCAdapter {
  readonly provider: "nicopreme" | "tintinweb";
  ping(options?: { timeoutMs?: number }): Promise<boolean>;
  spawn(
    agentType: string,
    prompt: string,
    options?: SubagentSpawnOptions,
  ): Promise<SubagentSpawnResult>;
  stop(runId: string, options?: { timeoutMs?: number }): Promise<boolean>;
  interrupt?(runId: string, options?: { timeoutMs?: number }): Promise<boolean>;
  status?(runId: string, options?: { timeoutMs?: number }): Promise<unknown>;
  onCompletion(
    runId: string,
    callback: (result: SubagentCompletionResult) => void,
  ): () => void;
  dispose?(): void;
}

export interface NicopremeAdapterOptions {
  events: SubagentsEventBus;
  rpc?: SubagentsRpcClient;
  timeoutMs?: number;
  requestId?: () => string;
}

export class NicopremeAdapter implements ISubagentRPCAdapter {
  readonly provider = "nicopreme" as const;
  readonly rpc: SubagentsRpcClient;
  private readonly events: SubagentsEventBus;
  private readonly timeoutMs: number;

  constructor(options: NicopremeAdapterOptions) {
    this.events = options.events;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
    const clientOptions: SubagentsRpcClientOptions = {
      events: options.events,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    };
    this.rpc = options.rpc ?? new SubagentsRpcClient(clientOptions);
  }

  async ping(options?: { timeoutMs?: number }): Promise<boolean> {
    try {
      await this.rpc.ping(options);
      return true;
    } catch {
      return false;
    }
  }

  async spawn(
    agentType: string,
    prompt: string,
    options: SubagentSpawnOptions = {},
  ): Promise<SubagentSpawnResult> {
    let params: object;
    if (typeof options.workflowScript === "string") {
      params = options;
    } else {
      params = {
        agent: agentType,
        task: prompt,
        output: true,
        outputMode: "inline",
        async: true,
        ...(options.model ? { model: options.model } : {}),
        ...(options.context ? { context: options.context } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      };
    }

    const response = await this.rpc.spawn(params, {
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    });
    const runId = extractSubagentRunId(response) ?? randomUUID();
    const asyncDir = extractSubagentAsyncDir(response);
    return {
      runId,
      ...(asyncDir !== undefined ? { asyncDir } : {}),
      raw: response,
    };
  }

  async stop(runId: string, options?: { timeoutMs?: number }): Promise<boolean> {
    try {
      await this.rpc.stop({ id: runId }, options);
      return true;
    } catch (stopError: unknown) {
      try {
        await this.rpc.interrupt({ id: runId }, options);
        return true;
      } catch {
        throw stopError;
      }
    }
  }

  async interrupt(
    runId: string,
    options?: { timeoutMs?: number },
  ): Promise<boolean> {
    await this.rpc.interrupt({ id: runId }, options);
    return true;
  }

  async status(
    runId: string,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    return this.rpc.status({ id: runId }, options);
  }

  onCompletion(
    runId: string,
    callback: (result: SubagentCompletionResult) => void,
  ): () => void {
    const unsubscribe = this.events.on(
      NICOPREME_ASYNC_COMPLETE_EVENT,
      (payload: unknown) => {
        const eventRunId = extractSubagentRunId(payload);
        if (eventRunId && eventRunId === runId) {
          const isError = isSubagentPayloadError(payload);
          const errorMsg = extractPayloadError(payload);
          const outputText = extractPayloadOutput(payload);
          callback({
            runId,
            success: !isError,
            ...(outputText ? { output: outputText } : {}),
            ...(errorMsg ? { error: errorMsg } : {}),
            raw: payload,
          });
        }
      },
    );
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }
}

export interface TintinwebAdapterOptions {
  events: SubagentsEventBus;
  timeoutMs?: number;
  requestId?: () => string;
}

export class TintinwebAdapter implements ISubagentRPCAdapter {
  readonly provider = "tintinweb" as const;
  private readonly events: SubagentsEventBus;
  private readonly timeoutMs: number;
  private readonly createRequestId: () => string;

  constructor(options: TintinwebAdapterOptions) {
    this.events = options.events;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
    this.createRequestId = options.requestId ?? randomUUID;
  }

  ping(options?: { timeoutMs?: number }): Promise<boolean> {
    const requestId = this.createRequestId();
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const replyChannel = `${TINTINWEB_PING_CHANNEL}:reply:${requestId}`;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (unsubscribe) unsubscribe();
        resolve(false);
      }, timeoutMs);

      const maybeUnsub = this.events.on(replyChannel, (payload: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (unsubscribe) unsubscribe();
        if (isRecord(payload) && payload.success === true) {
          resolve(true);
        } else {
          resolve(false);
        }
      });

      if (typeof maybeUnsub === "function") unsubscribe = maybeUnsub;

      try {
        this.events.emit(TINTINWEB_PING_CHANNEL, { requestId });
      } catch {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (unsubscribe) unsubscribe();
          resolve(false);
        }
      }
    });
  }

  spawn(
    agentType: string,
    prompt: string,
    options: SubagentSpawnOptions = {},
  ): Promise<SubagentSpawnResult> {
    const requestId = this.createRequestId();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const replyChannel = `${TINTINWEB_SPAWN_CHANNEL}:reply:${requestId}`;

    const tintinOptions: Record<string, unknown> = {
      isBackground: options.isBackground ?? true,
      ...(options.description ? { description: options.description } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    };

    return new Promise<SubagentSpawnResult>((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (unsubscribe) unsubscribe();
        reject(
          new Error(
            `Tintinweb subagents spawn request ${requestId} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      const maybeUnsub = this.events.on(replyChannel, (payload: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (unsubscribe) unsubscribe();

        if (!isRecord(payload)) {
          reject(new Error("Invalid reply envelope from Tintinweb spawn RPC."));
          return;
        }

        if (payload.success === true && isRecord(payload.data)) {
          const rawId = payload.data.id;
          const runId =
            typeof rawId === "string"
              ? rawId
              : typeof rawId === "number"
                ? String(rawId)
                : "";
          if (!runId) {
            reject(
              new Error("Tintinweb spawn RPC reply did not contain an agent ID."),
            );
            return;
          }
          resolve({ runId, raw: payload.data });
          return;
        }

        if (payload.success === false) {
          const errorMsg =
            typeof payload.error === "string"
              ? payload.error
              : isRecord(payload.error) && typeof payload.error.message === "string"
                ? payload.error.message
                : "Tintinweb subagents spawn RPC failed.";
          reject(new Error(errorMsg));
          return;
        }

        reject(new Error("Unexpected reply from Tintinweb spawn RPC."));
      });

      if (typeof maybeUnsub === "function") unsubscribe = maybeUnsub;

      try {
        this.events.emit(TINTINWEB_SPAWN_CHANNEL, {
          requestId,
          type: agentType,
          prompt,
          options: tintinOptions,
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (unsubscribe) unsubscribe();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  stop(runId: string, options?: { timeoutMs?: number }): Promise<boolean> {
    const requestId = this.createRequestId();
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const replyChannel = `${TINTINWEB_STOP_CHANNEL}:reply:${requestId}`;

    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (unsubscribe) unsubscribe();
        reject(
          new Error(
            `Tintinweb subagents stop request ${requestId} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      const maybeUnsub = this.events.on(replyChannel, (payload: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (unsubscribe) unsubscribe();

        if (isRecord(payload) && payload.success === true) {
          resolve(true);
        } else if (isRecord(payload) && payload.success === false) {
          const errorMsg =
            typeof payload.error === "string"
              ? payload.error
              : "Tintinweb subagents stop RPC failed.";
          reject(new Error(errorMsg));
        } else {
          resolve(false);
        }
      });

      if (typeof maybeUnsub === "function") unsubscribe = maybeUnsub;

      try {
        this.events.emit(TINTINWEB_STOP_CHANNEL, {
          requestId,
          agentId: runId,
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (unsubscribe) unsubscribe();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  async interrupt(
    runId: string,
    options?: { timeoutMs?: number },
  ): Promise<boolean> {
    return this.stop(runId, options);
  }

  onCompletion(
    runId: string,
    callback: (result: SubagentCompletionResult) => void,
  ): () => void {
    const unsubCompleted = this.events.on(
      TINTINWEB_COMPLETED_EVENT,
      (payload: unknown) => {
        if (!isRecord(payload)) return;
        const id = extractRecordId(payload);
        if (id && id === runId) {
          const output =
            typeof payload.result === "string"
              ? payload.result
              : payload.result !== undefined
                ? JSON.stringify(payload.result)
                : undefined;
          const tokens: SubagentTokens | undefined = isRecord(payload.tokens)
            ? {
                ...(typeof payload.tokens.input === "number"
                  ? { input: payload.tokens.input }
                  : {}),
                ...(typeof payload.tokens.output === "number"
                  ? { output: payload.tokens.output }
                  : {}),
                ...(typeof payload.tokens.total === "number"
                  ? { total: payload.tokens.total }
                  : {}),
              }
            : undefined;
          callback({
            runId,
            success: true,
            ...(output !== undefined ? { output } : {}),
            ...(tokens !== undefined ? { tokens } : {}),
            ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
            ...(typeof payload.durationMs === "number"
              ? { durationMs: payload.durationMs }
              : {}),
            raw: payload,
          });
        }
      },
    );

    const unsubFailed = this.events.on(
      TINTINWEB_FAILED_EVENT,
      (payload: unknown) => {
        if (!isRecord(payload)) return;
        const id = extractRecordId(payload);
        if (id && id === runId) {
          const error =
            typeof payload.error === "string"
              ? payload.error
              : typeof payload.status === "string"
                ? `Agent ended with status ${payload.status}`
                : "Subagent failed";
          callback({
            runId,
            success: false,
            error,
            ...(typeof payload.durationMs === "number"
              ? { durationMs: payload.durationMs }
              : {}),
            raw: payload,
          });
        }
      },
    );

    return () => {
      if (typeof unsubCompleted === "function") unsubCompleted();
      if (typeof unsubFailed === "function") unsubFailed();
    };
  }
}

export interface AutoDetectingAdapterOptions {
  events: SubagentsEventBus;
  provider?: SubagentProvider;
  nicopreme?: ISubagentRPCAdapter;
  tintinweb?: ISubagentRPCAdapter;
  timeoutMs?: number;
}

export class AutoDetectingAdapter implements ISubagentRPCAdapter {
  private readonly events: SubagentsEventBus;
  readonly nicopreme: ISubagentRPCAdapter;
  readonly tintinweb: ISubagentRPCAdapter;
  private configuredProvider: SubagentProvider;
  private detectedProvider: "nicopreme" | "tintinweb" | undefined;
  private unsubs: Array<() => void> = [];

  constructor(options: AutoDetectingAdapterOptions) {
    this.events = options.events;
    this.configuredProvider = options.provider ?? "auto";
    const adapterOpts = {
      events: options.events,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    };
    this.nicopreme = options.nicopreme ?? new NicopremeAdapter(adapterOpts);
    this.tintinweb = options.tintinweb ?? new TintinwebAdapter(adapterOpts);

    this.initReadinessListeners();
  }

  setConfiguredProvider(provider: SubagentProvider): void {
    this.configuredProvider = provider;
  }

  private initReadinessListeners(): void {
    const unsubNico = this.events.on(NICOPREME_READY_EVENT, () => {
      // If Nicopreme announces ready, it takes precedence when auto
      if (this.configuredProvider === "auto") {
        this.detectedProvider = "nicopreme";
      }
    });
    if (typeof unsubNico === "function") this.unsubs.push(unsubNico);

    const unsubTintin = this.events.on(TINTINWEB_READY_EVENT, () => {
      // Only set tintinweb if nicopreme is not already detected
      if (this.configuredProvider === "auto" && !this.detectedProvider) {
        this.detectedProvider = "tintinweb";
      }
    });
    if (typeof unsubTintin === "function") this.unsubs.push(unsubTintin);
  }

  get provider(): "nicopreme" | "tintinweb" {
    return this.getActiveProviderSync();
  }

  getActiveProviderSync(): "nicopreme" | "tintinweb" {
    const envProvider = resolveEnvProvider();
    if (envProvider) return envProvider;
    if (this.configuredProvider === "nicopreme") return "nicopreme";
    if (this.configuredProvider === "tintinweb") return "tintinweb";
    return this.detectedProvider ?? "nicopreme";
  }

  async resolveActiveAdapter(): Promise<ISubagentRPCAdapter> {
    const envProvider = resolveEnvProvider();
    if (envProvider === "tintinweb") return this.tintinweb;
    if (envProvider === "nicopreme") return this.nicopreme;

    if (this.configuredProvider === "tintinweb") return this.tintinweb;
    if (this.configuredProvider === "nicopreme") return this.nicopreme;

    if (this.detectedProvider === "nicopreme") return this.nicopreme;
    if (this.detectedProvider === "tintinweb") return this.tintinweb;

    // Nicopreme takes precedence when both or nicopreme are present
    const nicoOk = await this.nicopreme.ping({ timeoutMs: 100 }).catch(() => false);
    if (nicoOk) {
      this.detectedProvider = "nicopreme";
      return this.nicopreme;
    }

    const tintinOk = await this.tintinweb.ping({ timeoutMs: 100 }).catch(() => false);
    if (tintinOk) {
      this.detectedProvider = "tintinweb";
      return this.tintinweb;
    }

    // Default fallback to nicopreme
    this.detectedProvider = "nicopreme";
    return this.nicopreme;
  }

  async ping(options?: { timeoutMs?: number }): Promise<boolean> {
    const envProvider = resolveEnvProvider();
    if (envProvider === "tintinweb" || this.configuredProvider === "tintinweb") {
      return this.tintinweb.ping(options);
    }
    if (envProvider === "nicopreme" || this.configuredProvider === "nicopreme") {
      return this.nicopreme.ping(options);
    }

    if (this.detectedProvider === "nicopreme") return this.nicopreme.ping(options);
    if (this.detectedProvider === "tintinweb") return this.tintinweb.ping(options);

    // Auto mode: probe nicopreme first with fast probe timeout (100ms) unless explicitly specified
    const probeOpts = { timeoutMs: options?.timeoutMs ?? 100 };
    const nicoOk = await this.nicopreme.ping(probeOpts);
    if (nicoOk) {
      this.detectedProvider = "nicopreme";
      return true;
    }
    const tintinOk = await this.tintinweb.ping(probeOpts);
    if (tintinOk) {
      this.detectedProvider = "tintinweb";
      return true;
    }
    return false;
  }

  async spawn(
    agentType: string,
    prompt: string,
    options?: SubagentSpawnOptions,
  ): Promise<SubagentSpawnResult> {
    const adapter = await this.resolveActiveAdapter();
    return adapter.spawn(agentType, prompt, options);
  }

  async stop(runId: string, options?: { timeoutMs?: number }): Promise<boolean> {
    const adapter = await this.resolveActiveAdapter();
    return adapter.stop(runId, options);
  }

  async interrupt(
    runId: string,
    options?: { timeoutMs?: number },
  ): Promise<boolean> {
    const adapter = await this.resolveActiveAdapter();
    if (adapter.interrupt) return adapter.interrupt(runId, options);
    return adapter.stop(runId, options);
  }

  async status(runId: string, options?: { timeoutMs?: number }): Promise<unknown> {
    const adapter = await this.resolveActiveAdapter();
    if (adapter.status) return adapter.status(runId, options);
    return undefined;
  }

  onCompletion(
    runId: string,
    callback: (result: SubagentCompletionResult) => void,
  ): () => void {
    const unsubNico = this.nicopreme.onCompletion(runId, callback);
    const unsubTintin = this.tintinweb.onCompletion(runId, callback);
    return () => {
      unsubNico();
      unsubTintin();
    };
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.nicopreme.dispose?.();
    this.tintinweb.dispose?.();
  }
}

function resolveEnvProvider(): "nicopreme" | "tintinweb" | undefined {
  const envVal = (
    process.env.PI_FUSION_SUBAGENT_PROVIDER ||
    process.env.PI_SUBAGENTS_PROVIDER ||
    ""
  )
    .trim()
    .toLowerCase();
  if (envVal === "tintinweb") return "tintinweb";
  if (envVal === "nicopreme" || envVal === "nicobailon" || envVal === "unscoped") {
    return "nicopreme";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractRecordId(record: Record<string, unknown>): string | undefined {
  if (typeof record.id === "string" && record.id.trim()) return record.id.trim();
  if (typeof record.runId === "string" && record.runId.trim()) return record.runId.trim();
  return undefined;
}

function isSubagentPayloadError(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.success === false || payload.isError === true) return true;
  if (payload.state === "failed" || payload.status === "failed") return true;
  if (payload.error) return true;
  return false;
}

function extractPayloadError(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (typeof payload.errorMessage === "string") return payload.errorMessage;
  return undefined;
}

function extractPayloadOutput(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.output === "string") return payload.output;
  if (typeof payload.result === "string") return payload.result;
  if (typeof payload.text === "string") return payload.text;
  if (isRecord(payload.details)) return extractPayloadOutput(payload.details);
  return undefined;
}
