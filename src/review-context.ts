import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { FusionReviewContext } from "./types.js";
import { isRecord } from "./utils.js";

export function isReviewContext(value: unknown): value is FusionReviewContext {
  return isRecord(value) && typeof value.cwd === "string" && isAbsolute(value.cwd) &&
    typeof value.reviewedCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.reviewedCommit);
}

/** Validate the frozen candidate without changing the Pi session's journal namespace. */
export function verifyReviewContext(context: FusionReviewContext | undefined): void {
  if (!context) return;
  if (!isReviewContext(context)) throw new Error("Fusion review context requires an absolute cwd and a full reviewedCommit hash.");
  let head: string;
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith("GIT_")) delete environment[name];
  try {
    head = execFileSync("git", ["-C", context.cwd, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, env: environment,
    }).trim();
  } catch (error: unknown) {
    throw new Error("Fusion could not verify the candidate checkout HEAD.", { cause: error });
  }
  if (head.toLowerCase() !== context.reviewedCommit.toLowerCase()) throw new Error(`Fusion candidate HEAD ${head} does not match reviewedCommit ${context.reviewedCommit}.`);
}
