import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPanelDecision,
  extractRunObservation,
  hasStrongPanelAgreement,
  mergeRunObservations,
  summarizeProviderFailures,
} from "../../src/run-observations.js";
import type { PanelOutput } from "../../src/types.js";

test("extractPanelDecision parses and removes the tagged decision record", () => {
  assert.deepEqual(
    extractPanelDecision([
      "## Summary",
      "Choose A.",
      '<fusion-panel-decision>{"recommendation":"Choose A","confidence":"high","needsMoreEvidence":false}</fusion-panel-decision>',
    ]),
    {
      recommendation: "Choose A",
      confidence: "high",
      needsMoreEvidence: false,
      answerMarkdown: "## Summary\nChoose A.",
    },
  );
  assert.equal(
    extractPanelDecision(
      '<fusion-panel-decision>{"recommendation":</fusion-panel-decision>',
    ),
    undefined,
  );
  assert.equal(
    extractPanelDecision(
      'Choose A.\n<fusion-panel-decision>{"recommendation":"Choose A","confidence":"high","needsMoreEvidence":false}</fusion-panel-decision>\nActually choose B.',
    ),
    undefined,
  );
});

const AGREED_OUTPUTS: PanelOutput[] = [
  {
    index: 0,
    agent: "panel",
    output: "Choose A.",
    decision: {
      recommendation: "Choose A",
      confidence: "high",
      needsMoreEvidence: false,
      answerMarkdown: "Choose A.",
    },
  },
  {
    index: 1,
    agent: "panel",
    output: "Choose A.",
    decision: {
      recommendation: "choose a.",
      confidence: "high",
      needsMoreEvidence: false,
      answerMarkdown: "Choose A.",
    },
  },
];

test("hasStrongPanelAgreement requires agreement while work remains", () => {
  assert.equal(hasStrongPanelAgreement(AGREED_OUTPUTS, 2, 3), true);
  assert.equal(hasStrongPanelAgreement(AGREED_OUTPUTS, 2, 2), false);
  assert.equal(
    hasStrongPanelAgreement(
      [
        AGREED_OUTPUTS[0]!,
        {
          ...AGREED_OUTPUTS[1]!,
          decision: { ...AGREED_OUTPUTS[1]!.decision!, confidence: "medium" },
        },
      ],
      2,
      3,
    ),
    false,
  );
  assert.equal(
    hasStrongPanelAgreement(
      [
        AGREED_OUTPUTS[0]!,
        {
          ...AGREED_OUTPUTS[1]!,
          decision: {
            ...AGREED_OUTPUTS[1]!.decision!,
            recommendation: "Choose B",
          },
        },
      ],
      2,
      3,
    ),
    false,
  );
});

test("mergeRunObservations preserves status timing and result usage", () => {
  assert.deepEqual(
    mergeRunObservations(
      {
        model: "deepseek/model",
        durationMs: 1200,
        usage: { inputTokens: 10 },
      },
      {
        model: "deepseek/model",
        usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.01 },
      },
    ),
    {
      model: "deepseek/model",
      durationMs: 1200,
      usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.01 },
    },
  );
});

test("extractRunObservation reads lifecycle timing, usage, model, and attempts", () => {
  const observation = extractRunObservation({
    model: "anthropic/claude-haiku",
    durationMs: 1234,
    totalCost: { inputTokens: 120, outputTokens: 40, costUsd: 0 },
    modelAttempts: [
      {
        model: "openai/gpt-mini",
        success: false,
        error: "rate limited",
      },
      { model: "anthropic/claude-haiku", success: true },
    ],
  });

  assert.deepEqual(observation, {
    model: "anthropic/claude-haiku",
    durationMs: 1234,
    usage: { inputTokens: 120, outputTokens: 40, costUsd: 0 },
    attempts: [
      { model: "openai/gpt-mini", success: false, error: "rate limited" },
      { model: "anthropic/claude-haiku", success: true },
    ],
    providerFailures: [
      {
        provider: "openai",
        model: "openai/gpt-mini",
        message: "rate limited",
      },
    ],
  });
});

test("extractRunObservation reports a direct provider error when attempts are absent", () => {
  assert.deepEqual(
    extractRunObservation({
      model: "openai/gpt-mini",
      state: "failed",
      error: "authentication failed",
    }).providerFailures,
    [
      {
        provider: "openai",
        model: "openai/gpt-mini",
        message: "authentication failed",
      },
    ],
  );
});

test("extractRunObservation does not double-count the final attempt error", () => {
  assert.deepEqual(
    extractRunObservation({
      model: "deepseek/model",
      state: "failed",
      error: "rate limited",
      modelAttempts: [
        { model: "deepseek/model", success: false, error: "rate limited" },
      ],
    }).providerFailures,
    [
      {
        provider: "deepseek",
        model: "deepseek/model",
        message: "rate limited",
      },
    ],
  );
});

test("extractRunObservation supports native usage and derives duration", () => {
  const observation = extractRunObservation({
    startedAt: 100,
    endedAt: 450,
    usage: {
      input: 10,
      output: 5,
      cost: { total: 0.03 },
    },
  });

  assert.deepEqual(observation, {
    durationMs: 350,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.03 },
  });
});

test("missing usage and duration remain unknown", () => {
  assert.deepEqual(extractRunObservation({ model: "ollama/qwen" }), {
    model: "ollama/qwen",
  });
});

test("summarizeProviderFailures groups duplicate provider errors", () => {
  assert.deepEqual(
    summarizeProviderFailures([
      {
        provider: "openai",
        model: "openai/gpt-mini",
        message: "rate limited",
      },
      {
        provider: "openai",
        model: "openai/gpt-mini",
        message: "rate limited",
        count: 2,
      },
      { provider: "anthropic", message: "authentication failed" },
    ]),
    [
      {
        provider: "anthropic",
        message: "authentication failed",
        count: 1,
      },
      {
        provider: "openai",
        model: "openai/gpt-mini",
        message: "rate limited",
        count: 3,
      },
    ],
  );
});
