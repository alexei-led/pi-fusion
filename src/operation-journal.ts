import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestDigest } from "./runtime-contract.js";

export class FusionOperationJournal {
  constructor(private readonly directory: string) {}

  private path(operationId: string, suffix: string): string {
    return join(this.directory, `${requestDigest(operationId).slice(7)}.${suffix}`);
  }

  claim(operationId: string, digest: string): "claimed" | "existing" | "cancelled" {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (this.cancelled(operationId)) return "cancelled";
    const path = this.path(operationId, "intent");
    try {
      writeFileSync(path, JSON.stringify({ operationId, digest }), { flag: "wx", mode: 0o600 });
    } catch (error: unknown) {
      if (!isExists(error)) throw error;
      const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof saved !== "object" || saved === null || !("digest" in saved) || saved.digest !== digest) {
        throw new Error("Fusion operationId was already claimed with a different request digest.", { cause: error });
      }
      return this.cancelled(operationId) ? "cancelled" : "existing";
    }
    return this.cancelled(operationId) ? "cancelled" : "claimed";
  }

  cancel(operationId: string): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { writeFileSync(this.path(operationId, "cancel"), "cancelled", { flag: "wx", mode: 0o600 }); }
    catch (error: unknown) { if (!isExists(error)) throw error; }
  }

  cancelled(operationId: string): boolean {
    try { readFileSync(this.path(operationId, "cancel")); return true; }
    catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  state(operationId: string): "pending" | "cancelled" | "absent" {
    if (this.cancelled(operationId)) return "cancelled";
    try {
      const saved: unknown = JSON.parse(readFileSync(this.path(operationId, "intent"), "utf8"));
      if (typeof saved !== "object" || saved === null || !("operationId" in saved) || saved.operationId !== operationId || !("digest" in saved) || typeof saved.digest !== "string") throw new Error("Corrupt Fusion operation intent.");
      return "pending";
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "absent";
      throw error;
    }
  }
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
