# Judge override release

Status: completed. Released as `0.11.0` at tag [`v0.11.0`](https://github.com/alexei-led/pi-fusion/releases/tag/v0.11.0) via PR #16 (two review rounds; final round clean). Approved scope: ship `/fusion --judge` as the next minor release.

## Acceptance checklist

- [x] `--judge <agent>[:<model>[:<level>]]` parses in both `--judge x` and `--judge=x` forms; malformed, empty, over-long and repeated specs fail at parse time.
- [x] The override is per field: whatever the spec omits keeps the profile's value, whether that level sits in the profile's `thinking` field or on the end of its `model` id.
- [x] A tail segment that names a level is read as one; any other tail stays part of the model id, so variants such as `qwen3.6:35b-a3b-coding-nvfp4` survive.
- [x] A thinking-only override needs a model to carry the level and fails at start rather than silently running at the profile's level.
- [x] The composed judge is recorded in the existing run snapshot and survives restore.
- [x] Composition runs before the Claude alias pass, so alias shorthand resolves for an overridden judge model.
- [x] `--judge` composes with `--profile` and `--panel`; the status key and bundled-agent read-only posture are untouched.
- [x] Docs, changelog, version and package inspection complete.
- [x] Independent review, fixes, final checks, separate PR and CI. Comprehensive round found 1 major (a model-only override dropped a level embedded in the profile model) and 1 minor (user-guide prose contradicted its own table); both fixed with regression tests. Final round clean.
- [x] CI green on the PR and on `master`; tag `v0.11.0` and publish. Published `@alexeiled/pi-fusion@0.11.0` with SLSA provenance; registry `dist-tags.latest` advanced and the shasum matches the workflow's publish log.

## Constraints

CLI only; the RPC start path deliberately accepts neither `panel` nor `judgeOverride`. No thinking-level alias vocabulary beyond the seven canonical names. No support for the `@tintinweb/pi-subagents` fork. Public `pi-subagents` RPC only, no imports of its internals. Bundled agents remain read-only. Only the `fusion` status key is published.

## Validation

Focused red/green regression for the embedded-level defect. Unit coverage for every spec shape (agent-only, model-only, thinking-only, full override) against a profile whose level is embedded, plus the failure path when a thinking-only override has no model. Integration coverage asserting the judge spawn payload and the restored snapshot. Full `npm run test:all` at the release gate.

## Release gate

`npm run test:all`, `npm version 0.11.0`, tag `v0.11.0` on `master`. Rollback is `npm dist-tag` plus reverting the release commit; the feature commit reverts cleanly on its own. Local test deployment only; npm publish and merge authorized for this release.
