import assert from "node:assert/strict";
import test from "node:test";
import {
  clearFusionUi,
  extractFusionProgressCounts,
  formatFusionStatusText,
  publishFusionStatus,
} from "../../src/status.js";
import type { FusionRun } from "../../src/types.js";

const RUN: FusionRun = {
  id: "fusion-1",
  prompt: "compare",
  profileName: "quality",
  phase: "panel",
  createdAt: 1,
  updatedAt: 1,
  panelRunId: "panel-1",
};

test("formatFusionStatusText includes phase, profile, and counts", () => {
  const text = formatFusionStatusText(RUN, {
    total: 3,
    pending: 1,
    running: 1,
    completed: 1,
    failed: 0,
  });

  assert.equal(text, "fusion: panel · 1/3 done, 1 running, 0 failed · quality");
});

test("publishFusionStatus and clearFusionUi use only the fusion status key", () => {
  const ui = new FakeUi();
  const ctx = { hasUI: true, ui };

  publishFusionStatus(ctx, RUN);
  clearFusionUi(ctx);

  assert.deepEqual(ui.statuses, [
    { key: "fusion", text: "fusion: panel · quality · panel-1" },
    { key: "fusion", text: undefined },
  ]);
});

test("extractFusionProgressCounts reads progress and result containers", () => {
  assert.deepEqual(
    extractFusionProgressCounts({
      details: {
        progress: [
          { status: "running" },
          { status: "completed" },
          { success: false },
        ],
      },
    }),
    { total: 3, pending: 0, running: 1, completed: 1, failed: 1 },
  );

  assert.deepEqual(
    extractFusionProgressCounts({
      results: [{ success: true }, { exitCode: 1 }, { state: "pending" }],
    }),
    { total: 3, pending: 1, running: 0, completed: 1, failed: 1 },
  );

  assert.deepEqual(
    extractFusionProgressCounts({
      results: [],
      steps: [{ status: "running" }],
    }),
    { total: 1, pending: 0, running: 1, completed: 0, failed: 0 },
  );

  assert.equal(extractFusionProgressCounts({ results: [] }), undefined);
});

class FakeUi {
  readonly statuses: Array<{ key: string; text: string | undefined }> = [];

  setStatus(key: string, text: string | undefined): void {
    this.statuses.push({ key, text });
  }
}
