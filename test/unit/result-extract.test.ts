import assert from "node:assert/strict";
import test from "node:test";
import { extractPanelResults } from "../../src/result-extract.js";
import type { PanelMemberConfig } from "../../src/types.js";

const PANEL: PanelMemberConfig[] = [
  {
    id: "architect",
    label: "Architect",
    agent: "pi-fusion.fusion-panelist",
  },
  {
    id: "tester",
    label: "Tester",
    agent: "pi-fusion.fusion-panelist",
  },
];

test("extractPanelResults reads successful and failed async result children", () => {
  const result = extractPanelResults(
    {
      runId: "panel-run",
      mode: "parallel",
      results: [
        {
          agent: "pi-fusion.fusion-panelist",
          output: "Architecture says choose A.",
          success: true,
          artifactPaths: { outputPath: "/tmp/architect.md" },
        },
        {
          agent: "pi-fusion.fusion-panelist",
          output: "stderr tail",
          error: "Timed out",
          success: false,
          sessionFile: "/tmp/tester-session.jsonl",
        },
      ],
    },
    { panel: PANEL },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.runId, "panel-run");
  assert.deepEqual(result.outputs, [
    {
      index: 0,
      id: "architect",
      label: "Architect",
      agent: "pi-fusion.fusion-panelist",
      output: "Architecture says choose A.",
      artifactPath: "/tmp/architect.md",
    },
  ]);
  assert.deepEqual(result.failures, [
    {
      index: 1,
      id: "tester",
      label: "Tester",
      agent: "pi-fusion.fusion-panelist",
      summary: "Timed out\n\nstderr tail",
      sessionPath: "/tmp/tester-session.jsonl",
    },
  ]);
});

test("extractPanelResults reads status RPC details results", () => {
  const result = extractPanelResults(
    {
      text: "Run complete",
      details: {
        runId: "details-run",
        mode: "parallel",
        results: [
          {
            agent: "pi-fusion.fusion-panelist",
            finalOutput: "Details output",
            exitCode: 0,
          },
        ],
      },
    },
    { panel: PANEL },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.runId, "details-run");
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0]?.output, "Details output");
  assert.equal(result.failures.length, 0);
});

test("extractPanelResults treats failed statuses as failed panel summaries", () => {
  const result = extractPanelResults(
    {
      id: "panel-run",
      results: [
        {
          agent: "pi-fusion.fusion-panelist",
          status: "failed",
          summary: "Panel failed after tool error",
          artifactPath: "/tmp/failure.md",
        },
      ],
    },
    { panel: PANEL },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.outputs, []);
  assert.deepEqual(result.failures, [
    {
      index: 0,
      id: "architect",
      label: "Architect",
      agent: "pi-fusion.fusion-panelist",
      summary: "Panel failed after tool error",
      artifactPath: "/tmp/failure.md",
    },
  ]);
});

test("extractPanelResults returns typed errors for missing and unknown shapes", () => {
  const missing = extractPanelResults({ state: "complete" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "missing-results");

  const unknown = extractPanelResults({ results: [null] });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "unknown-result-shape");
});

test("extractPanelResults falls back to artifact paths when inline output is absent", () => {
  const result = extractPanelResults({
    runId: "panel-run",
    results: [
      {
        agent: "pi-fusion.fusion-panelist",
        success: true,
        artifactPath: "/tmp/only-artifact.md",
      },
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.outputs, [
    {
      index: 0,
      agent: "pi-fusion.fusion-panelist",
      output: "Output artifact: /tmp/only-artifact.md",
      artifactPath: "/tmp/only-artifact.md",
    },
  ]);
});

test("extractPanelResults can limit extraction to the panel prefix of a chain result", () => {
  const result = extractPanelResults(
    {
      runId: "chain-run",
      results: [
        {
          agent: "pi-fusion.fusion-panelist",
          success: true,
          output: "Architect says A.",
        },
        {
          agent: "pi-fusion.fusion-panelist",
          success: true,
          output: "Tester says A.",
        },
        {
          agent: "pi-fusion.fusion-judge",
          success: true,
          output: "# Fusion Report\n\n## Summary\nUse A.",
        },
      ],
    },
    { panel: PANEL, limit: 2 },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outputs.length, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(result.outputs[1]?.label, "Tester");
});
