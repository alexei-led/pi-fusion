import { createHash } from "node:crypto";
import type { ExecutionLifetime, FusionRun } from "./types.js";
import { isRecord } from "./utils.js";

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
  const { executionLifetime, durableOperations, processTerminalProof, workflowTerminalProof } = info.capabilities;
  return isRecord(executionLifetime) && executionLifetime.version === 1 &&
    Array.isArray(executionLifetime.modes) && executionLifetime.modes.includes("unbounded") && executionLifetime.modes.includes("bounded") &&
    isRecord(durableOperations) && durableOperations.version === 1 &&
    durableOperations.lookup === true && durableOperations.replay === true && durableOperations.cancelFence === true &&
    isRecord(processTerminalProof) && processTerminalProof.version === 1 &&
    isRecord(workflowTerminalProof) && workflowTerminalProof.version === 1;
}

export function supportsTreeOwnership(info: unknown): boolean {
  if (!isRecord(info) || !isRecord(info.capabilities)) return false;
  const ownership = info.capabilities.processTreeOwnership;
  return isRecord(ownership) && ownership.version === 1 && ownership.scope === "owned-process-tree" && ownership.escapedDescendants === "contained";
}

export function nativeTerminalProof(payload: unknown, runId: string): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const proof = payload.workflowTerminalProof ?? payload.processTerminalProof;
  if (!isRecord(proof) || proof.runId !== runId || !isObservedProof(proof)) return undefined;
  return proof;
}

function isObservedProof(proof: Record<string, unknown>, seen = new Set<unknown>()): boolean {
  if (seen.has(proof) || proof.version !== 1 || proof.state !== "observed" ||
    typeof proof.runId !== "string" || !proof.runId.trim() ||
    typeof proof.observedAt !== "number" || !Number.isFinite(proof.observedAt)) return false;
  seen.add(proof);
  if (proof.kind === "workflow") return proof.dispatchClosed === true &&
    Array.isArray(proof.children) && proof.children.every((child: unknown) => isRecord(child) && isObservedProof(child, seen));
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
