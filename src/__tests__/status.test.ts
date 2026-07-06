import assert from "node:assert/strict";
import {
  buildFusionWidgetLines,
  clearFusionUi,
  extractFusionProgressCounts,
  formatFusionStatusText,
  publishFusionStatus,
} from "../status.js";
import type { FusionRun } from "../types.js";

const RUN: FusionRun = {
  id: "fusion-1",
  prompt: "compare",
  profileName: "quality",
  phase: "panel",
  createdAt: 1,
  updatedAt: 1,
  panelRunId: "panel-1",
};

await test("formatFusionStatusText includes phase, profile, run ID, and counts", () => {
  const text = formatFusionStatusText(RUN, {
    total: 3,
    pending: 1,
    running: 1,
    completed: 1,
    failed: 0,
  });

  assert.equal(
    text,
    "fusion: panel quality panel-1 1/3 done, 1 running, 0 failed",
  );
});

await test("buildFusionWidgetLines creates compact active run details", () => {
  assert.deepEqual(buildFusionWidgetLines(RUN), [
    "Fusion panel · quality",
    "Run: fusion-1",
    "Panel: panel-1",
  ]);
});

await test("publishFusionStatus and clearFusionUi use only status and widget keys", () => {
  const ui = new FakeUi();
  const ctx = { hasUI: true, ui };

  publishFusionStatus(ctx, RUN);
  clearFusionUi(ctx);

  assert.deepEqual(ui.statuses, [
    { key: "fusion", text: "fusion: panel quality panel-1" },
    { key: "fusion", text: undefined },
  ]);
  assert.equal(ui.widgets[0]?.key, "fusion-panel");
  assert.equal(ui.widgets[1]?.lines, undefined);
});

await test("extractFusionProgressCounts reads progress and result containers", () => {
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
});

class FakeUi {
  readonly statuses: Array<{ key: string; text: string | undefined }> = [];
  readonly widgets: Array<{
    key: string;
    lines: readonly string[] | undefined;
  }> = [];

  setStatus(key: string, text: string | undefined): void {
    this.statuses.push({ key, text });
  }

  setWidget(key: string, lines: readonly string[] | undefined): void {
    this.widgets.push({ key, lines });
  }
}

async function test(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error: unknown) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
