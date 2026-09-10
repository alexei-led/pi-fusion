import type { FusionRun, PanelDeadlineState } from "./types.js";
import { isRecord } from "./utils.js";

export const PANEL_FINALIZE_RESERVE_MS = 60_000;
export const PANEL_DECISION_WAIT_MS = 60_000;

export interface PanelDeadlineAction {
  state: PanelDeadlineState;
  kind: "ask" | "finish";
}

/** Plan controls only for unambiguous, live children of the current panel. */
export function planPanelDeadlines(
  run: FusionRun,
  steps: readonly unknown[],
  now: number,
): PanelDeadlineAction[] {
  const timeouts = run.effectiveTimeouts;
  if (!timeouts?.panelistSoftTimeoutMs || !run.profileSnapshot) return [];
  const candidates = steps.flatMap((step) => {
    if (!isRecord(step) || (step.status ?? step.state) !== "running") return [];
    const key = step.workflowKey ?? step.key ?? step.agent;
    const match =
      typeof key === "string" ? key.match(/^panel-([1-9]\d*)$/) : undefined;
    const index = match ? Number(match[1]) - 1 : undefined;
    if (
      index === undefined ||
      index >= run.profileSnapshot!.panel.length ||
      typeof step.runId !== "string" ||
      !step.runId.trim() ||
      typeof step.startedAt !== "number" ||
      !Number.isFinite(step.startedAt)
    )
      return [];
    return [{ index, childRunId: step.runId, startedAt: step.startedAt }];
  });
  const actions: PanelDeadlineAction[] = [];
  for (const child of candidates) {
    if (
      candidates.filter(
        (item) =>
          item.index === child.index || item.childRunId === child.childRunId,
      ).length !== 1
    )
      continue;
    const previous = run.panelDeadlines?.find(
      (item) => item.index === child.index,
    );
    // A different run ID in the same slot is not authority to control it.
    if (previous && previous.childRunId !== child.childRunId) continue;
    const hardDeadlineAt = child.startedAt + timeouts.panelistTimeoutMs;
    if (now >= hardDeadlineAt || previous?.status === "finishing") continue;
    const finalizeAt = hardDeadlineAt - PANEL_FINALIZE_RESERVE_MS;
    if (previous) {
      const finishAt =
        previous.status === "pending"
          ? Math.min(previous.requestedAt + PANEL_DECISION_WAIT_MS, finalizeAt)
          : finalizeAt;
      if (now >= finishAt)
        actions.push({
          kind: "finish",
          state: { ...previous, status: "finishing" },
        });
    } else if (now >= child.startedAt + timeouts.panelistSoftTimeoutMs) {
      const finishing = now >= finalizeAt;
      actions.push({
        kind: finishing ? "finish" : "ask",
        state: {
          index: child.index,
          childRunId: child.childRunId,
          requestedAt: now,
          finalizeAt,
          hardDeadlineAt,
          status: finishing ? "finishing" : "pending",
        },
      });
    }
  }
  return actions;
}

export function deadlineSteerMessage(state: PanelDeadlineState): string {
  if (state.status === "finishing") {
    return "Fusion time budget: stop new investigation and return your best current answer now in the original output contract. State unfinished checks and uncertainty. Do not restart or wait for another decision. The hard deadline is unchanged.";
  }
  if (state.status === "continued") {
    return `Fusion continuation approved within the existing budget. Finish investigation by ${new Date(state.finalizeAt).toISOString()} and return the answer. The hard deadline is unchanged; there will be no further extension.`;
  }
  return "Fusion soft deadline reached. At the next safe point, send a short progress_update through contact_supervisor if available: findings so far, unfinished checks, and time needed. Do not block waiting in a supervisor tool. Finish the current check while the parent decides whether to continue; do not expand scope. If no decision arrives, Fusion will ask you to finalize shortly. Keep the original final-output contract.";
}
