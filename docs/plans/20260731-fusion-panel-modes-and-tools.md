# Fusion panel modes, judge hygiene, and configurable tools

## Overview

Five changes to `pi-fusion`, ordered by dependency:

1. **Configurable tools per panel member.** Panelists are currently locked to
   `read, grep, find, ls`. Widen the default to include web access, and ship
   agent variants so each member can be pointed at a different tool set via the
   existing `agent` field.
2. **Judge input hygiene.** Panel outputs reach the judge in fixed index order
   with role-revealing labels. Both are deterministic biases that favour the same
   member on every run.
3. **`--panel` inline override.** Trying a different panel composition currently
   requires editing `.pi/fusion.json`.
4. **Judge verification of contested claims.** When panelists conflict on a
   checkable fact, the judge arbitrates on prose instead of checking the file.
5. **Complementary panels (`synthesis: "merge"`).** Panel members answer
   _different_ facets of the task and a composer merges them, instead of every
   member answering the whole question and a judge picking a winner.

Benefits: panelists can gather external evidence, panel composition becomes
cheap to experiment with, judging stops being order-biased, factual conflicts get
resolved by inspection rather than rhetoric, and panels can cover a task by
division of labour rather than redundancy.

Integration constraint that shapes the whole design: **the composer runs in the
existing judge slot**, so no new `FusionPhase` value is introduced and
`fusion:rpc:v1` stays source-compatible for consumers such as
`@alexeiled/pi-plan-exec`.

## Context (from discovery)

- **Files/components involved:** `src/types.ts`, `src/config.ts`,
  `src/run-builder.ts`, `src/panel-completion.ts`, `src/report.ts`,
  `src/fusion-args.ts`, `src/claude-aliases.ts`, `agents/*.md`,
  `docs/user-guide.md`, `README.md`
- **Test layout:** `test/unit/*.test.ts` mirrors `src/*.ts` one-to-one;
  `test/integration/` holds `extension.test.ts` and `orchestrator.test.ts`;
  `test/e2e/package-smoke.test.ts` checks packaging. Runner is
  `node --import jiti/register --test`. Full gate is `npm run test:all`.
- **Related patterns found:** config parsing uses hand-written type guards
  (`isFusionProfile`, `isPanelMemberConfig`) rather than a schema library; spawn
  params are built in `run-builder.ts` as plain objects; agents are markdown
  files with YAML frontmatter, globbed into the package via
  `package.json` `files: ["agents/*.md", ...]`.

### Verified platform facts

These were read from the installed `pi-subagents` and `pi-web-providers`
packages and constrain the design. Do not re-litigate them during
implementation.

| Fact                                                                                                                                                                                                  | Source                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **The spawn schema has no per-task `tools` field.** Tasks may override `model`, `thinking`, `toolBudget`, `outputSchema`, `count` only. Tool sets come from the agent definition.                     | `pi-subagents/src/extension/schemas.ts:108-201`                                                            |
| `toolBudget` **is** a per-task override — `{soft, hard}`, blocking non-read tools after `hard`                                                                                                        | `pi-subagents/src/extension/schemas.ts:108`                                                                |
| Omitting `tools:` from frontmatter yields `tools === undefined` → `explicitToolAllowlist === false` → no `--tools` flag → agent inherits Pi's full ambient toolset                                    | `agents/agents.ts` (`tools: rawTools !== undefined ? tools : undefined`), `runs/shared/pi-args.ts:166,247` |
| Declaring `tools:` still leaves ambient extensions loaded — `disableAmbientExtensions` only trips on `denyExtensions` or an explicit `extensions:` key                                                | `runs/shared/pi-args.ts:175`                                                                               |
| Real web tool names are `web_search`, `web_contents`, `web_answer`, `web_research`. **`fetch_content` / `get_search_content` in the bundled `researcher.md` are stale and would resolve to nothing.** | `pi-web-providers@3.5.1` dist                                                                              |
| `web_research` routes to `sonar-deep-research` in this setup — minutes per call, and a panel would fire it N times in parallel                                                                        | `~/.pi/agent/web-providers.json`                                                                           |
| Missing declared tools are reported via `ChildToolDiagnostic { required, available, missing }`                                                                                                        | `pi-subagents/src/runs/shared/tool-availability.ts`                                                        |
| Pi core child tools: `bash, edit, find, grep, ls, read, write`                                                                                                                                        | `runs/shared/tool-availability.ts:16`                                                                      |
| Chains abort on any nonzero child exit; Fusion must keep using spawn → reconcile → spawn                                                                                                              | `runs/background/subagent-runner.ts:3239,3599`                                                             |

## Development Approach

- **testing approach**: Regular (code first, then tests)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional - they are a required part of the checklist
  - write unit tests for new functions/methods
  - write unit tests for modified functions/methods
  - add new test cases for new code paths
  - update existing test cases if behavior changes
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change
- maintain backward compatibility: an existing `.pi/fusion.json` with no new
  fields must produce byte-identical behaviour to today

## Testing Strategy

- **unit tests**: required for every task; add to the existing
  `test/unit/<module>.test.ts` matching the changed source file
- **integration tests**: `test/integration/orchestrator.test.ts` covers spawn
  sequencing against `test/support/fake-pi.ts`; extend it for merge mode and the
  single-output guard
- **e2e tests**: this project has no UI. `test/e2e/package-smoke.test.ts` checks
  that packaged files resolve — extend it when new agent files are added, since
  a missing agent in the published tarball is a silent runtime failure
- **table-driven** cases preferred for config validation and arg parsing, matching
  the existing style in `test/unit/config.test.ts` and `test/unit/args.test.ts`

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview

**Tools are an agent-level concern, not a config-level one.** Because the spawn
schema cannot carry a tool list, per-member tool customisation is expressed by
pointing `PanelMemberConfig.agent` at a different agent definition. Fusion ships
three variants; users who need something else write their own `.md` and
reference it. No config schema change is required for this, and it works with the
platform rather than against it.

**Judge hygiene is presentation-only.** Shuffling and blind labels change how
panel outputs are rendered into the judge task, not what runs. The shuffle is
seeded from `runId` so a persisted run renders identically when re-read via
`fusion:rpc:v1` `adopt`.

**Merge mode reuses the judge slot.** `synthesis: "merge"` swaps which agent and
which output contract are used for the synthesis spawn. `judgeRunId`,
`judgeAsyncDir`, and `FusionPhase` are untouched, so RPC consumers see no new
states.

### Key design decisions

- **`agent` over a new `tools` field** — the alternative (Fusion writing agent
  definitions at runtime via `subagent config`) puts mutable state outside the
  repository and races when two `/fusion` runs start together.
- **`web_research` excluded from defaults** — a panel of 3–5 members would fire
  `sonar-deep-research` concurrently, making `/fusion` unusable on latency.
  Available in `fusion-panelist-full` and to custom agents.
- **`fusion-panelist-full` is opt-in and documented as unsafe at
  `concurrency > 1`** — it grants `edit`/`write`/`bash`, which breaks the
  read-only guarantee currently asserted in `README.md` and `docs/user-guide.md`.
  The default stays read-only so those claims remain true.
- **Merge mode gets its own agent and contract** — `fusion-judge` is a _selection_
  contract (`Consensus`, `Disagreements`, "prefer the smallest realistic
  recommendation"). Over disjoint facets, consensus is undefined, disagreement
  fires on non-overlapping content, and "smallest" discards the union that was
  the point. Reusing it with a flag would ship a wrong report, not a thin one.

## Technical Details

### Type changes (`src/types.ts`)

```ts
export type FusionSynthesisMode = "select" | "merge";

export interface PanelMemberConfig {
  // ...existing fields unchanged
  question?: string; // facet prompt template; "{task}" is substituted
}

export interface FusionProfile {
  // ...existing fields unchanged
  synthesis?: FusionSynthesisMode; // default "select"
  judgeToolBudget?: { soft?: number; hard?: number };
  blindPanelLabels?: boolean; // default false
}

export interface PanelOutput {
  // ...existing fields unchanged
  missingTools?: string[]; // from ChildToolDiagnostic
}
```

`ParsedFusionArgs` gains `panel?: string[]`.

### Processing flow

1. `parseFusionArgs` may return `panel: string[]`; `resolveProfile` builds an
   ephemeral profile from that list when present, keeping the resolved profile's
   judge and other settings.
2. Panel spawn is unchanged except that `member.question` — when set — replaces
   the full prompt in `buildPanelTask`.
3. On panel completion, outputs are ordered by a `runId`-seeded shuffle and
   optionally relabelled `Candidate A/B/C` before being formatted into the
   synthesis task.
4. `decidePanelCompletion` chooses `fusion-judge` + `JUDGE_OUTPUT_CONTRACT` for
   `select`, or `fusion-composer` + `COMPOSER_OUTPUT_CONTRACT` for `merge`, and
   attaches `toolBudget` when configured.
5. The report restores real labels from the blind mapping so the user always sees
   who said what.

### Agent tool sets

| Agent                       | `tools:`                                                     |
| --------------------------- | ------------------------------------------------------------ |
| `fusion-panelist` (default) | `read, grep, find, ls, web_search, web_contents, web_answer` |
| `fusion-panelist-lite`      | `read, grep, find, ls`                                       |
| `fusion-panelist-full`      | above + `bash, edit, write, web_research`                    |
| `fusion-judge`              | `read, grep, find, ls, web_search, web_contents, web_answer` |
| `fusion-composer`           | same as `fusion-judge`                                       |

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tasks achievable within this codebase - code changes, tests, documentation updates
- **Post-Completion** (no checkboxes): items requiring external action - manual testing, changes in consuming projects, deployment configs, third-party verifications

## Implementation Steps

### Task 1: Widen default agent tools and ship panelist variants

**Files:**

- Modify: `agents/fusion-panelist.md`
- Modify: `agents/fusion-judge.md`
- Create: `agents/fusion-panelist-lite.md`
- Create: `agents/fusion-panelist-full.md`
- Modify: `test/e2e/package-smoke.test.ts`
- Create: `test/unit/agents.test.ts`

- [x] set `tools: read, grep, find, ls, web_search, web_contents, web_answer` in `agents/fusion-panelist.md` and `agents/fusion-judge.md`
- [x] create `agents/fusion-panelist-lite.md` as a read-only variant (`read, grep, find, ls`), body identical to the default panelist
- [x] create `agents/fusion-panelist-full.md` adding `bash, edit, write, web_research`, with a frontmatter `description` and a body warning that it is unsafe at `concurrency > 1` and voids the read-only guarantee
- [x] confirm `package.json` `files` glob `agents/*.md` picks up the new files (verified via `npm pack --dry-run --json`; all four present, no manifest change needed)
- [x] write test in `test/e2e/package-smoke.test.ts` asserting all four panelist/judge agent files are present in `npm pack --dry-run` output
- [x] write test asserting each shipped agent's frontmatter declares a non-empty `tools:` list and uses only names from the verified vocabulary
- [x] run tests - must pass before task 2

➕ Added `test/unit/agents.test.ts` (not in the original Files list) with six
guards beyond the two required: only `fusion-panelist-full` may hold write tools,
default panelist and judge must reach the web, `web_research` stays off outside
the full variant, and `fusion-panelist-lite` is pinned to the exact read-only set.
These lock in the safety properties the docs will assert in Task 13.

⚠ `npm pack` and therefore `npm run test:e2e` / `test:all` need the sandbox
disabled: npm writes to `~/.npm/_cacache`, which is outside the sandbox write
allowlist and fails with EPERM. Not a code problem; adjust via `/sandbox` if it
becomes noisy.

### Task 2: Validate agent tool names at config load

**Files:**

- Modify: `src/config.ts`
- Modify: `test/unit/config.test.ts`

⚠ **Scope corrected during planning.** The original task was to read
`ChildToolDiagnostic` from lifecycle artifacts. That is not buildable:
`toolDiagnosticPath` is `path.join(tempDir, "tool-diagnostic.json")`
(`pi-args.ts:289`) inside pi-subagents' own private temp directory, not under the
`panelAsyncDir` that Fusion reads. pi-subagents consumes it internally via
`readChildToolDiagnosticError` (`subagent-runner.ts:1288`) and turns a missing
required tool into a run error — which Fusion **already** captures today in
`FailedPanelSummary.summary`. Runtime detection therefore needs no work; what is
missing is catching bad tool names before a run is spent.

⚠ **Scope corrected a second time during implementation.** `validateShippedAgentTools()`
was dropped. It would read the bundled agents' markdown at runtime to check
something a CI test already guarantees — dead code by the repo's own "no unused
abstractions" rule, and it cannot check *user* agents because Fusion has no
access to the pi-subagents registry (`subagents-rpc.ts` exposes only
ping/spawn/status/stop/interrupt — no list). Replaced with the two pieces that
carry real weight: one shared vocabulary, and validation of the one agent-related
thing a user actually types.

- [x] add exported `KNOWN_TOOL_NAMES` to `src/config.ts` covering Pi core (`read, bash, edit, write, grep, find, ls`) and `pi-web-providers` (`web_search, web_contents, web_answer, web_research`); `test/unit/agents.test.ts` imports it instead of keeping a second copy
- [x] add exported `isAgentReference()` and apply it in `isPanelMemberConfig` and `isJudgeConfig`, replacing the bare `isNonEmptyString(value.agent)` check
- [x] ~~treat `mcp:`-prefixed entries as always valid~~ — retained in `test/unit/agents.test.ts` where tool names are actually checked
- [x] write tests: accepted agent shapes, rejected typo classes, malformed panel agent rejected by `parseFusionConfig`, malformed judge agent rejected
- [x] write test asserting `KNOWN_TOOL_NAMES` matches the verified vocabulary table in this plan
- [x] run tests - must pass before task 3

**Validation deliberately kept narrow.** `isAgentReference` does *not* enforce
pi-subagents' lowercase `IDENTIFIER_PATTERN` (`agents/identity.ts:3`): that
pattern governs package names and never covers the frontmatter `name`, so
enforcing it could reject a config that would actually run. It rejects embedded
whitespace, empty segments, and leading/trailing dots — the classes that are
unambiguously typos.

➕ Also exported `PANEL_AGENT_LITE` and `PANEL_AGENT_FULL` alongside the existing
`PANEL_AGENT`, so Task 5's inline parser and Task 13's docs reference constants
rather than repeating string literals.

### Task 3: Deterministic seeded ordering of panel outputs for the judge

**Files:**

- Modify: `src/run-builder.ts`
- Modify: `test/unit/run-builder.test.ts`

**Decisions made during planning, do not re-open:**

- The shuffle is **unconditional**, not behind a flag. A biased default is a
  defect, and an opt-in fix leaves it defective for everyone who does not read
  the changelog. This _is_ a behaviour change — the default-profile judge task
  differs from `master` — so it needs a `CHANGELOG.md` entry, and Task 12's
  byte-equality gate applies to everything _except_ output ordering.
- `buildChainJudgeTask` (`run-builder.ts:330`) is **deliberately left alone**. It
  serves the legacy chain form, which README documents as restore-only for runs
  created before the flat-spawn design. It builds its task from the profile at
  render time and never sees `PanelOutput`, so it has no run-time ordering to
  shuffle.

- [x] add a small seeded PRNG helper and a `shufflePanelItems(items, seed)` function in `src/run-builder.ts` (FNV-1a + mulberry32, dependency-free and stable across Node versions — the reproducibility guarantee depends on that)
- [x] thread `runId` into `BuildJudgeSpawnParamsInput` and use it as the shuffle seed, replacing the `comparePanelItems` index sort in `buildJudgeTask`
- [x] keep `formatPanelStatus` and `formatFailedPanelists` in stable index order — only the outputs block is shuffled
- [x] add a `CHANGELOG.md` entry recording the ordering change
- [x] write test asserting the same `runId` produces the same order across calls (reproducibility for `adopt`/replay)
- [x] write test asserting different `runId`s produce different orders over a sample, and that the output set is unchanged (permutation, no loss)
- [x] write test asserting a single-output panel and an empty panel are handled without error
- [x] write test asserting `buildChainJudgeTask` output is unchanged from `master`
- [x] run tests - must pass before task 4

➕ `runId` was made **required** on `BuildJudgeSpawnParamsInput` rather than
optional. An optional seed with an index-order fallback would silently restore
the bias at any call site that forgot it; a required field makes the compiler
catch that.

➕ Baseline fixture captured before any `run-builder.ts` change and committed as
`test/fixtures/baseline-tasks.json`; the two byte-equality tests promised for
Task 12 are already in `test/unit/run-builder.test.ts`.

### Task 4: Optional blind candidate labels

**Files:**

- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/run-builder.ts`
- Modify: `src/report.ts`
- Modify: `test/unit/config.test.ts`
- Modify: `test/unit/run-builder.test.ts`
- Modify: `test/unit/report.test.ts`

- [x] add `blindPanelLabels?: boolean` to `FusionProfile` (default `false`) and validate it in `isFusionProfile`
- [x] when enabled, render panel outputs to the judge as `Candidate A`, `Candidate B`, …
- [x] restore real labels in `src/report.ts` so the user-facing report always names the actual member
- [x] write config validation tests: valid `true`/`false`, rejected non-boolean, absent field defaults to `false`
- [x] write test asserting judge task contains no real labels or role text when enabled
- [x] write test asserting the report still shows real labels when enabled
- [x] run tests - must pass before task 5

➕ **Blinding had to cover more than the heading.** Labels alone were not enough:
`Agent: pi-fusion.fusion-panelist-lite` reveals which variant a member uses, and
artifact/session paths embed the member id (`/tmp/generalist.md`). Under blinding
those lines are withheld entirely — they are reader aids, not judging inputs. The
test asserts none of the id, label, role, agent, or path strings survive.

➕ **No new run state.** Rather than returning a mapping from
`buildJudgeSpawnParams` and persisting it, `buildBlindLabelMap` is exported and
recomputed in `report.ts`. It is a pure function of the panel indices, so both
sides derive the same mapping. `restoreBlindLabels` replaces longest label first
so `Candidate AA` is not corrupted by the `Candidate A` rule.

➕ Blind names are assigned **by index**, while presentation order stays
shuffled — so the judge cannot recover the mapping from position either.

### Task 5: `--panel` inline override

**Files:**

- Modify: `src/types.ts`
- Modify: `src/fusion-args.ts`
- Modify: `src/config.ts`
- Modify: `test/unit/args.test.ts`
- Modify: `test/unit/config.test.ts`

**Entry syntax, resolved during planning.** Tools come from the agent, not the
model (see the platform facts table), so an inline entry must be able to name
both. Each comma-separated entry is `<model>` or `<agent>:<model>`:

```text
--panel opus,gpt-5.5                              # both use PANEL_AGENT (default)
--panel opus,pi-fusion.fusion-panelist-lite:gpt-5.5
```

A bare entry defaults its agent to `PANEL_AGENT`. Split on the **last** `:` that
precedes a known agent-shaped prefix — note `model` strings already use `/` for
provider and `:` for the thinking suffix (`appendThinkingSuffix`), so the parser
must not mistake `opus:high` for an agent-qualified entry. Rule: an entry is
agent-qualified only when the segment before the first `:` contains a `.`
(package-qualified agent names always do).

- [x] add `panel?: string[]` to `ParsedFusionArgs` and parse `--panel a,b,c` plus `--panel=a,b,c` in `parseFusionArgs`, following the existing `--profile` handling
- [x] add `buildInlinePanelProfile(base, entries)` in `src/config.ts` that clones the resolved profile and replaces `panel` with one member per entry, defaulting `agent` to `PANEL_AGENT`, generating unique `id`/`label` from the model string, and keeping the base judge
- [x] apply Claude alias shorthand to inline models — the assembled profile is re-run through `applyClaudeAliasShorthand` in the orchestrator rather than reimplementing resolution, so inline and file config share one path
- [x] write arg parsing tests: both syntaxes, empty value rejected, duplicate `--panel` rejected, option after prompt treated as prompt text, whitespace around commas
- [x] write tests for entry splitting: bare model, agent-qualified entry, `opus:high` thinking suffix NOT treated as an agent, provider-prefixed `openai/gpt-5.5`, agent-qualified with thinking suffix
- [x] write tests for `buildInlinePanelProfile`: member count, generated ids unique, default agent applied, explicit agent preserved, judge preserved, alias resolution applied
- [x] write test asserting `--panel` and `--profile` combine (inline panel wins, profile supplies the judge)
- [x] run tests - must pass before task 6

⚠ **One planned test was wrong and the code was right.** The plan expected
`--panel Compare things` to throw. It does not, and should not: `Compare` is a
one-entry panel and `things` is the prompt, exactly as `--profile Compare things`
behaves. Rejecting it would make `--panel` inconsistent with the flag it is
modelled on. The test now pins that behaviour explicitly instead.

### Task 6: Judge verification of contested claims

**Files:**

- Modify: `agents/fusion-judge.md`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/run-builder.ts`
- Modify: `test/unit/config.test.ts`
- Modify: `test/unit/run-builder.test.ts`

- [x] add a `## Contested Claims` section to `JUDGE_OUTPUT_CONTRACT` and to `agents/fusion-judge.md`, instructing the judge to resolve conflicting factual claims by direct inspection, cite `file:line`, and explicitly mark anything it could not verify
- [x] add `judgeToolBudget?: { soft?: number; hard?: number }` to `FusionProfile` with validation in `isFusionProfile` (positive integers, `soft <= hard`)
- [x] pass `toolBudget` through to the judge spawn params in `buildJudgeSpawnParams` when configured
- [x] write config validation tests: valid budget, `soft > hard` rejected, zero/negative rejected, non-integer rejected, absent field omits `toolBudget` from spawn params
- [x] write test asserting the judge task and contract include the new section
- [x] run tests - must pass before task 7

➕ `toolBudget` had to be declared on `JudgeSpawnParams` explicitly. A conditional
spread carries excess properties past TypeScript's checks, so the field reached
the runtime payload while the type claimed it did not — a silent hole rather than
a compile error.

➕ **The baseline gate fired, as designed.** Adding the contested-claims block
broke the byte-equality test from Task 3. Rather than re-snapshotting the
baseline — which would retire the guard — the test now strips the two *known*
intentional differences (seeded answer order, contested-claims block) and still
requires byte equality on everything else.

➕ `judgeToolBudget` rejects `{}`: an empty budget reads as "configured" while
doing nothing.

### Task 7: Per-member facet questions

**Files:**

- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/run-builder.ts`
- Modify: `test/unit/config.test.ts`
- Modify: `test/unit/run-builder.test.ts`

- [x] add `question?: string` to `PanelMemberConfig` and validate it in `isPanelMemberConfig` (string; reject empty/whitespace-only when the key is present)
- [x] in `buildPanelTask`, when `member.question` is set, substitute `{task}` with the prompt and send that instead of the raw prompt; keep the role line, instructions, and output contract unchanged
- [x] handle a `question` with no `{task}` placeholder by appending the original task under an `Original task:` heading rather than silently dropping context
- [x] write config tests: valid question, empty string rejected, non-string rejected, absent field unchanged behaviour
- [x] write `buildPanelTask` tests: substitution occurs, multiple `{task}` occurrences all replaced, missing-placeholder fallback, no `question` produces today's exact output
- [x] run tests - must pass before task 8

### Task 8: `synthesis` mode and the `fusion-composer` agent

**Files:**

- Create: `agents/fusion-composer.md`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/run-builder.ts`
- Modify: `test/unit/config.test.ts`
- Modify: `test/unit/run-builder.test.ts`
- Modify: `test/e2e/package-smoke.test.ts`

- [x] create `agents/fusion-composer.md` with contract `# Fusion Report` / `## Summary` / `## Coverage Map` / `## Combined Answer` / `## Gaps` / `## Conflicts At Seams` / `## Agent Status` / `## Risks` / `## Next Step`
- [x] add `FusionSynthesisMode` and `synthesis?: FusionSynthesisMode` on `FusionProfile`, defaulting to `"select"`, validated in `isFusionProfile`
- [x] add `COMPOSER_OUTPUT_CONTRACT` and `buildComposerTask` in `src/run-builder.ts`, instructing the composer to merge rather than select and to name which facet each member covered
- [x] select agent + contract by `synthesis` inside `buildJudgeSpawnParams`, keeping `judgeRunId`/`judgeAsyncDir`/`FusionPhase` untouched
- [x] add `pi-fusion.fusion-composer` to the exported agent-name constants alongside `PANEL_AGENT`/`JUDGE_AGENT`
- [x] write config tests: `"select"`, `"merge"`, invalid string rejected, absent defaults to `"select"`
- [x] write tests asserting merge mode spawns the composer with the composer contract, and select mode is byte-identical to today
- [x] extend the packaging test to require `agents/fusion-composer.md`
- [x] run tests - must pass before task 9

### Task 9: Merge-mode completion guard

**Files:**

- Modify: `src/panel-completion.ts`
- Modify: `src/report.ts`
- Modify: `test/unit/panel-completion.test.ts`
- Modify: `test/unit/report.test.ts`

**Success-path rendering, assigned here.** The composer emits `# Fusion Report`
with different sections than the judge. `renderJudgeReport` currently appends
run metadata (timings, usage, model failures) around a passthrough of the agent's
markdown — verify that during implementation. If it is section-agnostic, reuse it
unchanged and say so in the commit; if it hardcodes judge section names, add a
`renderComposerReport` sharing the metadata helpers.

- [x] make the `panelOutputs.length === 1` short-circuit in `decidePanelCompletion` conditional on `synthesis !== "merge"` — under merge the lone survivor answered one facet, so returning it as the answer is wrong, not thin
- [x] under merge with a single output, still run the composer so the report states which facets are missing
- [x] confirm whether `renderJudgeReport` is section-agnostic; reuse it for merge if so, otherwise add `renderComposerReport` reusing the metadata helpers
- [x] add a merge-aware variant of `renderPanelFailureReport` naming the facets that were not covered when all panelists fail
- [x] write tests for `decidePanelCompletion`: select + 1 output returns `complete` (unchanged), merge + 1 output returns `judge`, merge + 0 outputs returns `fail`, select + 0 outputs unchanged
- [x] write tests for merge success rendering: composer sections preserved, run metadata still appended
- [x] write tests for merge failure rendering listing uncovered facets
- [x] run tests - must pass before task 10

➕ **`renderJudgeReport` was not section-agnostic**, contrary to the Task 9 note's
optimistic branch: it hardcodes the judge's section list. Rather than adding a
second renderer, the section list is now chosen by `synthesis` and everything
around it — agent status, run metadata, run details, blind-label restoration —
stays shared.

➕ **Merge mode swaps the agent, not the run slot.** `resolveSynthesisAgent`
returns the composer only when the judge agent is still the bundled default, so a
user who configured their own synthesis agent keeps it. The spawn still uses
`judgeRunId`/`judgeAsyncDir` under phase `judge`, so `fusion:rpc:v1` is untouched.

➕ **Facet assignments are sent to the composer**, listing what each member was
asked to cover. Without them the composer would have to infer gaps from the
answers it did receive — which is exactly the information a gap lacks. These are
blinded too when `blindPanelLabels` is on.

⚠️ Adding `## Contested Claims` to the judge report (Task 6) broke two existing
`report.test.ts` expectations. Updated in place; the other renderers
(`renderSinglePanelReport`, `renderPanelFailureReport`, `renderFailureReport`,
`renderCancelledReport`) do not carry the section and were left alone.

### Task 10: Merge-mode orchestration integration test

**Files:**

- Modify: `test/integration/orchestrator.test.ts`
- Modify: `test/support/fake-pi.ts`

- [ ] extend `test/support/fake-pi.ts` as needed to script a merge-mode run with per-member facet questions
- [ ] write integration test: full merge run reaches phase `done` and produces a composer report
- [ ] write integration test: merge run with one panelist failing still runs the composer and reports the gap
- [ ] write integration test: select-mode run is unchanged end to end (regression guard on backward compatibility)
- [ ] write integration test asserting no new `FusionPhase` value is emitted during a merge run
- [ ] run tests - must pass before task 11

### Task 11: pi extension integration checks

**Files:**

- Modify: `test/unit/config.test.ts`
- Modify: `test/unit/fusion-rpc.test.ts`
- Modify: `test/integration/extension.test.ts`

- [ ] verify `applyClaudeAliasShorthand` preserves the new `question` field when rewriting panel members (it spreads `...member`, so this is a regression guard, not a change)
- [ ] write test asserting a profile with `question`, `synthesis`, `blindPanelLabels`, and `judgeToolBudget` survives Claude alias rewriting intact
- [ ] write test asserting `fusion:rpc:v1` `status`/`result` payloads for a merge run contain only the existing `FusionPhase` values, so strict enum validators in consumers keep working
- [ ] write test asserting `FUSION_RPC_VERSION` is unchanged by this work
- [ ] write test asserting `/fusion init` still emits a template that parses under the updated validators
- [ ] run tests - must pass before task 12

### Task 12: Verify acceptance criteria

**Backward-compatibility gate, made concrete.** Before starting Task 3, check out
`master` and capture the exact `buildPanelTask` and `buildJudgeTask` strings for
the default profile into `test/fixtures/baseline-tasks.json`. Task 12 asserts
byte equality against those fixtures with all new config fields absent — with one
documented exception: judge output _ordering_ changes because the Task 3 shuffle
is unconditional. Normalise by sorting the output blocks before comparing, so the
test still catches any other drift in wording, headings, or contract text.

- [ ] verify all requirements from Overview are implemented
- [ ] write byte-equality test: `buildPanelTask` for the default profile matches the `master` fixture exactly
- [ ] write byte-equality test: `buildJudgeTask` for the default profile matches the `master` fixture after normalising output-block order
- [ ] verify edge cases are handled: single panelist, all panelists fail, merge without any `question`, `--panel` with one model
- [ ] run full test suite: `npm run test:all`
- [ ] verify `npm run lint` and `npm run check` are clean
- [ ] manually run `/fusion` once in select mode and once in merge mode against this repo and confirm reports render

### Task 13: [Final] Update documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/user-guide.md`
- Modify: `docs/ideas/orchestration-modes.md`
- Modify: `CHANGELOG.md`

- [ ] document the shipped agent variants and their tool sets in `docs/user-guide.md`, including how to point `agent:` at a custom agent and the correct web tool vocabulary (`web_search`, `web_contents`, `web_answer`, `web_research`)
- [ ] document `synthesis`, `question`, `blindPanelLabels`, `judgeToolBudget`, and `--panel` with a worked merge-mode profile example
- [ ] state plainly in `docs/user-guide.md` that `fusion-panelist-full` grants `edit`/`write`/`bash`, voids the read-only guarantee, and is unsafe at `concurrency > 1`
- [ ] audit the "Bundled Fusion agents are read-only" claim in `README.md` and `docs/user-guide.md` — it stays true for defaults, so scope it explicitly to the default and lite agents
- [ ] update the "Data sharing and provider use" section: panelists can now reach the web, so prompts and inspected snippets may leave the machine via the configured web provider
- [ ] mark the implemented items in `docs/ideas/orchestration-modes.md` §7 as shipped
- [ ] update `CLAUDE.md` if new patterns discovered (none expected — no such file exists today)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

Items requiring manual intervention or external systems — no checkboxes, informational only.

**Manual verification:**

- Confirm `web_search` actually resolves at runtime. `pi-web-providers@3.5.1` is
  installed here, but a user without it will see the tool in `missingTools`
  (Task 2) rather than a hard failure — check that path renders sensibly.
- Latency check: a 3-member panel with web access will be slower than today.
  Confirm `timeoutMs: 300_000` is still adequate, and raise the default if not.
- Merge-mode prompt quality is not unit-testable. Run several real questions and
  judge whether the composer's `Coverage Map` and `Gaps` sections are useful, or
  whether the facet questions need rewording.

**External system updates:**

- `@alexeiled/pi-plan-exec` consumes `fusion:rpc:v1`. Task 11 asserts no phase or
  version change, but a smoke test against the real consumer is worth doing
  before release.
- `@alexeiled/pi-subagents-bridge` may resolve agent names — verify the three new
  agent files are visible to it after `pi install`.
- Publishing: `npm pack --dry-run` is in the CI gate, but confirm the new agent
  markdown files appear in the published tarball before tagging a release.

**Deliberately out of scope** (decided during planning):

- Model registry, cost/latency metadata, budget-constrained panel assembly,
  `--estimate`, named presets — dropped on request.
- Cascade mode — its motivation was cost, which is no longer a concern.
- Dynamic facet decomposition via a `fusion-scout` planner — revisit only after
  static facets prove useful.
- Inter-panelist debate — see `docs/ideas/orchestration-modes.md` §4c.
