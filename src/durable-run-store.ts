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

export interface DurableRunSnapshot {
  fileName: string;
  data: unknown;
}

export interface DurableRunSnapshotLoad {
  snapshots: DurableRunSnapshot[];
  errors: string[];
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
        snapshots.push({ fileName, data: JSON.parse(raw) as unknown });
      } catch (error: unknown) {
        errors.push(
          `Could not read durable fusion run snapshot ${fileName}: ${errorMessage(error)}`,
        );
      }
    }
    return { snapshots, errors };
  }

  write(key: string, data: unknown, exclusive = false): void {
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
