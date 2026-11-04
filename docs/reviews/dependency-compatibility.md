# Dependency and usability review

Evidence checked: 2026-11-04. Scope: Fusion 0.12.0, baseline commit
`1e1bb9a`, published npm packages, upstream release notes and implementation.
This is a maintainer review, not a promise of compatibility with future releases.

## Verdict

Keep the architecture: Pi owns the host and terminal, pi-subagents owns child
execution, and Fusion owns panel policy, evidence selection, synthesis and its
durable review record. A new runner, dashboard or footer would make this worse.

Update the dependency tree now for security and execution fixes. Before calling
the upgrade production-ready, diagnose the intermittent empty-judge failure
observed in final verification and resolve native auto-resume ownership. Then fix misleading configuration and status, remove the
obsolete wake workaround, and add compact native presentation.

## What was changed in this branch

- Pi development and peer ranges: `^1.5`; resolved 1.5.0.
- pi-subagents development range: `^0.84`; resolved 0.84.0. It remains a
  separately installed Pi extension, not an imported runtime dependency.
- Biome: `^2.6`, resolved 2.6.4; Vitest: `^5.1`, resolved 5.1.0.
- Refreshed compatible lockfile entries, including TypeBox 1.4.3 and Node 24
  types 24.19.2. TypeScript 7.0.2 and jiti 2.7.0 were already current.
- TypeBox peer: `^1.3`, not `*`. Removed the unused direct TUI peer: Fusion
  imports no TUI components; Pi still supplies its matching TUI transitively.
- Migrated Biome's promoted `useImportsFirst` rule from nursery to style,
  preserving its error severity. Made an optional pending Promise existence
  check explicit; its behavior is unchanged.
- Included the existing changelog in the published tarball. Pi 1.5 can now show
  Fusion update notes on a fresh launch; no new renderer is needed.
- Updated optional web setup to maintained Webfox, including migration limits.
  No personal packages, provider configuration or credentials were changed.
- Expanded real-owner tests: unsupported explicit lifetime rejects without
  native spawn; answers exceeding the native 2,000-character preview reach
  synthesis intact.

Runtime orchestration, wake behavior, progress classification and recovery
policies were not changed. Recommendations below are not implemented features.

## Integration map

| Boundary | Fusion use | Owner and constraints |
| --- | --- | --- |
| Pi extension API | Tool/command registration, session events, trust, configuration paths | Public coding-agent exports; no private core imports |
| Pi event bus | Native requests/replies and lifecycle hints; Fusion's own versioned RPC | Process-local, not a cross-process transport |
| pi-subagents RPC v1 | Async script panel, separate script judge, targeted status, stop/interrupt/steer | Upstream validates and executes; Fusion must not infer admission or retirement from transport success |
| Workflow script API | Stable slot keys, rolling refill, concurrency, budgets, deadlines, agreement rounds | Generated JavaScript uses public `runs.*`; no imported subagent internals |
| Lifecycle artifacts | Complete outputs, per-child failures, late reconciliation | Upstream owns paths, schema and retention; absence is not permission to retry |
| Fusion persistence | Session entries, disk snapshots, operation identity and admission fencing | Fusion owns review state; not a substitute for native process ownership |
| Pi UI | Notifications, custom transcript messages, only the `fusion` status key | Pi owns layout, footer, rendering and keybindings |
| TypeBox | Tool parameter and structured-output schemas | Host-provided; ordinary JSON Schema subset |
| Webfox / legacy web extension | Optional named web tools in bundled agent allowlists | Separately loaded and configured in children; no SDK import |
| Other controllers | `fusion:rpc:v1`, including operation replay and strict caller output | Keep this independent of model tools, which are model-only |

Relevant code: `src/index.ts`, `subagents-rpc.ts`, `run-builder.ts`,
`orchestrator.ts`, `lifecycle-reconcile.ts`, `run-store.ts`,
`operation-journal.ts`, `fusion-rpc.ts`, `status.ts`, `completion-wake.ts`.
There is no pi-intercom or Bridge runtime dependency. A background-work API or
trusted workflow-resource import would be a new integration, not an existing one.

## Upstream changes that matter

### pi-subagents: 0.76.1 to 0.84.0

| Release | Relevant change | Consequence for Fusion |
| --- | --- | --- |
| 0.77 | Data-only parallel workflow; queued/paused RPC stop fixes; retained direct-run correlation; bounded output previews; trust fixes | Useful public seams, but not a drop-in replacement for Fusion's richer panel script. Keep full artifact reads and exact target IDs |
| 0.78 | Correct tool-budget exhaustion, workflow capacity release, timeout partial output, actual observed model display | Preserve upstream failure categories and distinguish configured versus observed models |
| 0.79–0.79.2 | Relaunch reuse, paused-run controls, ownership succession, capacity fixes | Better native recovery is not authorization for Fusion to retry or adopt a replacement ID |
| 0.80 | Pi >=1.2 required; native idle custom-message wake; per-task model/cwd in data workflows | Old Pi 1.0 support no longer fits; Fusion's synthetic wake line is obsolete |
| 0.81 | Provider retry diagnostics on structured delegation; smaller bundled load; clear automated notices; structured-output recovery turn | Better diagnostics can distinguish provider backoff from stalled work, but verify that the chosen RPC/lifecycle route exposes them |
| 0.82 | Automatic workflow resume after reload/crash; boot identity; result recovery; patched Undici | Main upgrade risk: native recovery can continue under a different run ID |
| 0.82.1 | Corrupt run status no longer hides unrelated runs | Do not recreate a global native status scanner in Fusion |
| 0.83 | `jobsChanged` refresh event; final-reply/settlement fixes; prompt-cache preservation; provider/extension binding fixes | Opportunity to reduce polling and fewer lost outputs/cache misses |
| 0.83.1 | Safer explicit-ID controls, session-ID capability ceilings, frontmatter parsing fixes | Some formerly accepted launches correctly fail; never bypass ceilings or trust |
| 0.84 | Workflow sandbox escape fix; real artifact cleanup; clearer missing-provider-extension errors | Security minimum for this script-based integration; retention can remove old native evidence |

The 0.84 sandbox advisory concerns workflow access outside the sandbox via
`Error.prepareStackTrace`; dynamic import is also rejected before execution.
Fusion's generated scripts are not evidence of an exploit, but relying on an old
vulnerable workflow engine is unnecessary.

The actual 0.84 RPC methods are `ping`, `status`, `manage`, `spawn`,
`steer`, `interrupt`, `stop`, `resume`, and `cost`. Fusion's hypothetical
`lookup`/`cancel`, `ownedWorkflow`, durable native operations and kernel
containment contract are **not implemented by this published runtime**.
Positive strict-execution tests use a fake runtime. Ordinary execution and its
weaker stop semantics must not be described as strict lifetime guarantees.

### Pi core/TUI: 1.0.4 to 1.5.0

- **1.1:** program status reporting, settled/aborted state, render duration and
  padding. Let native Pi surface working/blocked state; do not write terminal
  status sequences independently.
- **1.2:** idle `sendMessage(..., { triggerTurn: true })` runs
  `before_agent_start`; starting sessions count as busy. This removes the reason
  for `completion-wake.ts` to inject an artificial user prompt.
- **1.3/1.4:** provider and terminal fixes, bounded/queued codemode execution,
  safer concurrent dialogs, resumed tool availability and compaction fixes.
  These help child reliability without new Fusion infrastructure.
- **1.5:** tool arguments use pi-schema, rather than all TypeBox-specific
  semantics; incremental tool parsing and cached rendering; extension update
  changelogs; injected keybinding hints; blocked custom dialogs; fixes to saved
  session writes and trust decisions; patched glob matching and Undici.

Fusion uses plain JSON Schema-compatible TypeBox constructs, not refinements,
codecs or custom formats. The current import is valid: Pi aliases bare
`typebox`; migrating to a Pi-AI compatibility import is not necessary.
The typecheck and real-host tests pass; exhaustive argument-coercion behavior
is a separate test opportunity.

Core and its TUI/AI/agent packages are version-matched internally. Do not bump
their transitive versions independently. The TUI npm package has no separate
changelog in its tarball; core release notes and public TUI docs supplied the
rendering evidence.

### Optional web: an actual migration, not a version bump

`pi-web-providers` 3.5.1 is deprecated. Its maintained successor is
**Webfox 4.10.0**, not a newer version under the old npm name.

- Tool names remain `web_search`, `web_contents`, `web_answer`,
  `web_research`; existing agent allowlists still name the right tools.
- Version 4 changed configuration to `~/.config/webfox/config.yaml`
  (or `WEBFOX_CONFIG`). The old JSON schema, credential syntax and
  `/web-providers` UI are not migrated by renaming a file.
- Capabilities need saved provider defaults and available credentials.
  A search-only setup does not satisfy Fusion's three-tool web agent.
- Claude/Codex providers and automatic contents prefetch were removed;
  Gemini search is no longer a standalone search capability.
- Webfox 4.6 added structured Pi/codemode results and read-only/open-world tool
  annotations. Version 4.7 grouped discovery under `web` without renaming tools.
- Version 4.9 removed a vulnerable Zod 3 dependency, improved request cancellation,
  and reports missing Valyu pages as errors. Version 4.10 added Keenable search.
- Webfox supports Node 22+; old pi-web-providers 3.5.1 requires Node 24+.
  There is no need to raise Fusion's Node 22.19 minimum for Webfox.

Do not load both packages: they define the same tool names. Keep the user's old
configuration until migration is verified. Live provider calls, child loading
and Webfox's independent dependency audit were not run here.

## Prioritized recommendations

### P1 — Diagnose the observed empty synthesis before release

**Observed in a real-owner run, not only a static concern.** One full-suite run
failed the merge profile with `Fusion judge completed without output.` after two
successful panelists. The isolated expanded E2E test and subsequent full-suite
attempts passed that route. This is intermittent; attributing it to CPU load or
the dependency upgrade is not proven.

The current judge path can fail immediately when a terminal snapshot has no
extractable output (`src/orchestrator.ts:2208–2259`). Panel snapshots have a
separate bounded reconciliation grace path. That asymmetry is an investigation
lead, not an established root cause.

Preserve native status/result files and host logs on the next fixture failure
instead of removing the temporary directory unconditionally. Compare terminal
state, result-file publication, completion payload, artifact selection and actual
provider reply before changing production code. Add a regression at the proven
boundary. Do not turn empty synthesis into a panel-only success or retry a paid
model as a workaround.

### P1 — Make one owner responsible for workflow recovery

**Confirmed upstream behavior; Fusion consequence not reproduced end-to-end.**
Since 0.82, native auto-resume defaults to true and relaunches eligible top-level
workflows under new IDs. Fusion tracks original panel/judge IDs and quarantines
runtime replacement. The owner can continue paid work that Fusion does not adopt.

Evidence: upstream `src/extension/index.js:954–959`,
`src/workflows/workflow-auto-resume.js:41–86`,
`src/workflows/workflow-resume.js:81–103`; Fusion
`src/orchestrator.ts:1301–1342, 1682–1686, 2330–2335`.

**Now:** document `autoResume: false` in upstream configuration and avoid reloads
while Fusion is active. This is global, not a per-spawn RPC field; Fusion must
not silently edit it or invent an unsupported request option.

**Then:** agree on a public per-run recovery policy or authenticated resume-chain
adoption. Test reload/crash/reopen during both panel and judge, cancellation
during replacement, and duplicate/late completion. A replacement native ID needs
validated ancestry, immutable task identity and cancellation fencing—not just a
matching prompt. Do not remove quarantine or add a force-reset shortcut.

### P2 — Stop advertising a contract no published dependency implements

`src/index.ts:48–59` exposes `executionLifetime`; preflight correctly rejects it
at `src/orchestrator.ts:253–270` using `src/runtime-contract.ts:49–98`.
The defect is usability and misleading “update pi-subagents” advice, **not**
missing safety gating. The expanded real-owner test confirms no native spawn.

Prefer a stable tool schema focused on supported features, or explicitly label
this as requiring a capability-advertising custom runtime. Keep controller
contract negotiation separate. Do not silently replace an explicit execution
guarantee with ordinary timeouts. Do not add more kernel backend code until
there is a real supported owner and a real-owner integration test.

### P2 — Resolve model and thinking configuration before dispatch

Defaults specify thinking levels without models
(`src/config.ts:94–116`). `appendThinkingSuffix()` returns no model when model
is absent (`src/run-builder.ts:198–204`), and panel/judge envelopes transmit
thinking only through a model suffix. Those configured thinking values therefore
do not independently reach native execution; inherited agent/parent settings win.

Show requested, inherited and observed model/effort separately. Either resolve
the effective native model before adding a thinking suffix, or warn that thinking
without a model cannot override inherited effort. Preserve native agent model
overrides; copying the parent model unconditionally would change that behavior.
Test explicit model, agent default, parent inheritance, suffix precedence and
unsupported effort. Default Fusion is role-diverse, not necessarily model-diverse;
say so rather than implying every default panel uses different models.

### P2 — Clarify progress without changing execution inference accidentally

`src/status.ts:100–105` includes pending in totals but never displays it.
A queued panel can show zero running work with no explanation.
`classifyProgressItem()` also maps paused/detached to failure and can infer
completion from unknown-state text.

Show queued counts and distinct labels for panel, synthesis, partial, stopping
and recovery-required. Keep a compact status, for example:

```text
fusion: panel · 2/5 done · 1 running · 2 queued
fusion: synthesis · 4/5 answers · partial coverage
fusion: recovery required · /fusion status
```

Do not let a cosmetic classification change release admission or satisfy quorum.
Add behavioral fixtures for unknown/paused/detached/rejected/partial states before
changing terminal inference. Keep failures visible; do not rename partial as success.

### P2 — Remove the obsolete idle-wake workaround

`src/completion-wake.ts:10–14` appends a report and then sends
`Fusion update above.` as a user message. Pi >=1.2 supports the native
custom-message path; pi-subagents removed its equivalent shim in 0.80.

With the new Pi floor, send the custom report directly with existing
`triggerTurn`/`deliverAs` policy. Test real-host `before_agent_start`,
idle/busy/starting/aborted cases and controller-owned starts. Preserve the
at-most-once publication policy and warning: a crash between terminal persistence
and sending can still lose a notification. Native subagent notices can wake the
parent independently; `wakeOnCompletion: false` is not global wake suppression.

### P2 — Improve diagnosis before inventing retries

- Keep exact native IDs for stop/steer. Stop's `state: "stopping"` acknowledges
  delivery, not process-tree retirement. Audit the unconditional stop-error to
  interrupt fallback (`src/orchestrator.ts:544–558, 1235–1245`) against queued,
  paused and proof-not-ready native states.
- The current ambiguous `execution_failed` quarantine is inconvenient but safe.
  Typed admission/no-start evidence is the right upstream enhancement.
- A capability-aware `/fusion doctor` could show required methods, workflow-script
  policy, unsupported lifetime, inherited models, missing child tools and native
  control IDs in one place. Do not guess provider availability from installation.
- Use optional provider retry diagnostics when the public route exposes them;
  unknown is better than pretending a quiet provider is hung.
- Pi 1.5 distinguishes provider-billed totals from estimated cost. Propagate that
  distinction only if native artifacts carry it; do not infer billed cost.

### P3 — Use native transcript presentation, not another control plane

First add command/profile completions and clearer help. At
`src/commands.ts:55–83`, natural-language prompts beginning “finish …” or
“continue …” collide with deadline-control parsing. Give controls unambiguous
syntax or an explicit prompt escape path, while preserving existing callers.

Then add one compact expandable `fusion-report` renderer: summary,
coverage/quorum, failed perspectives, wall time and cost first; full Markdown,
model identity and evidence paths expanded. Keep the underlying message/report
and controller output unchanged. Add tool call/result renderers only if the
default receipt is still confusing after that.

Use public `registerMessageRenderer`, `renderCall`/`renderResult`, injected
theme, output padding and `keyHint`/`keyText`. Use TUI width helpers for Unicode;
test narrow widths, theme changes, resize, regular/fullscreen, HTML export and
headless fallbacks. Reintroduce a TUI peer only if directly importing it.

Retain only the `fusion` status key. Do not replace the footer, install another
terminal renderer, copy native Fleet, or add an always-visible widget/dashboard.
Native Fleet already supplies child inspection and controls.

### P3 — Adopt refresh events carefully; keep evidence reconciliation

0.83 adds `ping.events.jobsChanged`; its payload is only `{ version: 1 }`.
The current `handleLifecycleHint()` requires a run ID, so subscribing that handler
unchanged would do nothing (`src/index.ts:182–198`,
`src/orchestrator.ts:1084–1094`).

Add a separate coalesced “refresh current active run” path, including one
follow-up refresh when an event arrives in flight. Events are process-local, not
replayed, and jobsChanged does not fire in print/no-UI SDK mode. Keep startup and
restore reads and a slower fallback poll. Do not remove artifact reconciliation
because notifications appear reliable in one interactive session.

### P3 — Simplify only where semantics match

- Keep artifact-first extraction: native previews are capped, and result
  retention now actually deletes evidence after its retention window.
- Keep Fusion's local journal and cancellation fences. Published native
  operations do not replace them.
- Do not replace the panel script with builtin `parallel` yet: its restricted
  task fields do not preserve all per-child budgets, deadlines, stable slot keys,
  agreement rounds and concurrency behavior.
- A direct async judge is a plausible smaller change, with retained
  `rpc-spawn-<requestId>` correlation. Verify output, cancellation and timeout
  equivalence first; that alias is correlation, not idempotency.
- Reduce the large orchestrator only along real seams: native transport,
  reconciliation/persistence and UI projection. Preserve tested invariants;
  avoid a general workflow framework.

### P2 security boundary to retain

Bundled read-only agents declare only read tools, and project config honors
`ctx.isProjectTrusted()`. That does not sandbox arbitrary configured agents,
their extensions or restored project snapshots.

Keep `fusion-panelist-full` opt-in. Prefer rejecting concurrent mutation-capable
panels or isolating each writer before expanding its use; a prompt warning does
not prevent shared-worktree writes. Do not broaden default tools to solve a
missing-web-provider error. Audit restoration of project-owned state separately;
this review does not establish a trust exploit.

## Version policy and forward compatibility

A flexible manifest and a reproducible lockfile solve different problems.

| Package | Policy | Next breaking boundary |
| --- | --- | --- |
| Pi | `^1.5`; support public API and test new resolved releases | 2.0 by semver, but 1.2/1.5 already document behavioral breaks worth reviewing |
| pi-subagents | `^0.84`; independently installed runtime checked through RPC | 0.85: pre-1.0 minor releases may break contracts |
| TypeBox | `^1.3`; host-provided, JSON Schema subset | 2.0 |
| Biome / Vitest | `^2.6` / `^5.1`, lockfile for CI | 3.0 / 6.0; nursery rules can change earlier |
| Node types | Current Node 24 line | Do not accidentally approve newer-runtime APIs |
| Webfox | Optional documented integration, not bundled SDK | Review next major configuration/tool contract before recommending migration |

`^0.84` intentionally allows patches, not every remaining 0.x minor.
A range like `>=0.84 <1` would admit the next breaking version before evidence
exists. Pi 2 and pi-subagents 0.85 are not claimed compatible. Forward readiness
means protocol/capability negotiation, tolerant optional metadata parsing and
real contract tests—not an unbounded version string.

Recommend CI lanes for the lockfile baseline, latest allowed dependencies, and
a non-blocking next-version probe when one actually exists. Widen ranges after
the probe's lifecycle tests pass. No new CI workflow was added in this branch.
Do not downgrade packages while runs are active/quarantined; rollback code,
manifest, lockfile and corresponding runtime installation together after safe
termination and state preservation.

## Verification and gaps

Observed on this machine:

- Baseline Pi 1.0.4 / pi-subagents 0.76.1: all 482 tests and package/check gate passed.
- Updated Pi 1.5.0 / pi-subagents 0.84.0: all 482 tests passed, including real
  extensions in an isolated process using a localhost fake model.
- Expanded real-owner test passed for long-output preservation and strict-mode
  rejection without spawn. It also runs select, merge, single, rolling refill
  after authentication failure, operation replay, stop rejections and host exit.
- Audit changed from seven affected package records (five moderate, two high)
  to zero known vulnerabilities in the installed development tree.
  This excludes independently installed optional extensions.
- Final `npm run test:all` was **not clean**: seven tests failed, including
  process/pack timeouts and the real-owner merge failure quoted above.
- A two-worker rerun passed 481/482, with a five-second candidate-repository
  test timeout. A one-worker rerun also passed 481/482, but timed out the
  20-second delayed-panel-lookup process test and reported its cleanup rejection.
  Process-test failures moved between runs. Host load averages exceeded 50
  during verification; this supports resource contention as a hypothesis,
  not proof. Timeout limits were not increased and tests were not disabled.
- Lint/types and package dry-run passed. Documentation link checks passed
  (15 local links, zero broken). Prose lint was advisory. No diagrams changed.
  The external Mermaid helper falsely tried to render nonexistent diagrams
  because its zero-diagram `seq 1 0` loop is not portable to this macOS shell.
- Runtime used for checks was Node 24.15.0, not the minimum supported Node 22.
  The branch is an upgrade/review candidate, not a release sign-off.

Remaining release gates: actual crash/reload auto-resume and ID adoption,
queued/paused cancellation with live work, native idle/busy/abort wake behavior,
minimum supported Node runtime, Webfox child loading/live providers, rendered
TUI layout/accessibility and future dependency versions. Mock strict-lifetime
tests are not positive compatibility evidence for the real runtime.

## Sources

Published tarballs were inspected, not just repository HEAD:

- [Pi 1.5 package](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.5.0)
  and [release history](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/CHANGELOG.md).
- [Pi extension API](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/extensions.md),
  [TUI guide](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/tui.md)
  and [package changelogs](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/packages.md).
- [pi-subagents 0.84 package](https://www.npmjs.com/package/pi-subagents/v/0.84.0),
  [changelog](https://github.com/nicobailon/pi-subagents/blob/v0.84.0/CHANGELOG.md),
  [integration API](https://github.com/nicobailon/pi-subagents/blob/v0.84.0/docs/extension-api.md),
  [auto-resume configuration](https://github.com/nicobailon/pi-subagents/blob/v0.84.0/docs/configuration.md#autoresume)
  and [workflow sandbox advisory](https://github.com/nicobailon/pi-subagents/security/advisories/GHSA-6v8j-6w28-2w8r).
- [Webfox 4.0 migration](https://github.com/mavam/webfox/releases/tag/v4.0.0),
  [4.6 structured tools](https://github.com/mavam/webfox/releases/tag/v4.6.0),
  [4.7 discovery](https://github.com/mavam/webfox/releases/tag/v4.7.0),
  [4.9 security/cancellation](https://github.com/mavam/webfox/releases/tag/v4.9.0),
  [4.10 release](https://github.com/mavam/webfox/releases/tag/v4.10.0)
  and [published package](https://www.npmjs.com/package/webfox/v/4.10.0).
- [Vitest 5.1 release](https://github.com/vitest-dev/vitest/releases/tag/v5.1.0)
  and [Biome 2.6.4 release](https://github.com/biomejs/biome/releases/tag/%40biomejs%2Fbiome%402.6.4).
