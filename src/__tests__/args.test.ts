import assert from "node:assert/strict";
import { parseFusionArgs, tokenizeCommandArgs } from "../commands.js";

await test("parseFusionArgs parses a prompt without an explicit profile", () => {
  assert.deepEqual(parseFusionArgs("compare the approaches"), {
    prompt: "compare the approaches",
  });
  assert.deepEqual(parseFusionArgs("/fusion compare the approaches"), {
    prompt: "compare the approaches",
  });
});

await test("parseFusionArgs parses long and short profile flags", () => {
  assert.deepEqual(parseFusionArgs("--profile fast compare the approaches"), {
    profile: "fast",
    prompt: "compare the approaches",
  });
  assert.deepEqual(parseFusionArgs("-p fast compare the approaches"), {
    profile: "fast",
    prompt: "compare the approaches",
  });
  assert.deepEqual(parseFusionArgs("--profile=fast compare the approaches"), {
    profile: "fast",
    prompt: "compare the approaches",
  });
});

await test("parseFusionArgs keeps flags after the first prompt token as prompt text", () => {
  assert.deepEqual(parseFusionArgs("compare --profile literally"), {
    prompt: "compare --profile literally",
  });
});

await test("parseFusionArgs supports quoted prompt words", () => {
  assert.deepEqual(parseFusionArgs("-p fast \"compare A\" 'against B'"), {
    profile: "fast",
    prompt: "compare A against B",
  });
});

await test("parseFusionArgs rejects missing input and malformed profile flags", () => {
  assert.throws(() => parseFusionArgs(""), /Usage: \/fusion/);
  assert.throws(
    () => parseFusionArgs("--profile"),
    /Missing value for --profile/,
  );
  assert.throws(() => parseFusionArgs("-p"), /Missing value for -p/);
  assert.throws(
    () => parseFusionArgs("--profile fast -p slow prompt"),
    /Profile can only be provided once/,
  );
  assert.throws(
    () => parseFusionArgs("--unknown prompt"),
    /Unknown option --unknown/,
  );
});

await test("tokenizeCommandArgs handles whitespace, quotes, escapes, and unclosed quotes", () => {
  assert.deepEqual(tokenizeCommandArgs("  one  two\\ words 'three four'  "), [
    "one",
    "two words",
    "three four",
  ]);
  assert.throws(() => tokenizeCommandArgs("'open"), /Unclosed ' quote/);
});

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
