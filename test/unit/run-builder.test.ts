import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  appendThinkingSuffix,
  buildBlindLabelMap,
  buildFusionChainSpawnParams,
  buildJudgeSpawnParams,
  buildPanelSpawnParams,
  FUSION_ACCEPTANCE_DISABLED,
  shufflePanelItems,
  type PanelOutput,
  type FailedPanelSummary,
} from "../../src/run-builder.js";
import { createDefaultFusionConfig } from "../../src/config.js";
import type { FusionProfile } from "../../src/types.js";

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
  assert.equal(params.clarify, false);
  assert.equal(params.concurrency, 2);
  assert.equal(params.timeoutMs, 300_000);
  assert.equal(params.context, "fresh");
  assert.deepEqual(params.acceptance, FUSION_ACCEPTANCE_DISABLED);
  assert.equal("action" in params, false);
  assert.equal("chain" in params, false);
  assert.equal("worktree" in params, false);

  const tasks = params.tasks;
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0]?.agent, "pi-fusion.fusion-panelist");
  assert.equal(tasks[0]?.model, "openai/gpt-5.5:xhigh");
  assert.equal(tasks[1]?.model, "anthropic/claude:medium");
  assert.equal("model" in (tasks[2] ?? {}), false);
  assert.equal(tasks[0]?.output, true);
  assert.equal(tasks[0]?.outputMode, "inline");
  assert.equal("outputSchema" in (tasks[0] ?? {}), false);
  assert.equal(tasks[0]?.skill, false);
  assert.deepEqual(tasks[0]?.acceptance, FUSION_ACCEPTANCE_DISABLED);
});

test("buildPanelSpawnParams adds a decision record only for agreement stopping", () => {
  const params = buildPanelSpawnParams(
    { ...PROFILE, stopWhenPanelAgrees: true },
    "Compare two API designs",
  );

  assert.equal("outputSchema" in (params.tasks[0] ?? {}), false);
  assert.match(params.tasks[0]?.task ?? "", /<fusion-panel-decision>/);
  assert.match(params.tasks[0]?.task ?? "", /needsMoreEvidence/);
});

test("buildPanelSpawnParams includes role, prompt, contract, and read-only instruction", () => {
  const params = buildPanelSpawnParams(PROFILE, "Compare two API designs");
  const task = params.tasks[0]?.task ?? "";

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

test("buildFusionChainSpawnParams creates a parallel panel step followed by a judge step", () => {
  const params = buildFusionChainSpawnParams(
    PROFILE,
    "Compare two API designs",
  );

  assert.equal(params.async, true);
  assert.equal(params.clarify, false);
  assert.equal(params.context, "fresh");
  assert.equal(params.task, "Compare two API designs");
  assert.deepEqual(params.acceptance, FUSION_ACCEPTANCE_DISABLED);
  assert.equal(params.chain.length, 2);

  const panelStep = params.chain[0];
  assert.equal(panelStep.concurrency, 2);
  assert.equal(panelStep.failFast, false);
  assert.equal(panelStep.parallel.length, 3);
  assert.equal(panelStep.parallel[0]?.label, "Architect");
  assert.equal(panelStep.parallel[0]?.phase, "Panel");
  assert.equal(panelStep.parallel[0]?.as, "architect");
  assert.equal(panelStep.parallel[0]?.model, "openai/gpt-5.5:xhigh");
  assert.equal("outputSchema" in (panelStep.parallel[0] ?? {}), false);
  assert.deepEqual(
    panelStep.parallel[0]?.acceptance,
    FUSION_ACCEPTANCE_DISABLED,
  );

  const judgeStep = params.chain[1];
  assert.equal(judgeStep.agent, "pi-fusion.fusion-judge");
  assert.equal(judgeStep.label, "Judge");
  assert.equal(judgeStep.phase, "Judge");
  assert.equal(judgeStep.model, "openai/gpt-5.5:high");
  assert.match(judgeStep.task, /Original task:\n\{task\}/);
  assert.match(judgeStep.task, /\{outputs\.architect\}/);
  assert.match(judgeStep.task, /\{outputs\.tester\}/);
  assert.match(judgeStep.task, /# Fusion Report/);
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

  const params = buildJudgeSpawnParams({
    profile: PROFILE,
    prompt: "Compare two API designs",
    panelOutputs: outputs,
    failedPanelists,
    runId: "run-fixed-seed",
  });

  assert.equal(params.async, true);
  assert.equal(params.clarify, false);
  assert.equal(params.agent, "pi-fusion.fusion-judge");
  assert.equal(params.model, "openai/gpt-5.5:high");
  assert.equal(params.context, "fresh");
  assert.equal(params.timeoutMs, 300_000);
  assert.equal(params.output, true);
  assert.equal(params.outputMode, "inline");
  assert.equal(params.skill, false);
  assert.deepEqual(params.acceptance, FUSION_ACCEPTANCE_DISABLED);

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
    label: member.label,
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
    label: member.label,
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

test("buildPanelSpawnParams matches the pre-change baseline for the default profile", async () => {
  const baseline = JSON.parse(
    await readFile("test/fixtures/baseline-tasks.json", "utf8"),
  ) as { prompt: string; panel: unknown };
  const profile = createDefaultFusionConfig().profiles.quality;
  assert.ok(profile);

  assert.deepEqual(
    buildPanelSpawnParams(profile, baseline.prompt),
    baseline.panel,
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
    label: member.label,
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

test("buildFusionChainSpawnParams is unchanged; the legacy chain path is restore-only", () => {
  const params = buildFusionChainSpawnParams(
    PROFILE,
    "Compare two API designs",
  );
  const judgeStep = params.chain[1];

  assert.match(judgeStep.task, /## Architect \(architect\)/);
  assert.ok(
    judgeStep.task.indexOf("## Architect") <
      judgeStep.task.indexOf("## Tester"),
    "chain judge task must keep profile order",
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

test("buildJudgeSpawnParams passes judgeToolBudget through and omits it when absent", () => {
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
  assert.equal("toolBudget" in withoutBudget, false);
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

  const task =
    buildPanelSpawnParams(profile, "Ship the new API").tasks[0]?.task ?? "";

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
    buildPanelSpawnParams(profile, "Ship the API").tasks[0]?.task ?? "";

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

  const task =
    buildPanelSpawnParams(profile, "Ship the new API").tasks[0]?.task ?? "";

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

  const tasks = buildPanelSpawnParams(profile, baseline.prompt).tasks;

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
  assert.match(task, /- Security: Cover the security surface of \{task\}/);
  assert.match(task, /- Perf: throughput and latency/);
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
