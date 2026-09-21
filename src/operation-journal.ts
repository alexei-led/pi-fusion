import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestDigest } from "./runtime-contract.js";
import { isRecord } from "./utils.js";

interface OperationIntent {
  version?: 2;
  operationId: string;
  digest: string;
  requestDigest?: string;
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

  claim(operationId: string, digest: string, callerDigest?: string): "claimed" | "existing" | "cancelled" {
    this.ensureDirectory();
    if (this.cancelled(operationId)) return "cancelled";
    const intent: OperationIntent = { version: 2, operationId, digest, ...(callerDigest ? { requestDigest: callerDigest } : {}) };
    try {
      writeFileSync(this.path(operationId, "intent"), JSON.stringify(intent), { flag: "wx", mode: 0o600, flush: true });
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

  releaseBeforeLaunch(operationId: string): void {
    if (this.readAdmission(operationId)?.state === "dispatching") return;
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
      writeFileSync(this.path(value.operationId, "admission"), JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true });
      return value;
    } catch (error: unknown) {
      if (!isExists(error)) throw error;
      const saved = this.readAdmission(value.operationId);
      if (!saved) throw new Error("Fusion admission disappeared during arbitration.", { cause: error });
      return saved;
    }
  }

  private readIntent(operationId: string): OperationIntent | undefined {
    const saved = this.readJson(operationId, "intent");
    if (saved === undefined) return undefined;
    if (!isRecord(saved) || saved.operationId !== operationId || typeof saved.digest !== "string" || !saved.digest ||
      (saved.version !== undefined && saved.version !== 2) || (saved.requestDigest !== undefined && typeof saved.requestDigest !== "string")) throw new Error("Corrupt Fusion operation intent.");
    return { operationId, digest: saved.digest, ...(saved.version === 2 ? { version: 2 } : {}), ...(typeof saved.requestDigest === "string" ? { requestDigest: saved.requestDigest } : {}) };
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

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
