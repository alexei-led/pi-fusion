import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATUS_FILE = "status.json";
const ASYNC_RESULTS_DIR = "async-subagent-results";
const ASYNC_RUNS_DIR = "async-subagent-runs";

export function deriveSubagentResultPath(
  asyncDir: string,
  runId: string,
): string | undefined {
  const runsDir = dirname(asyncDir);
  if (!runsDir.endsWith(ASYNC_RUNS_DIR)) return undefined;
  return join(dirname(runsDir), ASYNC_RESULTS_DIR, `${runId}.json`);
}

export function readSubagentStatusArtifact(
  asyncDir: string | undefined,
): unknown {
  if (!asyncDir) return undefined;
  return readJsonArtifact(join(asyncDir, STATUS_FILE));
}

export function readSubagentResultArtifact(input: {
  runId?: string;
  asyncDir?: string;
}): unknown {
  if (!input.runId || !input.asyncDir) return undefined;
  const resultPath = deriveSubagentResultPath(input.asyncDir, input.runId);
  return resultPath ? readJsonArtifact(resultPath) : undefined;
}

function readJsonArtifact(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
