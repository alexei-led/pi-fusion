import assert from "node:assert/strict";
import test from "node:test";
import {
  detectCallerOutputContract,
  validateCallerOutput,
} from "../../src/caller-contract.js";

const REVIEW_PROMPT = `Review this implementation.

Return either:
- the exact line \`NO_FINDINGS\`, or
- one or more blocks in this exact format:
  \`FINDING: CRITICAL|MAJOR|MINOR | <short title>\`
  \`Evidence: <file:line and concrete failure>\`
  \`Fix: <specific change>\`

Do not write any other prose.`;

test("detectCallerOutputContract recognizes the strict plan review contract", () => {
  assert.equal(detectCallerOutputContract(REVIEW_PROMPT), "plan-review-v1");
});

test("detectCallerOutputContract ignores incidental review tokens", () => {
  assert.equal(
    detectCallerOutputContract("Explain when tools print NO_FINDINGS or FINDING."),
    undefined,
  );
});

test("validateCallerOutput accepts exact clean and finding outputs", () => {
  assert.deepEqual(validateCallerOutput("plan-review-v1", "NO_FINDINGS"), {
    ok: true,
  });
  assert.deepEqual(
    validateCallerOutput(
      "plan-review-v1",
      [
        "FINDING: MAJOR | Missing timeout",
        "Evidence: src/run.ts:42 can wait forever.",
        "Fix: Add a bounded timeout.",
      ].join("\n"),
    ),
    { ok: true },
  );
});

test("validateCallerOutput accepts adjacent finding blocks and mixed whitespace", () => {
  const output = [
    "  FINDING: MAJOR | First",
    "Evidence: a.ts:1 fails.",
    "Fix: Fix first.",
    "FINDING: MINOR | Second",
    "Evidence: b.ts:2 fails.",
    "Fix: Fix second.",
  ].join("\r\n");

  assert.deepEqual(validateCallerOutput("plan-review-v1", output), {
    ok: true,
  });
});

test("validateCallerOutput rejects prose and incomplete finding blocks", () => {
  const prose = validateCallerOutput(
    "plan-review-v1",
    "## Summary\nEverything looks good.",
  );
  assert.equal(prose.ok, false);
  if (!prose.ok) assert.match(prose.error, /exact caller output contract/);

  const incomplete = validateCallerOutput(
    "plan-review-v1",
    "FINDING: MAJOR | Missing timeout\nEvidence: src/run.ts:42",
  );
  assert.equal(incomplete.ok, false);
});
