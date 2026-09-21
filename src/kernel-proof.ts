import { isRecord } from "./utils.js";

export interface NativeOperationIdentity {
  operationId: string;
  digest: string;
}

interface KernelBinding {
  operationId: string;
  requestDigest: string;
  hostId: string;
  bootId: string;
}

interface KernelProcessIdentity {
  pid: number;
  uniqueId: string;
  pidVersion: number;
}

interface KernelIdentity extends KernelBinding {
  version: 1;
  backend: "darwin-resource-coalition-v1";
  coalitionId: string;
  leader: KernelProcessIdentity;
}

/** Validate the native mapping separately from the kernel module's prepared identity. */
export function isRetiredKernelProof(value: unknown, expectedNative?: NativeOperationIdentity): boolean {
  if (!isRecord(value) || !isRecord(value.nativeOperation) || !nonBlank(value.nativeOperation.operationId) || !nonBlank(value.nativeOperation.digest)) return false;
  if (expectedNative && (value.nativeOperation.operationId !== expectedNative.operationId || value.nativeOperation.digest !== expectedNative.digest)) return false;
  const binding = kernelBinding(value.kernelBinding);
  const observation = value.kernelProof;
  if (!binding || !isRecord(observation) || observation.status !== "retired" || !sameBinding(observation.binding, binding)) return false;
  const identity = kernelIdentity(observation.identity);
  const proof = observation.proof;
  if (!identity || !sameBinding(identity, binding) || !isRecord(proof) || proof.kind !== "darwin-coalition-retired" || !sameBinding(proof, binding) || !isoDate(proof.observedAt)) return false;
  const proofIdentity = kernelIdentity(proof.identity);
  return proofIdentity !== undefined && sameIdentity(proofIdentity, identity);
}

function kernelBinding(value: unknown): KernelBinding | undefined {
  if (!isRecord(value) || !nonBlank(value.operationId) || !nonBlank(value.requestDigest) || !uuid(value.hostId) || !uuid(value.bootId)) return undefined;
  return { operationId: value.operationId, requestDigest: value.requestDigest, hostId: value.hostId, bootId: value.bootId };
}

function sameBinding(value: unknown, expected: KernelBinding): boolean {
  const binding = kernelBinding(value);
  return binding !== undefined && binding.operationId === expected.operationId && binding.requestDigest === expected.requestDigest && binding.hostId === expected.hostId && binding.bootId === expected.bootId;
}

function kernelIdentity(value: unknown): KernelIdentity | undefined {
  const binding = kernelBinding(value);
  if (!binding || !isRecord(value) || value.version !== 1 || value.backend !== "darwin-resource-coalition-v1" || !positiveDecimal(value.coalitionId) || !isRecord(value.leader) ||
    !positiveInteger(value.leader.pid) || !positiveDecimal(value.leader.uniqueId) || typeof value.leader.pidVersion !== "number" || !Number.isInteger(value.leader.pidVersion) || value.leader.pidVersion < 0 || value.leader.pidVersion > 0xffff_ffff) return undefined;
  return { ...binding, version: 1, backend: "darwin-resource-coalition-v1", coalitionId: value.coalitionId, leader: { pid: value.leader.pid, uniqueId: value.leader.uniqueId, pidVersion: value.leader.pidVersion } };
}

function sameIdentity(left: KernelIdentity, right: KernelIdentity): boolean {
  return sameBinding(left, right) && left.coalitionId === right.coalitionId && left.leader.pid === right.leader.pid && left.leader.uniqueId === right.leader.uniqueId && left.leader.pidVersion === right.leader.pidVersion;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function positiveDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isoDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
