import type {
  FusionCommandContext,
  FusionCommandResult,
} from "./orchestrator.js";
import type { FusionRunStore } from "./run-store.js";
import type { FusionPhase, FusionRun, ParsedFusionArgs } from "./types.js";
import { isNonEmptyString, isRecord } from "./utils.js";

export const FUSION_RPC_VERSION = 1;
export const FUSION_RPC_REQUEST_EVENT = "fusion:rpc:v1:request";
export const FUSION_RPC_REPLY_EVENT_PREFIX = "fusion:rpc:v1:reply:";

export const FUSION_RPC_METHODS = [
  "ping",
  "start",
  "status",
  "result",
  "cancel",
  "adopt",
] as const;

export type FusionRpcMethod = (typeof FUSION_RPC_METHODS)[number];

export type FusionRpcErrorCode =
  | "invalid_request"
  | "unsupported_method"
  | "busy"
  | "not_found"
  | "not_ready"
  | "unavailable"
  | "start_failed"
  | "cancel_failed"
  | "internal";

export interface FusionRpcRequestEnvelope {
  version: typeof FUSION_RPC_VERSION;
  requestId: string;
  method: FusionRpcMethod;
  params?: unknown;
}

export interface FusionRpcError {
  code: FusionRpcErrorCode;
  message: string;
  details?: unknown;
}

export interface FusionRunState {
  runId: string;
  operationId?: string;
  phase: FusionPhase;
  terminal: boolean;
  report?: string;
  error?: string;
}

export interface FusionRpcPingData {
  pong: true;
  version: typeof FUSION_RPC_VERSION;
  methods: readonly FusionRpcMethod[];
}

export interface FusionRpcStartData {
  operationId: string;
  replayed: boolean;
  run: FusionRunState;
}

export interface FusionRpcStatusData {
  run: FusionRunState;
}

export interface FusionRpcResultData {
  run: FusionRunState;
}

export interface FusionRpcCancelData {
  cancelled: boolean;
  run?: FusionRunState;
}

export interface FusionRpcAdoptData {
  adopted: true;
  run: FusionRunState;
}

export type FusionRpcReplyEnvelope =
  | {
      version: typeof FUSION_RPC_VERSION;
      requestId: string;
      method?: FusionRpcMethod;
      success: true;
      data: unknown;
    }
  | {
      version: typeof FUSION_RPC_VERSION;
      requestId: string;
      method?: FusionRpcMethod;
      success: false;
      error: FusionRpcError;
    };

export interface FusionRpcEventBus {
  on(event: string, handler: (payload: unknown) => void): (() => void) | void;
  emit(event: string, payload: unknown): void;
}

export interface FusionRpcOrchestrator {
  startRun(
    input: ParsedFusionArgs,
    ctx: FusionCommandContext,
  ): Promise<FusionCommandResult>;
  cancelActiveRun(ctx: FusionCommandContext): Promise<FusionCommandResult>;
}

type FusionRpcRunStore = Pick<
  FusionRunStore,
  "getActiveRun" | "getLastRunSummary" | "getRunById" | "getRunByOperationId"
>;

export interface FusionRpcDependencies {
  events: FusionRpcEventBus;
  orchestrator: FusionRpcOrchestrator;
  store: FusionRpcRunStore;
  getContext: () => FusionCommandContext | undefined;
}

interface OperationRecord {
  pending?: Promise<FusionRpcStartData>;
  runId?: string;
}

interface StartParams {
  prompt: string;
  profile?: string;
  operationId: string;
}

interface RunParams {
  runId?: string;
  operationId?: string;
}

type ObservableRun = Pick<
  FusionRun,
  "id" | "operationId" | "phase" | "report" | "error"
>;

const TERMINAL_PHASES = new Set<FusionPhase>(["done", "failed", "cancelled"]);

export function fusionRpcReplyEvent(requestId: string): string {
  return `${FUSION_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

export function registerFusionRpc({
  events,
  orchestrator,
  store,
  getContext,
}: FusionRpcDependencies): () => void {
  const operations = new Map<string, OperationRecord>();
  const unsubscribe = events.on(FUSION_RPC_REQUEST_EVENT, (event) => {
    void handleRequest(event);
  });

  return typeof unsubscribe === "function" ? unsubscribe : () => undefined;

  async function handleRequest(event: unknown): Promise<void> {
    const request = parseRequest(event);
    if (request instanceof RpcRequestFailure) {
      if (request.requestId) {
        replyFailure(request.requestId, request.method, request.error);
      }
      return;
    }

    try {
      const data = await dispatch(request);
      replySuccess(request.requestId, request.method, data);
    } catch (error: unknown) {
      replyFailure(request.requestId, request.method, normalizeError(error));
    }
  }

  async function dispatch(request: FusionRpcRequestEnvelope): Promise<unknown> {
    switch (request.method) {
      case "ping":
        return {
          pong: true,
          version: FUSION_RPC_VERSION,
          methods: FUSION_RPC_METHODS,
        } satisfies FusionRpcPingData;
      case "start":
        return start(request.params);
      case "status":
        return {
          run: stateFor(findRun(request.params, operations, store, "status")),
        } satisfies FusionRpcStatusData;
      case "result":
        return result(request.params);
      case "cancel":
        return cancel(request.params);
      case "adopt":
        return adopt(request.params);
    }
  }

  async function start(params: unknown): Promise<FusionRpcStartData> {
    const input = parseStartParams(params);
    const persisted = store.getRunByOperationId(input.operationId);
    if (persisted) return startData(input.operationId, persisted, true);

    const known = operations.get(input.operationId);
    if (known?.runId) {
      const run = store.getRunById(known.runId);
      if (run) return startData(input.operationId, run, true);
      operations.delete(input.operationId);
    } else if (known?.pending) {
      const response = await known.pending;
      return { ...response, replayed: true };
    }

    const context = requireContext(getContext());
    const pending = orchestrator
      .startRun(toParsedFusionArgs(input), context)
      .then((result) =>
        startData(
          input.operationId,
          runFromStartResult(result, input.operationId, store),
          false,
        ),
      );
    operations.set(input.operationId, { pending });

    try {
      const response = await pending;
      operations.set(input.operationId, { runId: response.run.runId });
      return response;
    } catch (error: unknown) {
      operations.delete(input.operationId);
      throw error;
    }
  }

  function result(params: unknown): FusionRpcResultData {
    const run = findRun(params, operations, store, "result");
    const state = stateFor(run);
    if (!state.terminal) {
      throw new RpcFailure({
        code: "not_ready",
        message: `Fusion run ${state.runId} is not terminal.`,
        details: { run: state },
      });
    }
    return { run: state };
  }

  async function cancel(params: unknown): Promise<FusionRpcCancelData> {
    const selector = parseRunParams(params, "cancel");
    const selected = hasRunSelector(selector)
      ? findRun(params, operations, store, "cancel")
      : undefined;
    const active = store.getActiveRun();

    if (selected && TERMINAL_PHASES.has(selected.phase)) {
      return { cancelled: false, run: stateFor(selected) };
    }
    if (!active) {
      const last = selected ?? store.getLastRunSummary();
      return last
        ? { cancelled: false, run: stateFor(last) }
        : { cancelled: false };
    }
    if (selected && selected.id !== active.id) {
      return { cancelled: false, run: stateFor(selected) };
    }

    const context = requireContext(getContext());
    const cancellation = await orchestrator.cancelActiveRun(context);
    if (cancellation.status === "cancelled") {
      return { cancelled: true, run: stateFor(cancellation.run) };
    }
    if (cancellation.status === "failed") {
      throw new RpcFailure({
        code: "cancel_failed",
        message: cancellation.error,
        details: { run: stateFor(active) },
      });
    }

    const current = store.getRunById(active.id);
    if (!current) return { cancelled: false };
    return {
      cancelled: current.phase === "cancelled",
      run: stateFor(current),
    };
  }

  function adopt(params: unknown): FusionRpcAdoptData {
    const runId = parseAdoptParams(params);
    const run = store.getRunById(runId);
    if (!run) {
      throw new RpcFailure({
        code: "not_found",
        message: "Fusion run was not found in this session history.",
        details: { runId },
      });
    }
    return { adopted: true, run: stateFor(run) };
  }

  function replySuccess(
    requestId: string,
    method: FusionRpcMethod,
    data: unknown,
  ): void {
    events.emit(fusionRpcReplyEvent(requestId), {
      version: FUSION_RPC_VERSION,
      requestId,
      method,
      success: true,
      data,
    } satisfies FusionRpcReplyEnvelope);
  }

  function replyFailure(
    requestId: string,
    method: FusionRpcMethod | undefined,
    error: FusionRpcError,
  ): void {
    events.emit(fusionRpcReplyEvent(requestId), {
      version: FUSION_RPC_VERSION,
      requestId,
      ...(method === undefined ? {} : { method }),
      success: false,
      error,
    } satisfies FusionRpcReplyEnvelope);
  }
}

function parseRequest(
  input: unknown,
): FusionRpcRequestEnvelope | RpcRequestFailure {
  if (!isRecord(input)) {
    return new RpcRequestFailure(undefined, undefined, {
      code: "invalid_request",
      message: "RPC request must be an object.",
    });
  }

  const requestId = input.requestId;
  const method = input.method;
  if (!isNonEmptyString(requestId)) {
    return new RpcRequestFailure(undefined, undefined, {
      code: "invalid_request",
      message: "RPC requestId must be a non-empty string.",
    });
  }
  if (!isMethod(method)) {
    return new RpcRequestFailure(requestId, undefined, {
      code: "unsupported_method",
      message: "RPC method is unsupported.",
    });
  }
  if (input.version !== FUSION_RPC_VERSION) {
    return new RpcRequestFailure(requestId, method, {
      code: "invalid_request",
      message: `RPC version must be ${FUSION_RPC_VERSION}.`,
    });
  }

  return input.params === undefined
    ? { version: FUSION_RPC_VERSION, requestId, method }
    : {
        version: FUSION_RPC_VERSION,
        requestId,
        method,
        params: input.params,
      };
}

function parseStartParams(input: unknown): StartParams {
  if (!isRecord(input)) {
    throw invalidParams("start parameters must be an object.");
  }

  const prompt = input.prompt;
  if (!isNonEmptyString(prompt)) {
    throw invalidParams("start prompt must be a non-empty string.");
  }

  const operationId = input.operationId;
  if (!isNonEmptyString(operationId)) {
    throw invalidParams("start operationId must be a non-empty string.");
  }

  const profile = input.profile;
  if (profile !== undefined && !isNonEmptyString(profile)) {
    throw invalidParams(
      "start profile must be a non-empty string when provided.",
    );
  }

  return profile === undefined
    ? { prompt, operationId }
    : { prompt, operationId, profile };
}

function toParsedFusionArgs(input: StartParams): ParsedFusionArgs {
  return input.profile === undefined
    ? { prompt: input.prompt, operationId: input.operationId }
    : {
        prompt: input.prompt,
        profile: input.profile,
        operationId: input.operationId,
      };
}

function findRun(
  input: unknown,
  operations: ReadonlyMap<string, OperationRecord>,
  store: FusionRpcRunStore,
  method: "status" | "result" | "cancel",
): ObservableRun {
  const params = parseRunParams(input, method);
  if (params.operationId) {
    const persisted = store.getRunByOperationId(params.operationId);
    if (persisted) return persisted;

    const operation = operations.get(params.operationId);
    if (operation?.runId) {
      const run = store.getRunById(operation.runId);
      if (run) return run;
    }
    if (operation?.pending) {
      const active = store.getActiveRun();
      if (active?.operationId === params.operationId) return active;
      throw new RpcFailure({
        code: "not_ready",
        message: `Fusion operation ${params.operationId} has not produced a run yet.`,
        details: { operationId: params.operationId },
      });
    }
    throw notFound({ operationId: params.operationId });
  }
  if (params.runId) {
    const run = store.getRunById(params.runId);
    if (!run) throw notFound({ runId: params.runId });
    return run;
  }

  const run = store.getActiveRun() ?? store.getLastRunSummary();
  if (!run) throw notFound();
  return run;
}

function parseRunParams(
  input: unknown,
  method: "status" | "result" | "cancel",
): RunParams {
  if (input === undefined) return {};
  if (!isRecord(input)) {
    throw invalidParams(`${method} parameters must be an object.`);
  }

  const { operationId, runId } = input;
  if (operationId !== undefined && !isNonEmptyString(operationId)) {
    throw invalidParams(
      "operationId must be a non-empty string when provided.",
    );
  }
  if (runId !== undefined && !isNonEmptyString(runId)) {
    throw invalidParams("runId must be a non-empty string when provided.");
  }
  if (operationId !== undefined && runId !== undefined) {
    throw invalidParams("Specify either operationId or runId, not both.");
  }

  if (operationId !== undefined) return { operationId };
  return runId === undefined ? {} : { runId };
}

function hasRunSelector(params: RunParams): boolean {
  return params.operationId !== undefined || params.runId !== undefined;
}

function parseAdoptParams(input: unknown): string {
  if (!isRecord(input) || !isNonEmptyString(input.runId)) {
    throw invalidParams("adopt runId must be a non-empty string.");
  }
  return input.runId;
}

function runFromStartResult(
  result: FusionCommandResult,
  operationId: string,
  store: FusionRpcRunStore,
): ObservableRun {
  switch (result.status) {
    case "started":
    case "done":
    case "cancelled":
      return result.run;
    case "conflict": {
      const active = store.getRunById(result.activeRunId);
      throw new RpcFailure({
        code: "busy",
        message: `Fusion run ${result.activeRunId} is already active.`,
        details: {
          activeRunId: result.activeRunId,
          ...(active ? { run: stateFor(active) } : {}),
        },
      });
    }
    case "failed":
      throw startFailure(result.error, store.getRunByOperationId(operationId));
    case "ignored": {
      const persisted = store.getRunByOperationId(operationId);
      if (persisted) return persisted;
      throw new RpcFailure({
        code: "internal",
        message: "Fusion run did not start.",
      });
    }
  }
}

function startData(
  operationId: string,
  run: ObservableRun,
  replayed: boolean,
): FusionRpcStartData {
  if (run.phase === "failed") {
    throw startFailure(run.error ?? "Fusion run failed to start.", run);
  }
  return {
    operationId,
    replayed,
    run: stateFor(run),
  };
}

function startFailure(message: string, run?: ObservableRun): RpcFailure {
  return new RpcFailure({
    code: "start_failed",
    message,
    ...(run ? { details: { run: stateFor(run) } } : {}),
  });
}

function stateFor(run: ObservableRun): FusionRunState {
  const state: FusionRunState = {
    runId: run.id,
    ...(run.operationId !== undefined ? { operationId: run.operationId } : {}),
    phase: run.phase,
    terminal: TERMINAL_PHASES.has(run.phase),
  };
  if (run.report !== undefined) state.report = run.report;
  if (run.error !== undefined) state.error = run.error;
  return state;
}

function requireContext(
  context: FusionCommandContext | undefined,
): FusionCommandContext {
  if (context) return context;
  throw new RpcFailure({
    code: "unavailable",
    message: "Fusion session context is unavailable.",
  });
}

function isMethod(value: unknown): value is FusionRpcMethod {
  return (
    value === "ping" ||
    value === "start" ||
    value === "status" ||
    value === "result" ||
    value === "cancel" ||
    value === "adopt"
  );
}

function invalidParams(message: string): RpcFailure {
  return new RpcFailure({ code: "invalid_request", message });
}

function notFound(details?: unknown): RpcFailure {
  return new RpcFailure({
    code: "not_found",
    message: "Fusion run was not found.",
    ...(details === undefined ? {} : { details }),
  });
}

function normalizeError(error: unknown): FusionRpcError {
  if (error instanceof RpcFailure) return error.error;
  return {
    code: "internal",
    message:
      error instanceof Error ? error.message : "Unexpected Fusion RPC error.",
  };
}

class RpcFailure extends Error {
  constructor(readonly error: FusionRpcError) {
    super(error.message);
  }
}

class RpcRequestFailure extends Error {
  constructor(
    readonly requestId: string | undefined,
    readonly method: FusionRpcMethod | undefined,
    readonly error: FusionRpcError,
  ) {
    super(error.message);
  }
}
