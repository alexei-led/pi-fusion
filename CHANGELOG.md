# Changelog

## Unreleased

### Changed

- Panel answers are now presented to the judge in a shuffled order seeded from
  the run id, instead of a fixed configuration order. LLM judges favour the
  first or last candidate they see, so a fixed order advantaged the same panel
  member on every run. The seed keeps a persisted run rendering identically when
  it is replayed. The panel status and failure lists stay in configuration order.
- Bundled panelist and judge agents now declare the `pi-web-providers` tools
  `web_search`, `web_contents`, and `web_answer` in addition to the read-only
  local tools. Panels can gather external evidence, so prompts and inspected
  snippets may now reach the configured web provider.

### Added

- `fusion-panelist-lite` agent: local-only panelist with no web access.
- `fusion-panelist-full` agent: opt-in panelist with `bash`, `edit`, `write`, and
  `web_research`. It voids the read-only guarantee and is unsafe at
  `concurrency > 1`; the default panel remains read-only.
- Panel member and judge `agent` values are now validated for shape at config
  load, rejecting embedded whitespace, empty segments, and stray dots.

## 0.5.1 - 2026-07-12

- Add the versioned `fusion:rpc:v1` event-bus API for plan execution.
- Persist operation IDs and replay the original run across extension restarts and later session runs.
- Add structured start, status, result, cancel, and adopt responses with typed errors.
- Add unit and integration coverage for RPC lifecycle, durable idempotency, history lookup, cancellation, and validation.
