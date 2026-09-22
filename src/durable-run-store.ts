import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  linkSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "./utils.js";
import { requestDigest } from "./runtime-contract.js";

export interface DurableRunSnapshot {
  fileName: string;
  data: unknown;
  terminal?: true;
  authoritative?: true;
}

export class DurableRunConflictError extends Error {}

export interface DurableRunSnapshotLoad {
  snapshots: DurableRunSnapshot[];
  errors: string[];
  admissionTail?: string;
}

/**
 * Stores one JSON snapshot per run. Writes use a same-directory temporary file
 * followed by rename, so a process crash cannot leave a partially written
 * snapshot at the published path.
 */
export class DurableRunSnapshotStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  load(): DurableRunSnapshotLoad {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    } catch (error: unknown) {
      return {
        snapshots: [],
        errors: [`Could not open durable fusion run directory: ${errorMessage(error)}`],
      };
    }

    let files: string[];
    try {
      files = readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort();
    } catch (error: unknown) {
      return {
        snapshots: [],
        errors: [`Could not read durable fusion run directory: ${errorMessage(error)}`],
      };
    }

    const snapshots: DurableRunSnapshot[] = [];
    const errors: string[] = [];
    for (const fileName of files) {
      try {
        const raw = readFileSync(join(this.directory, fileName), "utf8");
        const data: unknown = JSON.parse(raw);
        if (!isRecord(data) || typeof data.id !== "string" || durableSnapshotFileName(data.id) !== fileName) throw new Error("Fusion snapshot filename does not match its run identity.");
        snapshots.push({ fileName, data });
      } catch (error: unknown) {
        errors.push(
          `Could not read durable fusion run snapshot ${fileName}: ${errorMessage(error)}`,
        );
      }
    }
    return this.loadAdmission(snapshots, errors);
  }

  admit(key: string, data: unknown, predecessor?: string): void {
    if (predecessor && !this.readTerminal(predecessor)) throw new Error("Previous Fusion admission has no terminal receipt.");
    publishExclusive(join(this.directory, ".admissions"), slotName(predecessor), { version: 1, key, ...(predecessor ? { predecessor } : {}), data });
  }

  finish(key: string, data: unknown, expected?: unknown): unknown {
    const existing = this.readTerminal(key);
    if (existing) return existing;
    const accepted = this.commitRevision(key, data, expected);
    try { publishExclusive(join(this.directory, ".terminals"), durableSnapshotFileName(key), { version: 1, key, data: accepted }); }
    catch (error: unknown) { if (!isExists(error)) throw error; }
    const terminal = this.readTerminal(key);
    if (!terminal) throw new Error("Fusion terminal receipt disappeared.");
    return terminal;
  }

  private readTerminal(key: string): unknown {
    const revision = this.readRevision(key);
    if (revision && isRecord(revision.data) && terminalPhase(revision.data.phase)) return revision.data;
    try {
      const record: unknown = JSON.parse(readFileSync(join(this.directory, ".terminals", durableSnapshotFileName(key)), "utf8"));
      if (!isRecord(record) || record.version !== 1 || record.key !== key || !isRecord(record.data) || record.data.id !== key || !terminalPhase(record.data.phase)) throw new Error("Invalid Fusion terminal receipt.");
      if (revision && requestDigest(revision.data) !== requestDigest(record.data)) throw new Error("Fusion terminal receipt disagrees with its revision chain.");
      return record.data;
    } catch (error: unknown) { if (isMissing(error)) return undefined; throw error; }
  }

  private loadAdmission(snapshots: DurableRunSnapshot[], errors: string[]): DurableRunSnapshotLoad {
    let admissionTail: string | undefined;
    try {
      const merged = new Map(snapshots.map((snapshot) => [snapshot.fileName, snapshot]));
      const terminalFiles = jsonFiles(join(this.directory, ".terminals"));
      for (const fileName of terminalFiles) {
        const record: unknown = JSON.parse(readFileSync(join(this.directory, ".terminals", fileName), "utf8"));
        if (!isRecord(record) || typeof record.key !== "string" || durableSnapshotFileName(record.key) !== fileName) throw new Error("Invalid Fusion terminal receipt identity.");
        merged.set(fileName, { fileName, data: this.readTerminal(record.key), terminal: true });
      }
      const slots = jsonFiles(join(this.directory, ".admissions"));
      const seen = new Set<string>();
      let visited = 0;
      while (slots.includes(slotName(admissionTail))) {
        const fileName = slotName(admissionTail);
        const record: unknown = JSON.parse(readFileSync(join(this.directory, ".admissions", fileName), "utf8"));
        if (!isRecord(record) || record.version !== 1 || typeof record.key !== "string" || !record.key || record.predecessor !== admissionTail || !isRecord(record.data) || record.data.id !== record.key || seen.has(record.key)) throw new Error("Invalid Fusion admission chain.");
        if (admissionTail) {
          const terminal = this.readTerminal(admissionTail);
          if (!terminal) throw new Error("Fusion successor has no predecessor terminal receipt.");
          const terminalName = durableSnapshotFileName(admissionTail);
          merged.set(terminalName, { fileName: terminalName, data: terminal, terminal: true });
        }
        seen.add(record.key);
        visited += 1;
        admissionTail = record.key;
        const snapshotName = durableSnapshotFileName(record.key);
        const terminal = this.readTerminal(record.key);
        if (terminal) merged.set(snapshotName, { fileName: snapshotName, data: terminal, terminal: true });
        else if (!merged.has(snapshotName)) merged.set(snapshotName, { fileName: snapshotName, data: record.data });
      }
      if (visited !== slots.length) throw new Error("Unreachable Fusion admission record.");
      for (const [fileName, snapshot] of merged) {
        if (!isRecord(snapshot.data) || typeof snapshot.data.id !== "string") continue;
        const revision = this.readRevision(snapshot.data.id);
        if (revision) merged.set(fileName, { fileName, data: revision.data, authoritative: true, ...(isRecord(revision.data) && terminalPhase(revision.data.phase) ? { terminal: true } : {}) });
      }
      snapshots = Array.from(merged.values());
    } catch (error: unknown) {
      errors.push(`Could not recover Fusion admission: ${errorMessage(error)}`);
    }
    return { snapshots, errors, ...(admissionTail ? { admissionTail } : {}) };
  }

  private revisionDirectory(key: string): string {
    return join(this.directory, ".revisions", durableSnapshotFileName(key));
  }

  private readRevision(key: string): { data: unknown; sequence: number } | undefined {
    const directory = this.revisionDirectory(key);
    const files = jsonFiles(directory);
    if (files.length === 0) return undefined;
    let data: unknown;
    for (let sequence = 0; sequence < files.length; sequence += 1) {
      if (!files.includes(`${sequence}.json`)) throw new Error("Noncontiguous Fusion revision chain.");
      const record: unknown = JSON.parse(readFileSync(join(directory, `${sequence}.json`), "utf8"));
      if (!isRecord(record) || record.version !== 1 || record.key !== key || record.sequence !== sequence || !isRecord(record.data) || record.data.id !== key ||
        (sequence === 0 ? record.previous !== undefined : record.previous !== requestDigest(data)) ||
        (isRecord(data) && terminalPhase(data.phase))) throw new Error("Invalid Fusion revision chain.");
      data = record.data;
    }
    return { data, sequence: files.length - 1 };
  }

  private commitRevision(key: string, data: unknown, expected?: unknown): unknown {
    let current = this.readRevision(key);
    if (!current) {
      const loaded = this.load();
      if (loaded.errors.length) throw new Error(loaded.errors[0]);
      const baseline = loaded.snapshots.find((snapshot) => snapshot.fileName === durableSnapshotFileName(key));
      const seed = baseline?.data ?? expected;
      if (seed === undefined) throw new Error("Cannot revise an unadmitted Fusion run.");
      try { publishExclusive(this.revisionDirectory(key), "0.json", { version: 1, key, sequence: 0, data: seed }); }
      catch (error: unknown) { if (!isExists(error)) throw error; }
      current = this.readRevision(key);
    }
    if (!current) throw new Error("Fusion revision baseline disappeared.");
    if ((expected !== undefined && requestDigest(expected) !== requestDigest(current.data)) ||
      (isRecord(current.data) && terminalPhase(current.data.phase))) throw new DurableRunConflictError(`Fusion run ${key} changed concurrently.`);
    try {
      publishExclusive(this.revisionDirectory(key), `${current.sequence + 1}.json`, {
        version: 1, key, sequence: current.sequence + 1, previous: requestDigest(current.data), data,
      });
    } catch (error: unknown) {
      if (isExists(error)) throw new DurableRunConflictError(`Fusion run ${key} changed concurrently.`, { cause: error });
      throw error;
    }
    return data;
  }

  write(key: string, data: unknown, exclusive = false, expected?: unknown): void {
    if (expected !== undefined) this.commitRevision(key, data, expected);
    const serialized = JSON.stringify(data);
    if (serialized === undefined) {
      throw new Error("Durable fusion run snapshot is not JSON serializable.");
    }

    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const fileName = durableSnapshotFileName(key);
    const targetPath = join(this.directory, fileName);
    const temporaryPath = join(
      this.directory,
      `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporaryPath, `${serialized}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flush: true,
      });
      if (exclusive) {
        linkSync(temporaryPath, targetPath);
        unlinkSync(temporaryPath);
      } else renameSync(temporaryPath, targetPath);
    } catch (error: unknown) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The original write or rename error is the useful failure to report.
      }
      throw error;
    }
  }
}

function slotName(predecessor?: string): string {
  return predecessor ? `after-${durableSnapshotFileName(predecessor)}` : "root.json";
}

function terminalPhase(value: unknown): boolean {
  return value === "done" || value === "failed" || value === "cancelled";
}

function jsonFiles(directory: string): string[] {
  try { return readdirSync(directory).filter((name) => name.endsWith(".json")); }
  catch (error: unknown) { if (isMissing(error)) return []; throw error; }
}

function publishExclusive(directory: string, fileName: string, value: unknown): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true });
    linkSync(temporary, join(directory, fileName));
  } finally {
    try { unlinkSync(temporary); } catch { /* Temporary files never admit a run. */ }
  }
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

export function durableSnapshotFileName(key: string): string {
  return `${isUuid(key) ? key.toLowerCase() : createHash("sha256").update(key).digest("hex")}.json`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
