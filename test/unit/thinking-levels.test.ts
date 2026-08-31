import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_THINKING_LEVELS,
  getExtraThinkingLevels,
  hasThinkingSuffix,
  isThinkingLevel,
  resetExtraThinkingLevels,
  setExtraThinkingLevels,
} from "../../src/thinking-levels.js";

test("isThinkingLevel accepts built-in levels only before registration", () => {
  resetExtraThinkingLevels();

  assert.equal(isThinkingLevel("high"), true);
  assert.equal(isThinkingLevel("xhigh"), true);
  assert.equal(isThinkingLevel("max"), false);
  assert.equal(isThinkingLevel("ultra"), false);
  assert.equal(isThinkingLevel(42), false);
  assert.equal(isThinkingLevel(undefined), false);
});

test("setExtraThinkingLevels registers provider-specific levels", () => {
  resetExtraThinkingLevels();
  setExtraThinkingLevels(["ultra", "pro"]);

  assert.deepEqual(getExtraThinkingLevels(), ["ultra", "pro"]);
  assert.equal(isThinkingLevel("ultra"), true);
  assert.equal(isThinkingLevel("pro"), true);
  assert.equal(isThinkingLevel("high"), true);
  assert.equal(isThinkingLevel("turbo"), false);
});

test("setExtraThinkingLevels ignores built-ins and duplicates", () => {
  resetExtraThinkingLevels();
  setExtraThinkingLevels(["high", "ultra", "ultra", "pro"]);

  assert.deepEqual(getExtraThinkingLevels(), ["ultra", "pro"]);
  assert.equal(isThinkingLevel("high"), true);
  assert.equal(isThinkingLevel("ultra"), true);
  assert.equal(isThinkingLevel("pro"), true);
});

test("setExtraThinkingLevels replaces the previous set", () => {
  resetExtraThinkingLevels();
  setExtraThinkingLevels(["ultra"]);
  assert.equal(isThinkingLevel("ultra"), true);

  setExtraThinkingLevels(["pro"]);
  assert.equal(isThinkingLevel("ultra"), false);
  assert.equal(isThinkingLevel("pro"), true);
});

test("setExtraThinkingLevels rejects non-strings and empty strings", () => {
  resetExtraThinkingLevels();

  assert.throws(() => setExtraThinkingLevels(["ok", ""] as never), TypeError);
  assert.throws(() => setExtraThinkingLevels([7] as never), TypeError);
  assert.throws(
    () => setExtraThinkingLevels(["ok", undefined] as never),
    TypeError,
  );

  // A failed registration leaves the previous state untouched.
  setExtraThinkingLevels(["ultra"]);
  assert.deepEqual(getExtraThinkingLevels(), ["ultra"]);
});

test("resetExtraThinkingLevels clears registered levels", () => {
  setExtraThinkingLevels(["ultra"]);
  assert.equal(isThinkingLevel("ultra"), true);

  resetExtraThinkingLevels();
  assert.deepEqual(getExtraThinkingLevels(), []);
  assert.equal(isThinkingLevel("ultra"), false);
});

test("hasThinkingSuffix recognizes built-in and extra suffixes", () => {
  resetExtraThinkingLevels();

  assert.equal(hasThinkingSuffix("openai/gpt-5.5:high"), true);
  assert.equal(hasThinkingSuffix("openai/gpt-5.5"), false);
  assert.equal(hasThinkingSuffix("openai/gpt-5.5:ultra"), false);
  assert.equal(hasThinkingSuffix("no-colon"), false);

  setExtraThinkingLevels(["ultra"]);
  assert.equal(hasThinkingSuffix("openai/gpt-5.5:ultra"), true);
  assert.equal(hasThinkingSuffix("openai/gpt-5.5:xhigh"), true);
  assert.equal(hasThinkingSuffix("openai/gpt-5.5"), false);
  // Only the last segment is treated as a suffix.
  assert.equal(hasThinkingSuffix("pi-fusion.fusion-panelist:gpt-4.1:ultra"), true);
});

test("BUILTIN_THINKING_LEVELS mirrors the pi core set", () => {
  assert.deepEqual(BUILTIN_THINKING_LEVELS, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
});

test("fork-specific levels like max register via setExtraThinkingLevels", () => {
  resetExtraThinkingLevels();
  setExtraThinkingLevels(["max"]);

  // Migration path for fork-specific levels: "max" is no longer a built-in
  // but passes validation once registered as an extra.
  assert.equal(isThinkingLevel("max"), true);
  assert.equal(hasThinkingSuffix("openai/gpt-5.5:max"), true);

  resetExtraThinkingLevels();
  assert.equal(isThinkingLevel("max"), false);
});

test("teardown restores a clean registry", () => {
  resetExtraThinkingLevels();
  assert.deepEqual(getExtraThinkingLevels(), []);
});
