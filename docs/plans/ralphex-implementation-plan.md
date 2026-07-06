# Plan: Subagent-native pi-fusion extension

## Overview

Build a replacement `pi-fusion` Pi extension that uses `pi-subagents` as the execution engine. The current `synthetic-recon/pi-fusion` extension will be uninstalled, so no backward compatibility with its direct model-call engine or footer ownership is required.

The extension must be small, typed, testable, and Pi-native:

- explicit `/fusion` command only for v1
- named profiles/panels from config
- reasoning effort support through subagent model/thinking settings
- panel and judge execution through `pi-subagents` RPC
- progress through `ctx.ui.setStatus("fusion", ...)` and optional `ctx.ui.setWidget(...)`
- no `ctx.ui.setFooter(...)`
- clear final Markdown report
- minimal README and MIT license

## References

- Pi extensions API: TypeScript extension factory, `registerCommand`, `registerTool`, `setStatus`, `setWidget`, `appendEntry`.
- pi-subagents: async runs, parallel runs, lifecycle artifacts, status/result RPC, `spawn`, `status`, `stop`/`interrupt`.
- pi-powerline-footer: custom powerline items read extension status keys via `ctx.ui.setStatus`.
- TypeBox: schemas for command/tool parameters where needed.

## Validation Commands

- `npm run check`
- `npm test`
- `npm run pack:dry`
- Manual smoke: `pi install /path/to/pi-fusion`, `/reload`, `/fusion-init`, `/fusion-status`, `/fusion <prompt>`

## Required package shape

```text
pi-fusion/
  package.json
  package-lock.json
  tsconfig.json
  README.md
  LICENSE
  AGENTS.md
  agents/
    fusion-panelist.md
    fusion-judge.md
  src/
    index.ts
    commands.ts
    config.ts
    errors.ts
    orchestrator.ts
    report.ts
    result-extract.ts
    run-builder.ts
    run-store.ts
    status.ts
    subagents-rpc.ts
    types.ts
    utils.ts
    __tests__/
      args.test.ts
      config.test.ts
      report.test.ts
      result-extract.test.ts
      run-builder.test.ts
      status.test.ts
      subagents-rpc.test.ts
```

## Core config shape

```json
{
  "defaultProfile": "quality",
  "profiles": {
    "quality": {
      "panel": [
        {
          "id": "architect",
          "label": "Architect",
          "agent": "pi-fusion.fusion-panelist",
          "model": "openai/gpt-5.5",
          "thinking": "high",
          "role": "architecture and tradeoffs"
        }
      ],
      "judge": {
        "agent": "pi-fusion.fusion-judge",
        "model": "openai/gpt-5.5",
        "thinking": "xhigh"
      },
      "concurrency": 3,
      "timeoutMs": 300000,
      "context": "fresh"
    }
  }
}
```

## Success criteria

The implementation is done when `/fusion <prompt>` starts a subagent-backed panel run, tracks it, runs the judge when enough panelists succeed, renders a final report, and publishes only the `fusion` status key for footer integration. Unit checks, package dry-run, and a live Pi smoke test must pass or be documented with exact failure output.

### Task 1: Scaffold package, TypeScript config, license, and bundled agents

- [x] Create `package.json` for scoped package `@alexei/pi-fusion` with `pi.extensions` pointing at `./src/index.ts` and `pi.subagents.agents` pointing at `./agents`.
- [x] Add scripts: `check` as `tsc --noEmit`, `test` as `node --import jiti/register --test src/__tests__/*.test.ts`, and `pack:dry` as `npm pack --dry-run`.
- [x] Create strict `tsconfig.json` with `NodeNext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noImplicitOverride`, `noImplicitReturns`, and `noFallthroughCasesInSwitch`.
- [x] Add standard MIT `LICENSE` with 2026 Alexei Ledenev copyright.
- [x] Add minimal `AGENTS.md` for contributors: keep code small, do not own the footer, use `pi-subagents` RPC, keep panel agents read-only by default.
- [x] Create `agents/fusion-panelist.md` as a read-only agent with `tools: read, grep, find, ls`, `package: pi-fusion`, `name: fusion-panelist`, no subagent tool, and concise output sections.
- [x] Create `agents/fusion-judge.md` as a judge agent with no mutation tools, `package: pi-fusion`, `name: fusion-judge`, and final report sections.
- [x] Create empty source modules and test directory matching the required package shape.
- [x] Run `npm install` and `npm run check` after scaffolding.

Implementation notes:

- Do not add runtime dependencies unless necessary.
- Keep `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` as peer dependencies.
- Keep the README short for now; Task 6 finishes docs.

### Task 2: Implement domain types, config loader, and `/fusion` argument parsing

- [x] Define domain types in `src/types.ts`: `ThinkingLevel`, `PanelMemberConfig`, `JudgeConfig`, `FusionProfile`, `FusionConfig`, `FusionPhase`, and `FusionRun`.
- [x] Implement `src/config.ts` to load project `.pi/fusion.json` only when `ctx.isProjectTrusted()` is true, then fall back to `~/.pi/agent/fusion.json`, then defaults.
- [x] Validate untrusted JSON with narrow type guards. Do not cast raw parsed JSON directly to domain types.
- [x] Default to a `quality` profile with three read-only panel members and one judge.
- [x] Implement `resolveProfile(config, requested)` with clear errors for unknown profile names and empty panels.
- [x] Implement `parseFusionArgs(args)` in `src/commands.ts` or a focused helper. Support `/fusion <prompt>`, `/fusion --profile fast <prompt>`, and `/fusion -p fast <prompt>`.
- [x] Implement `/fusion-init` to write a project-local `.pi/fusion.json` template only for trusted projects and only after confirming overwrite.
- [x] Add tests for config defaults, project/global precedence, malformed JSON, unknown profiles, empty panels, and argument parsing.
- [x] Run `npm run check` and `npm test`.

Implementation notes:

- Use guard clauses and small helpers.
- Keep config parsing close to file I/O.
- No automatic mode or model-decides tool in v1.

### Task 3: Implement pi-subagents RPC client and run-store

- [x] Implement `src/subagents-rpc.ts` with a narrow `SubagentsRpcClient` around `pi.events`.
- [x] Use channels `subagents:rpc:v1:request` and `subagents:rpc:v1:reply:<requestId>`.
- [x] Support methods `ping`, `spawn`, `status`, `stop`, and `interrupt` through one typed `request` helper.
- [x] Add request timeout handling and listener cleanup for success, failure, wrong request IDs, and timeout.
- [x] Implement `src/run-store.ts` as a small in-memory store that allows one active run at a time and remembers the last run summary.
- [x] Persist compact run summaries with `pi.appendEntry("fusion-run", ...)` and restore them on `session_start`.
- [x] Add tests with a fake event bus for RPC success, failure, timeout, wrong request ID, and cleanup.
- [x] Add tests for active-run guard, run updates, done/failed/cancelled transitions, and session summary restore helpers.
- [x] Run `npm run check` and `npm test`.

Implementation notes:

- Do not import pi-subagents internal modules.
- Treat RPC payloads as `unknown` at the boundary.
- Do not scrape terminal output.

### Task 4: Build panel/judge spawn params and result extraction

- [x] Implement `src/run-builder.ts` to convert a `FusionProfile` and prompt into `pi-subagents` async parallel panel spawn params.
- [x] Append thinking as a model suffix only when a model exists and the suffix is not already present, e.g. `openai/gpt-5.5:xhigh`.
- [x] Include panel role, prompt, output contract, and no-edit instruction in every panelist task.
- [x] Build judge spawn params from successful panel outputs. The judge prompt must include original task, panel status, successful outputs, and failed panelists.
- [x] Implement `src/result-extract.ts` to normalize `pi-subagents` status/result data into successful panel outputs and failed panel summaries.
- [x] Return typed error variants when result shape is missing or unknown instead of throwing from deep helpers.
- [x] Add tests for spawn param shape, thinking suffix handling, task text, judge prompt, successful output extraction, failed output extraction, missing fields, and artifact-path fallback.
- [x] Run `npm run check` and `npm test`.

Implementation notes:

- Keep prompt-building pure and deterministic for tests.
- Do not enable mutating panel tools.
- Do not allow nested subagent fanout.

### Task 5: Implement commands, orchestrator, status, cancellation, and event handling

- [ ] Implement `src/orchestrator.ts` with `startRun`, `handleSubagentComplete`, `refreshStatus`, `cancelActiveRun`, `restore`, and `clearUi`.
- [ ] On `/fusion <prompt>`, ping `pi-subagents`, resolve profile, create active run, publish status, spawn panel, and store the returned panel run ID.
- [ ] On panel completion, refresh status through RPC and extract panel results.
- [ ] If zero panelists succeed, fail the run with a clear report.
- [ ] If one panelist succeeds, skip judge and render a single-panel report.
- [ ] If two or more panelists succeed, spawn the judge subagent and store the judge run ID.
- [ ] On judge completion, extract judge output and render the final report.
- [ ] Implement `/fusion-status` to show active or last run, profile, phase, run IDs, progress counts, and install/config warnings.
- [ ] Implement `/fusion-cancel` to call `stop` on the active panel or judge run; fall back to `interrupt` if `stop` fails.
- [ ] Implement `src/status.ts` to publish `ctx.ui.setStatus("fusion", text)` for active phases and clear it on shutdown or idle.
- [ ] Implement optional compact widget with `ctx.ui.setWidget("fusion-panel", lines)` while active.
- [ ] Add tests using fake RPC and fake UI for start, active-run conflict, status text, panel failure, one-success shortcut, judge spawn, judge completion, cancellation, and clearing UI.
- [ ] Run `npm run check` and `npm test`.

Implementation notes:

- Never call `ctx.ui.setFooter`.
- Keep user-visible messages concise.
- Use exact run IDs in status output so users can inspect subagent runs if needed.

### Task 6: Implement report rendering and focused docs

- [ ] Implement `src/report.ts` to render deterministic Markdown reports for success, partial success, single-panel result, judge failure, all-panel failure, and cancellation.
- [ ] Include report sections: Summary, Agent Status, Consensus, Disagreements, Unique Insights, Blind Spots, Recommendation, Risks, Next Step, and Run Metadata when available.
- [ ] Ensure failed/timed-out panelists appear in Agent Status.
- [ ] Add report tests with stable snapshots or exact string assertions.
- [ ] Write minimal `README.md` with install, required `pi-subagents`, optional `pi-powerline-footer` config, usage commands, config example, privacy note, and development commands.
- [ ] Document that prompts and inspected file contents can be sent to configured model providers.
- [ ] Document that panel agents are read-only by default and the extension never owns the footer.
- [ ] Run `npm run check` and `npm test`.

Implementation notes:

- Keep README focused. Do not include broad architecture history.
- Do not duplicate full Pi or subagents docs; link or reference required extensions.

### Task 7: Package verification and live Pi smoke test

- [ ] Run `npm run check` and fix all diagnostics without weakening strictness.
- [ ] Run `npm test` and fix failures without deleting meaningful assertions.
- [ ] Run `npm run pack:dry` and verify the package includes only intended files.
- [ ] Install locally with `pi install /path/to/pi-fusion`.
- [ ] Confirm `pi-subagents` is installed; if not, install it with `pi install npm:pi-subagents`.
- [ ] If testing footer integration, configure `pi-powerline-footer` custom item for status key `fusion`.
- [ ] Start Pi, run `/reload`, then `/fusion-init`.
- [ ] Run `/fusion-status` and verify profile/config output.
- [ ] Run `/fusion Compare two implementation approaches for this extension.` and verify a panel run starts through subagents.
- [ ] Verify footer/status shows only one fusion item and no duplicated footer block.
- [ ] Verify final report is shown and partial failures are visible if any panelist fails.
- [ ] Run `/fusion-cancel` during an active run and verify the active run moves to cancelled.
- [ ] Record exact commands, pass/fail results, and unresolved risks in the final response.

Implementation notes:

- Do not run destructive git commands.
- Do not move this plan file manually; let Ralphex handle plan lifecycle after completion.
