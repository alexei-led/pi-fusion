# Runtime resilience release

Status: implemented in `feat/runtime-resilience-release`; pending merge and release.

Approved scope: next stable Fusion release, one worktree and PR; merge and public release require separate approval.

## Acceptance checklist

- [x] Frozen-install baseline; record dependency/capability versions and existing failures.
- [x] Canonical `max` works in config, inline panel, spawn and snapshots; no mutable thinking registry.
- [x] Typed workflow failure categories survive persistence/status/report; tools expose structured results and real errors.
- [x] Timeouts are bounded by the Node timer ceiling at new start boundaries; legacy snapshots with oversized values still restore.
- [x] Advertised lifecycle hints coalesce into correlated, authoritative reconciliation; fallback polling and shutdown cleanup remain.
- [x] Opt-in terminal wake targets interactive owners only; only the terminal-commit winner publishes; restored controllers are never woken.
- [x] Remove dead agent frontmatter; keep one state transition path and strict execution capability checks.
- [x] Docs/changelog/version and package inspection complete.
- [x] Isolated agterm live smoke: panel/judge, max, partial failure, timeout/cancel, reload limits, terminal wake; no leaked processes. Reload stop left Fusion active and was fixed as task #16.
- [ ] Independent review, fixes, final checks, separate PR and CI. Comprehensive round found 1 major + 7 minor; all fixed and under final re-review.

## Constraints

Use public pi-subagents RPC only. Bundled agents remain read-only. Do not own the Pi footer. Preserve old snapshots/RPC compatibility. Do not add automatic provider retry, second backend/scheduler, arbitrary thinking registry or experimental routing/codemode.

## Validation

Focused red/green regressions per behavior; full `npm run test:all` at baseline and release gate. Test duplicate/out-of-order hints, missing events, failures, limits, restore and shutdown. Live sessions use a packed artifact and isolated settings, short read-only prompts, bounded cost/runtime. No speed claim without comparison. Unreleased upstream guarantees are not assumed.

## Release gate

Update this checklist and record commands/results, live evidence and residual limits before PR. Local test deployment only; npm publish and merge require separate approval.
