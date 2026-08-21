import type { MinimumSuccessfulPanelists } from "./types.js";

/**
 * Resolves a configured panel-success policy to the number of successful
 * panelists required for synthesis and agreement stopping.
 */
export function resolveMinimumSuccessfulPanelists(
  policy: MinimumSuccessfulPanelists | undefined,
  panelSize: number,
): number {
  if (policy === "all") return panelSize;
  if (typeof policy === "number") {
    // A multi-member synthesis cannot truthfully claim a panel conclusion from
    // one answer. Preserve one-member panels while making legacy numeric `1`
    // behave as the minimum meaningful two-candidate quorum.
    return panelSize > 1 ? Math.max(2, Math.min(policy, panelSize)) : 1;
  }
  // Fusion uses a quorum (half rounded up), not an absolute strict-majority
  // vote: two independent completed answers are enough to synthesize a
  // four-member panel while still requiring two of three.
  return Math.ceil(panelSize / 2);
}
