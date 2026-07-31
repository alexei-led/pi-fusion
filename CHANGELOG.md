# Changelog

## Unreleased

### Changed

- Panel answers are now presented to the judge in a shuffled order seeded from
  the run id, instead of a fixed configuration order. LLM judges favour the
  first or last candidate they see, so a fixed order advantaged the same panel
  member on every run. The seed keeps a persisted run rendering identically when
  it is replayed. The panel status and failure lists stay in configuration order.
- Panels can now gather web evidence by opting a member in to the new
  `fusion-panelist-web` agent. Default agents deliberately stay on Pi core tools:
  tool names are a strict allowlist rather than a loader, so declaring a tool
  from the optional `pi-web-providers` extension would fail every task for users
  who do not have it installed.

### Added

- `fusion-panelist-web` agent: panelist with `web_search`, `web_contents`, and
  `web_answer`. Requires `pi-web-providers`.
- `fusion-panelist-full` agent: opt-in panelist with `bash`, `edit`, `write`, and
  `web_research`. It voids the read-only guarantee, requires `pi-web-providers`,
  and is unsafe at `concurrency > 1`; the default panel remains read-only.
- Panel member and judge `agent` values are now validated for shape at config
  load, rejecting embedded whitespace, empty segments, and stray dots.
- `/fusion --panel <entries> <prompt>` builds a one-off panel without editing
  config. Entries are `<model>` or `<agent>:<model>`; the resolved profile still
  supplies the judge and every other setting.
- Profile `synthesis: "merge"` plus a per-member `question` field: panelists
  answer different facets of one task and the new `fusion-composer` agent merges
  them, reporting a coverage map, combined answer, gaps, and seam conflicts.
  Reuses the judge run slot, so `fusion:rpc:v1` is unchanged.
- Profile `blindPanelLabels`: presents panel answers to the judge as
  `Candidate A/B/C` and withholds agents and artifact paths, so role labels stop
  acting as authority cues. Reports still show real names.
- Profile `judgeToolBudget`: caps tool calls the judge spends verifying claims.
- The judge now gets an explicit instruction to settle conflicting factual
  claims by inspecting the code and citing `file:line`, and reports them in a new
  `Contested Claims` section.

## 0.5.1 - 2026-07-12

- Add the versioned `fusion:rpc:v1` event-bus API for plan execution.
- Persist operation IDs and replay the original run across extension restarts and later session runs.
- Add structured start, status, result, cancel, and adopt responses with typed errors.
- Add unit and integration coverage for RPC lifecycle, durable idempotency, history lookup, cancellation, and validation.
