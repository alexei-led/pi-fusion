# Changelog

## 0.5.1 - 2026-07-12

- Add the versioned `fusion:rpc:v1` event-bus API for plan execution.
- Persist operation IDs and replay the original run across extension restarts and later session runs.
- Add structured start, status, result, cancel, and adopt responses with typed errors.
- Add unit and integration coverage for RPC lifecycle, durable idempotency, history lookup, cancellation, and validation.
