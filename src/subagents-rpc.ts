import { randomUUID } from "node:crypto";

export const SUBAGENTS_RPC_VERSION = 1;
export const SUBAGENTS_RPC_REQUEST_CHANNEL = "subagents:rpc:v1:request";
export const SUBAGENTS_RPC_REPLY_CHANNEL_PREFIX = "subagents:rpc:v1:reply:";
export const DEFAULT_SUBAGENTS_RPC_TIMEOUT_MS = 15_000;

export const SUBAGENTS_RPC_METHODS = [
  "ping",
  "spawn",
  "status",
  "stop",
  "interrupt",
] as const;

export type SubagentsRpcMethod = (typeof SUBAGENTS_RPC_METHODS)[number];

export interface SubagentsEventBus {
  on(event: string, handler: (payload: unknown) => void): (() => void) | void;
  emit(event: string, payload: unknown): void;
}

export interface SubagentsRpcSource {
  extension?: string;
}

export interface SubagentsRpcClientOptions {
  events: SubagentsEventBus;
  timeoutMs?: number;
  requestId?: () => string;
  source?: SubagentsRpcSource;
}

export interface SubagentsRpcRequestOptions {
  timeoutMs?: number;
}

export interface SubagentsTargetParams {
  id?: string;
  runId?: string;
  dir?: string;
  index?: number;
}

export type SubagentsSpawnParams = object;

export interface SubagentsRpcRequestEnvelope {
  version: typeof SUBAGENTS_RPC_VERSION;
  requestId: string;
  method: SubagentsRpcMethod;
  params?: unknown;
  source?: SubagentsRpcSource;
}

export type SubagentsRpcReplyEnvelope =
  | {
      version: typeof SUBAGENTS_RPC_VERSION;
      requestId: string;
      method?: SubagentsRpcMethod;
      success: true;
      data: unknown;
    }
  | {
      version: typeof SUBAGENTS_RPC_VERSION;
      requestId: string;
      method?: SubagentsRpcMethod;
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

export class SubagentsRpcRemoteError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly method: SubagentsRpcMethod;

  constructor(input: {
    code: string;
    message: string;
    requestId: string;
    method: SubagentsRpcMethod;
  }) {
    super(input.message);
    this.name = "SubagentsRpcRemoteError";
    this.code = input.code;
    this.requestId = input.requestId;
    this.method = input.method;
  }
}

export class SubagentsRpcProtocolError extends Error {
  readonly requestId: string;
  readonly method: SubagentsRpcMethod;

  constructor(input: {
    message: string;
    requestId: string;
    method: SubagentsRpcMethod;
  }) {
    super(input.message);
    this.name = "SubagentsRpcProtocolError";
    this.requestId = input.requestId;
    this.method = input.method;
  }
}

export class SubagentsRpcTimeoutError extends Error {
  readonly requestId: string;
  readonly method: SubagentsRpcMethod;
  readonly timeoutMs: number;

  constructor(input: {
    requestId: string;
    method: SubagentsRpcMethod;
    timeoutMs: number;
  }) {
    super(
      `Subagents RPC ${input.method} request ${input.requestId} timed out after ${input.timeoutMs}ms.`,
    );
    this.name = "SubagentsRpcTimeoutError";
    this.requestId = input.requestId;
    this.method = input.method;
    this.timeoutMs = input.timeoutMs;
  }
}

export function subagentsRpcReplyChannel(requestId: string): string {
  return `${SUBAGENTS_RPC_REPLY_CHANNEL_PREFIX}${requestId}`;
}

export class SubagentsRpcClient {
  private readonly events: SubagentsEventBus;
  private readonly timeoutMs: number;
  private readonly createRequestId: () => string;
  private readonly source: SubagentsRpcSource;

  constructor(options: SubagentsRpcClientOptions) {
    this.events = options.events;
    this.timeoutMs = normalizeTimeoutMs(
      options.timeoutMs ?? DEFAULT_SUBAGENTS_RPC_TIMEOUT_MS,
    );
    this.createRequestId = options.requestId ?? randomUUID;
    this.source = options.source ?? { extension: "pi-fusion" };
  }

  request<T = unknown>(
    method: SubagentsRpcMethod,
    params?: unknown,
    options: SubagentsRpcRequestOptions = {},
  ): Promise<T> {
    const requestId = this.createRequestId();
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? this.timeoutMs);
    const replyChannel = subagentsRpcReplyChannel(requestId);
    const envelope = createRequestEnvelope({
      requestId,
      method,
      params,
      source: this.source,
    });

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout>;

      const cleanup = (): void => {
        clearTimeout(timer);
        if (unsubscribe) unsubscribe();
      };

      const resolveOnce = (value: T): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      timer = setTimeout(() => {
        rejectOnce(
          new SubagentsRpcTimeoutError({ requestId, method, timeoutMs }),
        );
      }, timeoutMs);

      const maybeUnsubscribe = this.events.on(
        replyChannel,
        (payload: unknown) => {
          if (!isRecord(payload) || payload.requestId !== requestId) return;

          let reply: SubagentsRpcReplyEnvelope;
          try {
            reply = parseReplyEnvelope(payload, method, requestId);
          } catch (error: unknown) {
            rejectOnce(
              error instanceof Error
                ? error
                : new SubagentsRpcProtocolError({
                    requestId,
                    method,
                    message: String(error),
                  }),
            );
            return;
          }

          if (reply.success) {
            resolveOnce(reply.data as T);
            return;
          }

          rejectOnce(
            new SubagentsRpcRemoteError({
              requestId,
              method,
              code: reply.error.code,
              message: reply.error.message,
            }),
          );
        },
      );
      if (typeof maybeUnsubscribe === "function")
        unsubscribe = maybeUnsubscribe;

      try {
        this.events.emit(SUBAGENTS_RPC_REQUEST_CHANNEL, envelope);
      } catch (error: unknown) {
        rejectOnce(
          error instanceof Error
            ? error
            : new SubagentsRpcProtocolError({
                requestId,
                method,
                message: String(error),
              }),
        );
      }
    });
  }

  ping(options?: SubagentsRpcRequestOptions): Promise<unknown> {
    return this.request("ping", undefined, options);
  }

  spawn(
    params: SubagentsSpawnParams,
    options?: SubagentsRpcRequestOptions,
  ): Promise<unknown> {
    return this.request("spawn", params, options);
  }

  status(
    params: SubagentsTargetParams = {},
    options?: SubagentsRpcRequestOptions,
  ): Promise<unknown> {
    return this.request("status", params, options);
  }

  stop(
    params: SubagentsTargetParams,
    options?: SubagentsRpcRequestOptions,
  ): Promise<unknown> {
    return this.request("stop", params, options);
  }

  interrupt(
    params: SubagentsTargetParams,
    options?: SubagentsRpcRequestOptions,
  ): Promise<unknown> {
    return this.request("interrupt", params, options);
  }
}

function createRequestEnvelope(input: {
  requestId: string;
  method: SubagentsRpcMethod;
  params?: unknown;
  source: SubagentsRpcSource;
}): SubagentsRpcRequestEnvelope {
  return {
    version: SUBAGENTS_RPC_VERSION,
    requestId: input.requestId,
    method: input.method,
    ...(input.params !== undefined ? { params: input.params } : {}),
    ...(Object.keys(input.source).length > 0 ? { source: input.source } : {}),
  };
}

function parseReplyEnvelope(
  payload: Record<string, unknown>,
  expectedMethod: SubagentsRpcMethod,
  requestId: string,
): SubagentsRpcReplyEnvelope {
  if (payload.version !== SUBAGENTS_RPC_VERSION) {
    throw new SubagentsRpcProtocolError({
      requestId,
      method: expectedMethod,
      message: `Unsupported subagents RPC reply version: ${String(payload.version)}.`,
    });
  }

  const method = parseOptionalMethod(payload.method, expectedMethod, requestId);
  if (method && method !== expectedMethod) {
    throw new SubagentsRpcProtocolError({
      requestId,
      method: expectedMethod,
      message: `Subagents RPC reply method ${method} did not match ${expectedMethod}.`,
    });
  }

  if (payload.success === true) {
    return {
      version: SUBAGENTS_RPC_VERSION,
      requestId,
      ...(method ? { method } : {}),
      success: true,
      data: payload.data,
    };
  }

  if (payload.success === false) {
    if (!isRecord(payload.error)) {
      throw new SubagentsRpcProtocolError({
        requestId,
        method: expectedMethod,
        message: "Subagents RPC failure reply did not include an error object.",
      });
    }
    if (
      typeof payload.error.code !== "string" ||
      typeof payload.error.message !== "string"
    ) {
      throw new SubagentsRpcProtocolError({
        requestId,
        method: expectedMethod,
        message:
          "Subagents RPC failure reply error must include code and message.",
      });
    }
    return {
      version: SUBAGENTS_RPC_VERSION,
      requestId,
      ...(method ? { method } : {}),
      success: false,
      error: {
        code: payload.error.code,
        message: payload.error.message,
      },
    };
  }

  throw new SubagentsRpcProtocolError({
    requestId,
    method: expectedMethod,
    message: "Subagents RPC reply success flag must be true or false.",
  });
}

function parseOptionalMethod(
  value: unknown,
  expectedMethod: SubagentsRpcMethod,
  requestId: string,
): SubagentsRpcMethod | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    (SUBAGENTS_RPC_METHODS as readonly string[]).includes(value)
  ) {
    return value as SubagentsRpcMethod;
  }
  throw new SubagentsRpcProtocolError({
    requestId,
    method: expectedMethod,
    message: `Unsupported subagents RPC reply method: ${String(value)}.`,
  });
}

function normalizeTimeoutMs(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError("Subagents RPC timeoutMs must be a positive integer.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
