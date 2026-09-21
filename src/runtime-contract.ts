import { createHash } from "node:crypto";
import type { ExecutionLifetime, FusionRun } from "./types.js";
import { isRecord } from "./utils.js";
import { isRetiredKernelProof, type NativeOperationIdentity } from "./kernel-proof.js";

export function isExecutionLifetime(value: unknown): value is ExecutionLifetime {
  return isRecord(value) && (value.mode === "unbounded"
    ? value.timeoutMs === undefined
    : value.mode === "bounded" && typeof value.timeoutMs === "number" &&
      Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0);
}

export function sameLifetime(left: unknown, right: ExecutionLifetime): boolean {
  return isExecutionLifetime(left) && left.mode === right.mode &&
    (left.mode === "unbounded" || (right.mode === "bounded" && left.timeoutMs === right.timeoutMs));
}

export function requestDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function supportsExecutionContract(info: unknown): boolean {
  if (!isRecord(info) || !isRecord(info.capabilities)) return false;
  const { executionLifetime, durableOperations, processTerminalProof } = info.capabilities;
  return isRecord(executionLifetime) && executionLifetime.version === 1 &&
    Array.isArray(executionLifetime.modes) && executionLifetime.modes.includes("unbounded") && executionLifetime.modes.includes("bounded") &&
    isRecord(durableOperations) && durableOperations.version === 1 &&
    durableOperations.lookup === true && durableOperations.replay === true && durableOperations.cancelFence === true &&
    isRecord(processTerminalProof) && processTerminalProof.version === 1;
}

export function supportsTreeOwnership(info: unknown): boolean {
  if (!isRecord(info) || !isRecord(info.capabilities)) return false;
  const ownership = info.capabilities.processTreeOwnership;
  return isRecord(ownership) && ownership.version === 1 && ownership.scope === "owned-process-tree" && ownership.escapedDescendants === "contained";
}

export function supportsOwnedFusionRoutes(info: unknown): boolean {
  if (!supportsTreeOwnership(info) || !isRecord(info) || !isRecord(info.capabilities) || !isRecord(info.capabilities.processTreeOwnership)) return false;
  const ownership = info.capabilities.processTreeOwnership;
  return ownership.requestMode === "kernel" && Array.isArray(ownership.routes) && ownership.routes.includes("single-async") && ownership.routes.includes("parallel-data");
}

export function expectedExecutionRoute(params: unknown): "parallel-data" | "single-async" | undefined {
  if (!isRecord(params) || !isRecord(params.executionOwnership) || params.executionOwnership.mode !== "kernel" || params.workflowScript !== undefined) return undefined;
  if (isRecord(params.ownedWorkflow) && params.ownedWorkflow.version === 1 && params.ownedWorkflow.kind === "parallel") return "parallel-data";
  if (typeof params.agent === "string" && typeof params.task === "string") return "single-async";
  return undefined;
}

export function verifiesExecutionOwnership(reply: unknown, params: unknown): boolean {
  const route = expectedExecutionRoute(params);
  return route !== undefined && isRecord(reply) && isRecord(reply.effectiveExecutionOwnership) && reply.effectiveExecutionOwnership.mode === "kernel" && reply.executionRoute === route;
}

export function nativeTerminalProof(payload: unknown, runId: string, expectedNative?: NativeOperationIdentity): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  if (expectedNative) {
    const proof = payload.processTerminalProof;
    if (!isRecord(proof) || proof.kind === "workflow" || proof.runId !== runId || !isObservedProof(proof) || !isRetiredKernelProof(proof, expectedNative)) return undefined;
    return proof;
  }
  const proof = payload.workflowTerminalProof ?? payload.processTerminalProof;
  if (!isRecord(proof) || proof.kind !== "workflow" || proof.runId !== runId || !isObservedProof(proof)) return undefined;
  return proof;
}

function isObservedProof(proof: Record<string, unknown>, seen = new Set<unknown>()): boolean {
  if (seen.has(proof) || proof.version !== 1 || proof.state !== "observed" ||
    typeof proof.runId !== "string" || !proof.runId.trim() ||
    typeof proof.observedAt !== "number" || !Number.isFinite(proof.observedAt)) return false;
  seen.add(proof);
  if (proof.kind === "workflow") return proof.dispatchClosed === true &&
    Array.isArray(proof.children) && proof.children.every((child: unknown) => isRecord(child) && isObservedProof(child, seen));
  if (proof.kernelProof !== undefined) return supportsTreeOwnership({ capabilities: proof }) && typeof proof.runnerProcessInstanceId === "string" && Boolean(proof.runnerProcessInstanceId.trim()) && isRetiredKernelProof(proof);
  return supportsTreeOwnership({ capabilities: proof }) && typeof proof.runnerProcessInstanceId === "string" && Boolean(proof.runnerProcessInstanceId.trim()) && Array.isArray(proof.instances) &&
    proof.instances.every((instance: unknown) => {
      if (!isRecord(instance) || !isRecord(instance.processTree)) return true;
      return instance.processTree.mechanism !== "posix-process-group" && instance.processTree.containment !== "unverified";
    });
}

/** A Fusion terminal proof is the conjunction of its durable native stage proofs. */
export function aggregateTerminalProof(run: FusionRun, proof: Record<string, unknown>): Record<string, unknown> {
  const previous = isRecord(run.processTerminalProof) && Array.isArray(run.processTerminalProof.children)
    ? run.processTerminalProof.children.filter(isRecord) : [];
  const sources = [...previous.filter((item) => item.runId !== proof.runId), proof];
  return {
    version: 1, kind: "workflow", state: "observed", runId: run.id, dispatchClosed: true,
    observedAt: Math.max(...sources.map((item) => Number(item.observedAt))),
    children: sources,
  };
}
