import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFusionArgs,
  parseFusionInlineCommand,
  tokenizeCommandArgs,
} from "../../src/fusion-args.js";

test("parseFusionInlineCommand detects exact one-word commands", () => {
  assert.equal(parseFusionInlineCommand("init"), "init");
  assert.equal(parseFusionInlineCommand("status"), "status");
  assert.equal(parseFusionInlineCommand("stop"), "stop");
  assert.equal(parseFusionInlineCommand("status active run"), undefined);
  assert.equal(parseFusionInlineCommand("--profile fast status"), undefined);
});

test("parseFusionArgs parses a prompt without an explicit profile", () => {
  assert.deepEqual(parseFusionArgs("compare the approaches"), {
    prompt: "compare the approaches",
  });
  assert.deepEqual(parseFusionArgs("/fusion compare the approaches"), {
    prompt: "compare the approaches",
  });
});

test("parseFusionArgs parses long and short profile flags", () => {
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

test("parseFusionArgs keeps flags after the first prompt token as prompt text", () => {
  assert.deepEqual(parseFusionArgs("compare --profile literally"), {
    prompt: "compare --profile literally",
  });
});

test("parseFusionArgs supports quoted prompt words", () => {
  assert.deepEqual(parseFusionArgs("-p fast \"compare A\" 'against B'"), {
    profile: "fast",
    prompt: "compare A against B",
  });
});

test("parseFusionArgs rejects missing input and malformed profile flags", () => {
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

test("tokenizeCommandArgs handles whitespace, quotes, escapes, and unclosed quotes", () => {
  assert.deepEqual(tokenizeCommandArgs("  one  two\\ words 'three four'  "), [
    "one",
    "two words",
    "three four",
  ]);
  assert.throws(() => tokenizeCommandArgs("'open"), /Unclosed ' quote/);
});

test("parseFusionArgs reads --panel in both syntaxes", () => {
  assert.deepEqual(parseFusionArgs("/fusion --panel opus,gpt-5.5 Compare").panel, [
    "opus",
    "gpt-5.5",
  ]);
  assert.deepEqual(
    parseFusionArgs("/fusion --panel=opus,gpt-5.5 Compare").panel,
    ["opus", "gpt-5.5"],
  );
});

test("parseFusionArgs trims whitespace around panel entries", () => {
  assert.deepEqual(
    parseFusionArgs('/fusion --panel " opus , gpt-5.5 " Compare').panel,
    ["opus", "gpt-5.5"],
  );
});

test("parseFusionArgs rejects an empty or duplicated --panel", () => {
  assert.throws(
    () => parseFusionArgs("/fusion --panel"),
    /Missing value for --panel/,
  );
  assert.throws(
    () => parseFusionArgs("/fusion --panel --profile fast Compare"),
    /Missing value for --panel/,
  );
  assert.throws(
    () => parseFusionArgs('/fusion --panel="," Compare'),
    /Missing value for --panel/,
  );
  assert.throws(
    () => parseFusionArgs("/fusion --panel opus --panel gpt Compare"),
    /Panel can only be provided once/,
  );
});

test("parseFusionArgs takes the next token as the panel list, mirroring --profile", () => {
  // "--panel Compare things" is not an error: Compare is a one-entry panel and
  // "things" is the prompt, exactly as "--profile Compare things" behaves.
  const args = parseFusionArgs("/fusion --panel Compare things");

  assert.deepEqual(args.panel, ["Compare"]);
  assert.equal(args.prompt, "things");
});

test("parseFusionArgs combines --panel with --profile", () => {
  const args = parseFusionArgs("/fusion --profile fast --panel opus,gpt Compare");

  assert.equal(args.profile, "fast");
  assert.deepEqual(args.panel, ["opus", "gpt"]);
  assert.equal(args.prompt, "Compare");
});

test("parseFusionArgs treats --panel after the prompt as prompt text", () => {
  const args = parseFusionArgs("/fusion Compare --panel opus");

  assert.equal(args.panel, undefined);
  assert.equal(args.prompt, "Compare --panel opus");
});

test("parseFusionArgs omits panel when --panel is absent", () => {
  assert.equal(parseFusionArgs("/fusion Compare designs").panel, undefined);
});
