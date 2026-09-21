import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isExecutionLifetime, requestDigest } from "./runtime-contract.js";
import { isReviewContext } from "./review-context.js";
import type { ParsedFusionArgs } from "./types.js";
import { isRecord } from "./utils.js";

interface OperationIntent {
  version?: 2;
  operationId: string;
  digest: string;
  requestDigest?: string;
  recovery?: FusionPreflight;
}

export interface FusionPreflight {
  runId: string;
  createdAt: number;
  args: ParsedFusionArgs;
  argsDigest: string;
}

interface Admission {
  version: 1;
  operationId: string;
  state: "dispatching" | "never-started";
  digest?: string;
  requestDigest?: string;
}

export interface FusionOperationEvidence {
  operationId: string;
  state: "absent" | "pending" | "cancelled";
  replaySafe: boolean;
  cancellationRequested?: true;
  neverStarted?: boolean;
  requestDigest?: string;
  fusionRequestDigest?: string;
}

/** Immutable admission arbitration separates a cancellation fence from proof of no launch. */
export class FusionOperationJournal {
  constructor(private readonly directory: string) {}

  private path(operationId: string, suffix: string): string {
    return join(this.directory, `${requestDigest(operationId).slice(7)}.${suffix}`);
  }

  claim(operationId: string, digest: string, callerDigest?: string, args?: ParsedFusionArgs): "claimed" | "existing" | "cancelled" {
    this.ensureDirectory();
    if (this.cancelled(operationId)) return "cancelled";
    const intent: OperationIntent = {
      version: 2, operationId, digest, ...(callerDigest ? { requestDigest: callerDigest } : {}),
      ...(args ? { recovery: { runId: randomUUID(), createdAt: Date.now(), args, argsDigest: requestDigest(args) } } : {}),
    };
    try {
      this.publish(operationId, "intent", intent);
    } catch (error: unknown) {
      if (!isExists(error)) throw error;
      const saved = this.readIntent(operationId);
      if (!saved || saved.digest !== digest || saved.requestDigest !== callerDigest) {
        throw new Error("Fusion operationId was already claimed with a different request digest.", { cause: error });
      }
      return this.cancelled(operationId) ? "cancelled" : "existing";
    }
    return this.cancelled(operationId) ? "cancelled" : "claimed";
  }

  preflight(operationId: string): FusionPreflight | undefined {
    return this.readIntent(operationId)?.recovery;
  }

  hasDispatchAdmission(operationId: string): boolean {
    return this.readAdmission(operationId)?.state === "dispatching";
  }

  pendingPreflights(): FusionPreflight[] {
    this.ensureDirectory();
    const pending: FusionPreflight[] = [];
    for (const file of readdirSync(this.directory).filter((name) => name.endsWith(".intent"))) {
      const raw: unknown = JSON.parse(readFileSync(join(this.directory, file), "utf8"));
      if (!isRecord(raw) || typeof raw.operationId !== "string" || this.path(raw.operationId, "intent") !== join(this.directory, file)) throw new Error("Corrupt Fusion preflight intent.");
      const saved = this.readIntent(raw.operationId);
      if (saved?.recovery && !this.cancelled(raw.operationId)) pending.push(saved.recovery);
    }
    return pending;
  }

  /** Must win this durable gate before invoking any native spawn or replay. */
  beginDispatch(operationId: string, digest?: string): boolean {
    this.ensureDirectory();
    if (this.cancelled(operationId)) return false;
    const intent = this.readIntent(operationId);
    if (intent && digest !== undefined && intent.digest !== digest) throw new Error("Fusion dispatch digest does not match its durable intent.");
    const admission = this.admit({ version: 1, operationId, state: "dispatching", ...(digest ? { digest } : {}), ...(intent?.requestDigest ? { requestDigest: intent.requestDigest } : {}) });
    if (admission.digest !== undefined && digest !== undefined && admission.digest !== digest) throw new Error("Fusion dispatch digest does not match its admission.");
    return admission.state === "dispatching" && !this.cancelled(operationId);
  }

  cancel(operationId: string, mayHaveDispatched = false): FusionOperationEvidence {
    this.ensureDirectory();
    try { writeFileSync(this.path(operationId, "cancel"), "cancelled", { flag: "wx", mode: 0o600, flush: true }); }
    catch (error: unknown) { if (!isExists(error)) throw error; }
    const intent = this.readIntent(operationId);
    const legacyOrUnknownLaunch = intent?.version !== 2 && (intent !== undefined || mayHaveDispatched);
    this.admit({
      version: 1, operationId,
      state: legacyOrUnknownLaunch ? "dispatching" : "never-started",
      ...(intent ? { digest: intent.digest } : {}),
      ...(intent?.requestDigest ? { requestDigest: intent.requestDigest } : {}),
    });
    return this.lookup(operationId);
  }

  releaseBeforeLaunch(operationId: string, runId?: string): void {
    if (this.readAdmission(operationId)?.state === "dispatching") return;
    if (runId !== undefined && this.preflight(operationId)?.runId !== runId) return;
    try { unlinkSync(this.path(operationId, "intent")); }
    catch (error: unknown) { if (!isMissing(error)) throw error; }
  }

  cancelled(operationId: string): boolean {
    try { readFileSync(this.path(operationId, "cancel")); return true; }
    catch (error: unknown) { if (isMissing(error)) return false; throw error; }
  }

  state(operationId: string): FusionOperationEvidence["state"] {
    return this.lookup(operationId).state;
  }

  lookup(operationId: string): FusionOperationEvidence {
    const intent = this.readIntent(operationId);
    const admission = this.readAdmission(operationId);
    const fusionRequestDigest = intent?.digest ?? admission?.digest;
    const callerDigest = intent?.requestDigest ?? admission?.requestDigest;
    const identity = {
      operationId,
      ...(fusionRequestDigest ? { fusionRequestDigest } : {}),
      ...(callerDigest ? { requestDigest: callerDigest } : {}),
    };
    if (this.cancelled(operationId)) return { ...identity, state: "cancelled", replaySafe: false, cancellationRequested: true, neverStarted: admission?.state === "never-started" };
    if (admission?.state === "never-started") throw new Error("Fusion cancellation admission has no durable cancellation fence.");
    return { ...identity, state: intent || admission ? "pending" : "absent", replaySafe: !intent && !admission };
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  private admit(value: Admission): Admission {
    try {
      this.publish(value.operationId, "admission", value);
      return value;
    } catch (error: unknown) {
      if (!isExists(error)) throw error;
      const saved = this.readAdmission(value.operationId);
      if (!saved) throw new Error("Fusion admission disappeared during arbitration.", { cause: error });
      return saved;
    }
  }

  private publish(operationId: string, suffix: string, value: unknown): void {
    const target = this.path(operationId, suffix);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true });
      linkSync(temporary, target);
    } finally {
      try { unlinkSync(temporary); } catch { /* An unpublished temporary file cannot authorize dispatch. */ }
    }
  }

  private readIntent(operationId: string): OperationIntent | undefined {
    const saved = this.readJson(operationId, "intent");
    if (saved === undefined) return undefined;
    if (!isRecord(saved) || saved.operationId !== operationId || typeof saved.digest !== "string" || !saved.digest ||
      (saved.version !== undefined && saved.version !== 2) || (saved.requestDigest !== undefined && typeof saved.requestDigest !== "string")) throw new Error("Corrupt Fusion operation intent.");
    if (saved.recovery !== undefined && (!isPreflight(saved.recovery) || saved.recovery.args.operationId !== operationId || saved.recovery.args.requestDigest !== saved.digest)) throw new Error("Corrupt Fusion preflight request.");
    return { operationId, digest: saved.digest, ...(saved.version === 2 ? { version: 2 } : {}), ...(typeof saved.requestDigest === "string" ? { requestDigest: saved.requestDigest } : {}), ...(saved.recovery !== undefined ? { recovery: saved.recovery } : {}) };
  }

  private readAdmission(operationId: string): Admission | undefined {
    const saved = this.readJson(operationId, "admission");
    if (saved === undefined) return undefined;
    if (!isRecord(saved) || saved.version !== 1 || saved.operationId !== operationId || (saved.state !== "dispatching" && saved.state !== "never-started") ||
      (saved.digest !== undefined && typeof saved.digest !== "string") || (saved.requestDigest !== undefined && typeof saved.requestDigest !== "string")) throw new Error("Corrupt Fusion operation admission.");
    return { version: 1, operationId, state: saved.state, ...(typeof saved.digest === "string" ? { digest: saved.digest } : {}), ...(typeof saved.requestDigest === "string" ? { requestDigest: saved.requestDigest } : {}) };
  }

  private readJson(operationId: string, suffix: string): unknown {
    try { return JSON.parse(readFileSync(this.path(operationId, suffix), "utf8")) as unknown; }
    catch (error: unknown) { if (isMissing(error)) return undefined; throw error; }
  }
}

function isPreflight(value: unknown): value is FusionPreflight {
  if (!isRecord(value) || typeof value.runId !== "string" || !value.runId || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || !isRecord(value.args) || value.argsDigest !== requestDigest(value.args)) return false;
  const args = value.args;
  return typeof args.prompt === "string" && args.prompt.trim().length > 0 &&
    typeof args.operationId === "string" && typeof args.requestDigest === "string" && isExecutionLifetime(args.executionLifetime) &&
    (args.profile === undefined || (typeof args.profile === "string" && args.profile.trim().length > 0)) &&
    (args.reviewContext === undefined || isReviewContext(args.reviewContext)) &&
    (args.outputContract === undefined || args.outputContract === "plan-review-v1") &&
    args.panel === undefined && args.timeoutOverrides === undefined;
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
