import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  appendThinkingSuffix,
  buildBlindLabelMap,
  buildJudgeSpawnParams as buildJudgeWorkflowSpawnParams,
  buildPanelSpawnParams,
  FUSION_ACCEPTANCE_DISABLED,
  shufflePanelItems,
  type PanelOutput,
  type FailedPanelSummary,
  type JudgeWorkflowTaskParams,
  type PanelWorkflowTaskParams,
} from "../../src/run-builder.js";
import { createDefaultFusionConfig } from "../../src/config.js";
import type { FusionProfile } from "../../src/types.js";

const EXACT_REVIEW_PROMPT = `Review the implementation.

Return either:
- the exact line \`NO_FINDINGS\`, or
- one or more blocks in this exact format:
  \`FINDING: CRITICAL|MAJOR|MINOR | <short title>\`
  \`Evidence: <file:line and concrete failure>\`
  \`Fix: <specific change>\`

Do not write any other prose.`;

const PROFILE: FusionProfile = {
  panel: [
    {
      id: "architect",
      label: "Architect",
      agent: "pi-fusion.fusion-panelist",
      model: "openai/gpt-5.5",
      thinking: "xhigh",
      role: "architecture and tradeoffs",
    },
    {
      id: "tester",
      label: "Tester",
      agent: "pi-fusion.fusion-panelist",
      model: "anthropic/claude:medium",
      thinking: "high",
      role: "test strategy",
    },
    {
      id: "generalist",
      label: "Generalist",
      agent: "pi-fusion.fusion-panelist",
      thinking: "low",
    },
  ],
  judge: {
    agent: "pi-fusion.fusion-judge",
    model: "openai/gpt-5.5",
    thinking: "high",
  },
  concurrency: 2,
  timeoutMs: 300_000,
  context: "fresh",
};

function workflowTasks(
  params: ReturnType<typeof buildPanelSpawnParams>,
): PanelWorkflowTaskParams[] {
  const serialized = params.workflowScript.match(/^const tasks = (.*);$/m)?.[1];
  assert.ok(serialized);
  return JSON.parse(serialized) as PanelWorkflowTaskParams[];
}

function judgeWorkflowTask(
  params: ReturnType<typeof buildJudgeWorkflowSpawnParams>,
): JudgeWorkflowTaskParams {
  const serialized = params.workflowScript.match(
    /^return runs\.run\("judge", (.*)\);$/,
  )?.[1];
  assert.ok(serialized);
  return JSON.parse(serialized) as JudgeWorkflowTaskParams;
}

function buildJudgeSpawnParams(
  input: Parameters<typeof buildJudgeWorkflowSpawnParams>[0],
): JudgeWorkflowTaskParams {
  return judgeWorkflowTask(buildJudgeWorkflowSpawnParams(input));
}

test("appendThinkingSuffix appends only when a model exists and no suffix exists", () => {
  assert.equal(
    appendThinkingSuffix("openai/gpt-5.5", "xhigh"),
    "openai/gpt-5.5:xhigh",
  );
  assert.equal(
    appendThinkingSuffix("openai/gpt-5.5:high", "xhigh"),
    "openai/gpt-5.5:high",
  );
  assert.equal(appendThinkingSuffix(undefined, "xhigh"), undefined);
  assert.equal(
    appendThinkingSuffix("openai/gpt-5.5", undefined),
    "openai/gpt-5.5",
  );
});

test("buildPanelSpawnParams creates async parallel panel tasks", () => {
  const params = buildPanelSpawnParams(PROFILE, "Compare two API designs");

  assert.equal(params.async, true);
  assert.equal("clarify" in params, false);
  assert.equal(params.timeoutMs, 300_000);
  assert.equal(params.context, "fresh");
  assert.deepEqual(params.acceptance, FUSION_ACCEPTANCE_DISABLED);
  assert.equal("action" in params, false);
  assert.equal("tasks" in params, false);
  assert.equal("chain" in params, false);
  assert.equal("concurrency" in params, false);
  assert.equal("worktree" in params, false);
  assert.match(
    params.workflowScript,
    /runs\.all\(tasks\.slice\(index, index \+ concurrency\)\)/,
  );

  const tasks = workflowTasks(params);
  assert.equal(tasks.length, 3);
  assert.deepEqual(
    tasks.map((task) => task.key),
    ["panel-1", "panel-2", "panel-3"],
  );
  assert.equal(tasks[0]?.agent, "pi-fusion.fusion-panelist");
  assert.equal(tasks[0]?.model, "openai/gpt-5.5:xhigh");
  assert.equal(tasks[1]?.model, "anthropic/claude:medium");
  assert.equal("model" in (tasks[2] ?? {}), false);
  assert.equal(tasks[0]?.output, true);
  assert.equal(tasks[0]?.outputMode, "inline");
  assert.equal("outputSchema" in (tasks[0] ?? {}), false);
  assert.equal(tasks[0]?.skill, false);
  assert.deepEqual(tasks[0]?.acceptance, FUSION_ACCEPTANCE_DISABLED);
  assert.deepEqual(tasks[0]?.toolBudget, {
    soft: 8,
    hard: 12,
    block: "*",
  });
});

test("exact caller contracts replace panel headings and agreement records", () => {
  const params = buildPanelSpawnParams(
    { ...PROFILE, stopWhenPanelAgrees: true },
    EXACT_REVIEW_PROMPT,
  );
  const task = workflowTasks(params)[0]?.task ?? "";

  assert.match(task, /exact output contract.*takes priority/i);
  assert.doesNotMatch(task, /^## Summary$/m);
  assert.doesNotMatch(task, /<fusion-panel-decision>/);
});

test("buildPanelSpawnParams adds a decision record only for agreement stopping", () => {
  const params = buildPanelSpawnParams(
    { ...PROFILE, concurrency: 3, stopWhenPanelAgrees: true },
    "Compare two API designs",
  );

  const tasks = workflowTasks(params);
  assert.equal("outputSchema" in (tasks[0] ?? {}), false);
  assert.match(tasks[0]?.task ?? "", /<fusion-panel-decision>/);
  assert.match(tasks[0]?.task ?? "", /needsMoreEvidence/);
  assert.match(params.workflowScript, /const concurrency = 2;/);
  assert.match(params.workflowScript, /pi-fusion-panel-stop/);
});

test("agreement workflow uses the resolved all quorum for a four-member panel", () => {
  const profile: FusionProfile = {
    ...PROFILE,
    panel: [
      ...PROFILE.panel,
      { id: "operator", label: "Operator", agent: "pi-fusion.fusion-panelist" },
    ],
    concurrency: 4,
    minimumSuccessfulPanelists: "all",
    stopWhenPanelAgrees: true,
  };

  const params = buildPanelSpawnParams(profile, "Compare two API designs");

  assert.match(params.workflowScript, /const concurrency = 4;/);
  assert.match(
    params.workflowScript,
    /const requiredSuccessfulPanelists = 4;/,
  );
  assert.match(
    params.workflowScript,
    /decisions\.length >= requiredSuccessfulPanelists/,
  );
  assert.doesNotMatch(params.workflowScript, /decisions\.length >= 2/);
});

test("buildPanelSpawnParams includes role, prompt, contract, and read-only instruction", () => {
  const params = buildPanelSpawnParams(PROFILE, "Compare two API designs");
  const task = workflowTasks(params)[0]?.task ?? "";

  assert.match(task, /Panel member: Architect/);
  assert.match(task, /Role: architecture and tradeoffs/);
  assert.match(task, /Compare two API designs/);
  assert.match(
    task,
    /Read-only: inspect only; leave files, git state, and the workspace untouched\./,
  );
  assert.match(task, /Do not run subagents/);
  assert.doesNotMatch(task, /Do not edit files/);
  assert.doesNotMatch(task, /destructive commands/);
  assert.doesNotMatch(task, /commit changes/);
  assert.match(task, /## Summary/);
  assert.match(task, /## Recommendation/);
  assert.match(task, /## Confidence/);
});

test("buildJudgeSpawnParams includes prompt, panel status, outputs, failures, and report contract", () => {
  const outputs: PanelOutput[] = [
    {
      index: 0,
      id: "architect",
      label: "Architect",
      agent: "pi-fusion.fusion-panelist",
      output: "Architecture says choose A.",
    },
    {
      index: 2,
      id: "generalist",
      label: "Generalist",
      agent: "pi-fusion.fusion-panelist",
      output: "Generalist says choose B if latency matters.",
      artifactPath: "/tmp/generalist.md",
    },
  ];
  const failedPanelists: FailedPanelSummary[] = [
    {
      index: 1,
      id: "tester",
      label: "Tester",
      agent: "pi-fusion.fusion-panelist",
      summary: "Timed out",
      artifactPath: "/tmp/tester.md",
    },
  ];

  const spawn = buildJudgeWorkflowSpawnParams({
    profile: PROFILE,
    prompt: "Compare two API designs",
    panelOutputs: outputs,
    failedPanelists,
    runId: "run-fixed-seed",
  });
  const params = judgeWorkflowTask(spawn);

  assert.equal(spawn.async, true);
  assert.equal("clarify" in spawn, false);
  assert.equal("agent" in spawn, false);
  assert.equal("task" in spawn, false);
  assert.equal(spawn.context, "fresh");
  assert.equal(spawn.timeoutMs, 300_000);
  assert.equal(spawn.output, true);
  assert.equal(spawn.outputMode, "inline");
  assert.deepEqual(spawn.acceptance, FUSION_ACCEPTANCE_DISABLED);
  assert.equal(params.agent, "pi-fusion.fusion-judge");
  assert.equal(params.model, "openai/gpt-5.5:high");
  assert.equal(params.output, true);
  assert.equal(params.outputMode, "inline");
  assert.equal(params.skill, false);
  assert.deepEqual(params.acceptance, FUSION_ACCEPTANCE_DISABLED);
  assert.deepEqual(params.toolBudget, {
    soft: 8,
    hard: 12,
    block: "*",
  });

  assert.match(params.task, /Read-only synthesis only\./);
  assert.doesNotMatch(params.task, /Do not edit files/);
  assert.match(params.task, /Original task/);
  assert.match(params.task, /Compare two API designs/);
  assert.match(params.task, /Panel status/);
  assert.match(params.task, /Architect: succeeded/);
  assert.match(params.task, /Tester: failed - Timed out/);
  assert.match(params.task, /Architecture says choose A/);
  assert.match(params.task, /Generalist says choose B/);
  assert.match(params.task, /\/tmp\/tester\.md/);
  assert.match(params.task, /# Fusion Report/);
  assert.match(params.task, /## Disagreements/);
});

test("exact caller contracts replace the generic judge report contract", () => {
  const task = buildJudgeSpawnParams({
    profile: PROFILE,
    prompt: EXACT_REVIEW_PROMPT,
    panelOutputs: [
      {
        index: 0,
        agent: "pi-fusion.fusion-panelist",
        output: "NO_FINDINGS",
      },
      {
        index: 1,
        agent: "pi-fusion.fusion-panelist",
        output: "NO_FINDINGS",
      },
    ],
    failedPanelists: [],
    runId: "run-exact-contract",
  }).task;

  assert.match(task, /exact output contract.*takes priority/i);
  assert.doesNotMatch(task, /^# Fusion Report$/m);
  assert.doesNotMatch(task, /^## Summary$/m);
});

test("shufflePanelItems is stable for the same seed", () => {
  const items = ["a", "b", "c", "d", "e", "f"];

  const first = shufflePanelItems(items, "run-42");
  const second = shufflePanelItems(items, "run-42");

  assert.deepEqual(first, second);
});

test("shufflePanelItems is a permutation and leaves the input untouched", () => {
  const items = ["a", "b", "c", "d", "e", "f"];

  const shuffled = shufflePanelItems(items, "run-42");

  assert.deepEqual([...shuffled].sort(), [...items].sort());
  assert.deepEqual(items, ["a", "b", "c", "d", "e", "f"]);
});

test("shufflePanelItems varies across seeds", () => {
  const items = ["a", "b", "c", "d", "e", "f"];

  const orders = new Set(
    Array.from({ length: 25 }, (_, index) =>
      shufflePanelItems(items, `run-${index}`).join(""),
    ),
  );

  assert.ok(
    orders.size > 1,
    "expected different seeds to produce different orders",
  );
});

test("shufflePanelItems handles empty and single-item panels", () => {
  assert.deepEqual(shufflePanelItems([], "run-1"), []);
  assert.deepEqual(shufflePanelItems(["only"], "run-1"), ["only"]);
});

test("buildJudgeSpawnParams presents the same output order for the same run id", () => {
  const outputs: PanelOutput[] = PROFILE.panel.map((member, index) => ({
    index,
    id: member.id,
    label: member.label ?? member.id,
    agent: member.agent,
    output: `Answer from ${member.label}.`,
  }));
  const input = {
    profile: PROFILE,
    prompt: "Compare two API designs",
    panelOutputs: outputs,
    failedPanelists: [],
    runId: "run-stable",
  };

  assert.equal(
    buildJudgeSpawnParams(input).task,
    buildJudgeSpawnParams(input).task,
  );
});

test("buildJudgeSpawnParams keeps panel status in configuration order while shuffling answers", () => {
  const outputs: PanelOutput[] = PROFILE.panel.map((member, index) => ({
    index,
    id: member.id,
    label: member.label ?? member.id,
    agent: member.agent,
    output: `Answer from ${member.label}.`,
  }));

  const seeds = ["run-a", "run-b", "run-c", "run-d", "run-e", "run-f"];
  const answerOrders = new Set<string>();

  for (const runId of seeds) {
    const { task } = buildJudgeSpawnParams({
      profile: PROFILE,
      prompt: "Compare two API designs",
      panelOutputs: outputs,
      failedPanelists: [],
      runId,
    });

    // Status block always lists members in profile order.
    const status = task.slice(
      task.indexOf("Panel status:"),
      task.indexOf("Successful panel outputs:"),
    );
    assert.ok(
      status.indexOf("Architect") < status.indexOf("Tester") &&
        status.indexOf("Tester") < status.indexOf("Generalist"),
      `status block lost configuration order for ${runId}`,
    );

    const answers = task.slice(task.indexOf("Successful panel outputs:"));
    answerOrders.add(
      ["Architect", "Tester", "Generalist"]
        .map((label) => [label, answers.indexOf(`## ${label}`)] as const)
        .sort((left, right) => left[1] - right[1])
        .map(([label]) => label)
        .join(","),
    );
  }

  assert.ok(
    answerOrders.size > 1,
    "answer order should differ across run ids; position bias would otherwise be deterministic",
  );
});

test("buildPanelSpawnParams matches the pre-change task baseline apart from reliability limits", async () => {
  const baseline = JSON.parse(
    await readFile("test/fixtures/baseline-tasks.json", "utf8"),
  ) as { prompt: string; panel: unknown };
  const profile = createDefaultFusionConfig().profiles.quality;
  assert.ok(profile);

  const actual = buildPanelSpawnParams(profile, baseline.prompt);
  const expected = baseline.panel as {
    tasks: PanelWorkflowTaskParams[];
    async: true;
    concurrency: number;
    context: "fresh" | "fork";
    output: true;
    outputMode: "inline";
    acceptance: typeof FUSION_ACCEPTANCE_DISABLED;
    timeoutMs?: number;
  };
  assert.deepEqual(
    workflowTasks(actual).map(
      ({ key: _key, toolBudget: _toolBudget, timeoutMs: _timeoutMs, ...task }) => task,
    ),
    expected.tasks,
  );
  assert.equal(actual.async, expected.async);
  assert.equal("clarify" in actual, false);
  assert.equal(actual.context, expected.context);
  assert.equal(actual.output, expected.output);
  assert.equal(actual.outputMode, expected.outputMode);
  assert.deepEqual(actual.acceptance, expected.acceptance);
  assert.ok(
    actual.workflowScript.includes(`const concurrency = ${expected.concurrency};`),
  );
});

test("buildJudgeSpawnParams matches the pre-change baseline once answer order is normalised", async () => {
  const baseline = JSON.parse(
    await readFile("test/fixtures/baseline-tasks.json", "utf8"),
  ) as { prompt: string; judge: { task: string } };
  const profile = createDefaultFusionConfig().profiles.quality;
  assert.ok(profile);

  const outputs: PanelOutput[] = profile.panel.map((member, index) => ({
    index,
    agent: member.agent,
    output: `Answer from ${member.label}.`,
    id: member.id,
    label: member.label ?? member.id,
    ...(member.role !== undefined ? { role: member.role } : {}),
  }));
  const { task } = buildJudgeSpawnParams({
    profile,
    prompt: baseline.prompt,
    panelOutputs: outputs,
    failedPanelists: [],
    runId: "run-baseline",
  });

  // Two intended differences from master, and nothing else: answer-block order
  // is now seeded, and the judge is asked to verify contested claims. Stripping
  // both must reproduce the master task byte for byte.
  assert.equal(
    normaliseAnswerBlocks(stripContestedClaims(task)),
    normaliseAnswerBlocks(baseline.judge.task),
  );
});

function stripContestedClaims(task: string): string {
  return task
    .replace(/Contested claims:\n(?:- .*\n)+\n/, "")
    .replace("## Contested Claims\n", "");
}

function normaliseAnswerBlocks(task: string): string {
  const marker = "Successful panel outputs:";
  const head = task.slice(0, task.indexOf(marker));
  const answers = task.slice(task.indexOf(marker));
  const blocks = answers.split(/(?=^## )/m).sort();
  return `${head}${blocks.join("")}`;
}

test("buildBlindLabelMap assigns candidate names by index and scales past Z", () => {
  const labels = buildBlindLabelMap([{ index: 2 }, { index: 0 }, { index: 1 }]);

  assert.equal(labels.get(0), "Candidate A");
  assert.equal(labels.get(1), "Candidate B");
  assert.equal(labels.get(2), "Candidate C");

  const wide = buildBlindLabelMap(
    Array.from({ length: 28 }, (_, index) => ({ index })),
  );
  assert.equal(wide.get(25), "Candidate Z");
  assert.equal(wide.get(26), "Candidate AA");
  assert.equal(wide.get(27), "Candidate AB");
});

test("blindPanelLabels hides labels, roles, agents, and artifact paths from the judge", () => {
  const outputs: PanelOutput[] = [
    {
      index: 0,
      id: "architect",
      label: "Architect",
      role: "architecture and tradeoffs",
      agent: "pi-fusion.fusion-panelist",
      output: "Choose A.",
      artifactPath: "/tmp/architect.md",
      sessionPath: "/tmp/architect-session",
    },
    {
      index: 2,
      id: "generalist",
      label: "Generalist",
      agent: "pi-fusion.fusion-panelist-web",
      output: "Choose B.",
    },
  ];
  const failedPanelists: FailedPanelSummary[] = [
    {
      index: 1,
      id: "tester",
      label: "Tester",
      agent: "pi-fusion.fusion-panelist",
      summary: "Timed out",
      artifactPath: "/tmp/tester.md",
    },
  ];

  const { task } = buildJudgeSpawnParams({
    profile: { ...PROFILE, blindPanelLabels: true },
    prompt: "Compare two API designs",
    panelOutputs: outputs,
    failedPanelists,
    runId: "run-blind",
  });

  for (const leak of [
    "Architect",
    "Generalist",
    "Tester",
    "architect",
    "generalist",
    "tester",
    "fusion-panelist-web",
    "/tmp/",
  ]) {
    assert.equal(
      task.includes(leak),
      false,
      `judge task leaked "${leak}" under blindPanelLabels`,
    );
  }

  assert.match(task, /Candidate A/);
  assert.match(task, /Candidate B/);
  assert.match(task, /Candidate C/);
  assert.match(task, /Choose A\./);
  assert.match(task, /Timed out/);
});

test("blindPanelLabels off keeps today's labels and metadata", () => {
  const outputs: PanelOutput[] = [
    {
      index: 0,
      id: "architect",
      label: "Architect",
      agent: "pi-fusion.fusion-panelist",
      output: "Choose A.",
      artifactPath: "/tmp/architect.md",
    },
  ];

  const { task } = buildJudgeSpawnParams({
    profile: PROFILE,
    prompt: "Compare two API designs",
    panelOutputs: outputs,
    failedPanelists: [],
    runId: "run-plain",
  });

  assert.match(task, /## Architect/);
  assert.match(task, /Agent: pi-fusion\.fusion-panelist/);
  assert.match(task, /\/tmp\/architect\.md/);
  assert.doesNotMatch(task, /Candidate A/);
});

test("buildJudgeSpawnParams instructs the judge to verify contested claims", () => {
  const { task } = buildJudgeSpawnParams({
    profile: PROFILE,
    prompt: "Compare two API designs",
    panelOutputs: [
      {
        index: 0,
        id: "architect",
        label: "Architect",
        agent: "pi-fusion.fusion-panelist",
        output: "Choose A.",
      },
    ],
    failedPanelists: [],
    runId: "run-contested",
  });

  assert.match(task, /Contested claims:/);
  assert.match(task, /cite file:line/);
  assert.match(task, /## Contested Claims/);
});

test("buildJudgeSpawnParams uses a bounded default and accepts judgeToolBudget overrides", () => {
  const base = {
    prompt: "Compare two API designs",
    panelOutputs: [
      {
        index: 0,
        id: "architect",
        label: "Architect",
        agent: "pi-fusion.fusion-panelist",
        output: "Choose A.",
      },
    ],
    failedPanelists: [],
    runId: "run-budget",
  };

  const withBudget = buildJudgeSpawnParams({
    ...base,
    profile: { ...PROFILE, judgeToolBudget: { soft: 4, hard: 10 } },
  });
  assert.deepEqual(withBudget.toolBudget, { soft: 4, hard: 10 });

  const withoutBudget = buildJudgeSpawnParams({ ...base, profile: PROFILE });
  assert.deepEqual(withoutBudget.toolBudget, {
    soft: 8,
    hard: 12,
    block: "*",
  });
});

test("buildPanelSpawnParams accepts panelToolBudget overrides", () => {
  const tasks = workflowTasks(
    buildPanelSpawnParams(
      { ...PROFILE, panelToolBudget: { soft: 3, hard: 6 } },
      "Compare two API designs",
    ),
  );

  assert.deepEqual(tasks[0]?.toolBudget, { soft: 3, hard: 6 });
});

test("stage-specific timeouts override the legacy shared timeout", () => {
  const profile = {
    ...PROFILE,
    panelTimeoutMs: 600_000,
    judgeTimeoutMs: 900_000,
  };

  assert.equal(
    buildPanelSpawnParams(profile, "Compare two API designs").timeoutMs,
    600_000,
  );
  assert.equal(
    buildJudgeWorkflowSpawnParams({
      profile,
      prompt: "Compare two API designs",
      panelOutputs: [
        {
          index: 0,
          agent: "pi-fusion.fusion-panelist",
          output: "Choose A.",
        },
        {
          index: 1,
          agent: "pi-fusion.fusion-panelist",
          output: "Choose A.",
        },
      ],
      failedPanelists: [],
      runId: "run-timeouts",
    }).timeoutMs,
    900_000,
  );
});

test("buildJudgeSpawnParams honors a persisted effective judge timeout", () => {
  const spawn = buildJudgeWorkflowSpawnParams({
    profile: PROFILE,
    prompt: "compare",
    panelOutputs: [],
    failedPanelists: [],
    runId: "run-1",
    effectiveTimeouts: {
      panelistTimeoutMs: 10,
      panelTimeoutMs: 20,
      panelGraceMs: 5,
      judgeTimeoutMs: 123_456,
      usesLegacyTimeout: false,
    },
  });
  assert.equal(spawn.timeoutMs, 123_456);
});

test("rejects a panel grace interval that consumes the whole panel deadline", () => {
  assert.throws(
    () =>
      buildPanelSpawnParams(
        { ...PROFILE, panelTimeoutMs: 5_000, panelGraceMs: 5_000 },
        "Compare two API designs",
      ),
    /panelGraceMs \(5000ms\) must be shorter than panelTimeoutMs \(5000ms\)/,
  );
});

test("buildPanelSpawnParams substitutes {task} into a member question", () => {
  const profile: FusionProfile = {
    ...PROFILE,
    panel: [
      {
        id: "security",
        label: "Security",
        agent: "pi-fusion.fusion-panelist",
        question: "Cover ONLY the security surface of: {task}",
      },
    ],
  };

  const task = workflowTasks(
    buildPanelSpawnParams(profile, "Ship the new API"),
  )[0]?.task ?? "";

  assert.match(task, /Your assigned facet of the task:/);
  assert.match(task, /Cover ONLY the security surface of: Ship the new API/);
  assert.doesNotMatch(task, /Original task:/);
});

test("buildPanelSpawnParams replaces every {task} occurrence", () => {
  const profile: FusionProfile = {
    ...PROFILE,
    panel: [
      {
        id: "security",
        label: "Security",
        agent: "pi-fusion.fusion-panelist",
        question: "For {task}, list risks. Then re-read {task} and rank them.",
      },
    ],
  };

  const task =
    workflowTasks(buildPanelSpawnParams(profile, "Ship the API"))[0]?.task ?? "";

  assert.equal(task.includes("{task}"), false);
  assert.equal(task.split("Ship the API").length - 1, 2);
});

test("buildPanelSpawnParams appends the original task when the question omits the placeholder", () => {
  const profile: FusionProfile = {
    ...PROFILE,
    panel: [
      {
        id: "security",
        label: "Security",
        agent: "pi-fusion.fusion-panelist",
        question: "Cover only the security surface.",
      },
    ],
  };

  const task = workflowTasks(
    buildPanelSpawnParams(profile, "Ship the new API"),
  )[0]?.task ?? "";

  assert.match(
    task,
    /Your assigned facet of the task:\nCover only the security surface\./,
  );
  assert.match(task, /Original task:\nShip the new API/);
});

test("buildPanelSpawnParams without a question reproduces today's task exactly", async () => {
  const baseline = JSON.parse(
    await readFile("test/fixtures/baseline-tasks.json", "utf8"),
  ) as { prompt: string; panel: { tasks: { task: string }[] } };
  const profile = createDefaultFusionConfig().profiles.quality;
  assert.ok(profile);

  const tasks = workflowTasks(
    buildPanelSpawnParams(profile, baseline.prompt),
  );

  assert.deepEqual(
    tasks.map((entry) => entry.task),
    baseline.panel.tasks.map((entry) => entry.task),
  );
});

const MERGE_OUTPUTS: PanelOutput[] = [
  {
    index: 0,
    id: "architect",
    label: "Architect",
    agent: "pi-fusion.fusion-panelist",
    output: "Architecture facet.",
  },
  {
    index: 1,
    id: "tester",
    label: "Tester",
    agent: "pi-fusion.fusion-panelist",
    output: "Test facet.",
  },
];

test("merge synthesis swaps the agent and the output contract", () => {
  const params = buildJudgeSpawnParams({
    profile: { ...PROFILE, synthesis: "merge" },
    prompt: "Review the release",
    panelOutputs: MERGE_OUTPUTS,
    failedPanelists: [],
    runId: "run-merge",
  });

  assert.equal(params.agent, "pi-fusion.fusion-composer");
  assert.match(params.task, /You are the fusion composer\./);
  assert.match(params.task, /Merge their answers; do not pick a winner\./);
  assert.match(params.task, /## Coverage Map/);
  assert.match(params.task, /## Combined Answer/);
  assert.match(params.task, /## Gaps/);
  assert.doesNotMatch(params.task, /## Consensus/);
  assert.doesNotMatch(params.task, /## Disagreements/);
});

test("merge synthesis lists facet assignments so gaps can be named", () => {
  const profile: FusionProfile = {
    ...PROFILE,
    synthesis: "merge",
    panel: [
      {
        id: "security",
        label: "Security",
        agent: "pi-fusion.fusion-panelist",
        question: "Cover the security surface of {task}",
      },
      {
        id: "perf",
        label: "Perf",
        agent: "pi-fusion.fusion-panelist",
        role: "throughput and latency",
      },
    ],
  };

  const { task } = buildJudgeSpawnParams({
    profile,
    prompt: "Review the release",
    panelOutputs: MERGE_OUTPUTS,
    failedPanelists: [],
    runId: "run-merge",
  });

  assert.match(task, /Facet assignments:/);
  // The template is substituted, exactly as the panelist saw it. A raw "{task}"
  // here would put a literal placeholder in front of the composer.
  assert.match(
    task,
    /- Security: Cover the security surface of Review the release/,
  );
  assert.match(task, /- Perf: throughput and latency/);
  assert.equal(task.includes("{task}"), false);
});

test("merge synthesis blinds facet assignments too", () => {
  const profile: FusionProfile = {
    ...PROFILE,
    synthesis: "merge",
    blindPanelLabels: true,
    panel: [
      {
        id: "security",
        label: "Security",
        agent: "pi-fusion.fusion-panelist",
        question: "Cover security",
      },
      {
        id: "perf",
        label: "Perf",
        agent: "pi-fusion.fusion-panelist",
        question: "Cover performance",
      },
    ],
  };

  const { task } = buildJudgeSpawnParams({
    profile,
    prompt: "Review the release",
    panelOutputs: MERGE_OUTPUTS,
    failedPanelists: [],
    runId: "run-merge-blind",
  });

  assert.match(task, /- Candidate A: Cover security/);
  assert.equal(task.includes("Security"), false);
  assert.equal(task.includes("Perf"), false);
});

test("select synthesis keeps the configured judge agent and contract", () => {
  const params = buildJudgeSpawnParams({
    profile: { ...PROFILE, synthesis: "select" },
    prompt: "Review the release",
    panelOutputs: MERGE_OUTPUTS,
    failedPanelists: [],
    runId: "run-select",
  });

  assert.equal(params.agent, "pi-fusion.fusion-judge");
  assert.match(params.task, /You are the fusion judge\./);
  assert.match(params.task, /## Consensus/);
  assert.doesNotMatch(params.task, /## Coverage Map/);
  assert.doesNotMatch(params.task, /Facet assignments:/);
});

test("merge synthesis respects a custom judge agent", () => {
  const params = buildJudgeSpawnParams({
    profile: {
      ...PROFILE,
      synthesis: "merge",
      judge: { agent: "my-pkg.my-merger" },
    },
    prompt: "Review the release",
    panelOutputs: MERGE_OUTPUTS,
    failedPanelists: [],
    runId: "run-merge-custom",
  });

  assert.equal(params.agent, "my-pkg.my-merger");
});

test("merge synthesis works when no member declares a question", () => {
  // A profile can divide work by role alone; facet assignments fall back to it.
  const { task } = buildJudgeSpawnParams({
    profile: { ...PROFILE, synthesis: "merge" },
    prompt: "Review the release",
    panelOutputs: MERGE_OUTPUTS,
    failedPanelists: [],
    runId: "run-merge-noquestion",
  });

  assert.match(task, /Facet assignments:/);
  assert.match(task, /- Architect: architecture and tradeoffs/);
  assert.match(task, /- Generalist: the whole task/);
  assert.match(task, /## Coverage Map/);
});

test("blindPanelLabels never falls back to a real label for a member that did not report", () => {
  // stopWhenPanelAgrees stops a panelist mid-flight: it produces neither an
  // output nor a failure, so it is absent from the blind label map.
  const profile: FusionProfile = {
    ...PROFILE,
    synthesis: "merge",
    blindPanelLabels: true,
    panel: [
      { id: "a", label: "AlphaSecret", agent: "x", question: "Cover security" },
      { id: "b", label: "BetaSecret", agent: "x", question: "Cover perf" },
      { id: "c", label: "GammaSecret", agent: "x", question: "Cover ops" },
    ],
  };

  const { task } = buildJudgeSpawnParams({
    profile,
    prompt: "ship it",
    panelOutputs: [{ index: 0, agent: "x", output: "sec" }],
    failedPanelists: [{ index: 2, agent: "x", summary: "timeout" }],
    runId: "run-gap",
  });

  for (const label of ["AlphaSecret", "BetaSecret", "GammaSecret"]) {
    assert.equal(task.includes(label), false, `leaked ${label}`);
  }
  assert.match(task, /Candidate \(did not report\)/);
});

test("merge synthesis omits the judge-only contested claims block", () => {
  const base = {
    prompt: "Review the release",
    panelOutputs: MERGE_OUTPUTS,
    failedPanelists: [],
    runId: "run-cc",
  };

  const merged = buildJudgeSpawnParams({
    ...base,
    profile: { ...PROFILE, synthesis: "merge" },
  });
  // The composer contract has no Contested Claims section, so the instruction
  // would only produce content the report drops.
  assert.equal(merged.task.includes("Contested claims:"), false);
  assert.equal(merged.task.includes("## Contested Claims"), false);
  assert.match(merged.task, /Conflicts At Seams/);

  const selected = buildJudgeSpawnParams({ ...base, profile: PROFILE });
  assert.match(selected.task, /Contested claims:/);
  assert.match(selected.task, /## Contested Claims/);
});

test("synthesis is inferred from facets so the two settings cannot disagree", () => {
  const faceted = [
    { id: "sec", agent: "x", question: "Cover security of {task}" },
    { id: "perf", agent: "x", question: "Cover perf of {task}" },
  ];
  const outs: PanelOutput[] = [
    { index: 0, agent: "x", output: "A" },
    { index: 1, agent: "x", output: "B" },
  ];
  const base = {
    prompt: "ship it",
    panelOutputs: outs,
    failedPanelists: [],
    runId: "r",
  };

  // question without an explicit synthesis used to send facet answers to a
  // judge hunting for consensus they cannot have.
  const inferred = buildJudgeSpawnParams({
    ...base,
    profile: { ...PROFILE, panel: faceted },
  });
  assert.equal(inferred.agent, "pi-fusion.fusion-composer");
  assert.match(inferred.task, /## Coverage Map/);

  // No facets anywhere: still select.
  const plain = buildJudgeSpawnParams({ ...base, profile: PROFILE });
  assert.equal(plain.agent, "pi-fusion.fusion-judge");
  assert.match(plain.task, /## Consensus/);

  // An explicit setting still wins over the inference.
  const overridden = buildJudgeSpawnParams({
    ...base,
    profile: { ...PROFILE, panel: faceted, synthesis: "select" },
  });
  assert.equal(overridden.agent, "pi-fusion.fusion-judge");
});

test("label defaults to id", () => {
  const params = buildPanelSpawnParams(
    { ...PROFILE, panel: [{ id: "architect", agent: "x" }] },
    "Compare designs",
  );

  assert.match(
    workflowTasks(params)[0]?.task ?? "",
    /Panel member: architect \(architect\)/,
  );
});
