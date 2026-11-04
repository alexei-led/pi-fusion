# Development Guide

## Local install

```bash
npm install
git config --local core.hooksPath scripts/git-hooks
npm run test:all
pi install /path/to/pi-fusion
```

Restart Pi after updating upstream packages. For a Fusion-only code reload:

```text
/reload
```

## Runtime behavior

Development ranges are Pi `^1.5` and pi-subagents `^0.84`; the lockfile records
the exact tested dependency tree. The Pi peer range is `^1.5`. Neither upstream
package is imported through private runtime modules. Fusion communicates with
pi-subagents only through event-bus RPC. Pi supplies TypeBox; Fusion does not
import TUI components, so it no longer declares an unused TUI peer.

For pre-1.0 pi-subagents, `^0.84` stops before the next minor, `0.85`.
Test a new minor before widening that range. Pi 2.x is likewise not claimed.
Keep `@types/node` on the Node 24 line rather than admitting Node 26-only APIs;
the runtime minimum remains Node 22.19. See the
[dependency review](./docs/reviews/dependency-compatibility.md) for evidence,
recommendations, and lifecycle coverage gaps.

The SDK smoke test disables model network refresh. The upstream E2E test loads
both real extensions in a separate Pi process, with an isolated home and agent
directory and a localhost fake model provider. It checks the public RPC validator,
select/merge/single-member runs, rolling refill after authentication failure,
native stop rejection codes, operation replay, full outputs beyond the native
2,000-character preview, rejection of unsupported strict lifetime requests before
native spawn, and clean host shutdown.
It does not read personal credentials or call a paid model. Native completion
wakes are observed as an upstream limitation, not mistaken for Fusion wakes.

- Uses `pi-subagents` over its event-bus RPC channel.
- New runs use one async parallel panel run followed by a standalone judge run; restored legacy chain runs remain supported.
- Completion recovery reads `pi-subagents` lifecycle artifacts. A matching completion event treats its result payload as terminal; status polling alone requires a terminal lifecycle state.
- Publishes only the `fusion` status key.
- Bundled panel agents are read-only by default.
- Does not replace the Pi footer.
- Panel and judge lifecycle details are optional provider metadata; missing usage must not fail a run. Reported model names are observed lifecycle values when available, otherwise clearly marked as configured.

## User-facing behavior

Commands, configuration, status, footer behavior, and privacy notes live in [`docs/user-guide.md`](./docs/user-guide.md).

Keep `DEVELOPMENT.md` focused on contributor workflow. Do not duplicate user docs here.

## Validation

```bash
npm run lint
npm run check
npm run test:unit
npm run test:integration
npm run test:e2e
npm run pack:dry
npm run publish:dry
```

`npm run check` runs Biome and the TypeScript compiler. Biome does not
replace the previous type-checked ESLint rule set (`no-unsafe-*`,
`restrict-template-expressions`, `unbound-method`, and similar).
Those rules remain dropped, and `tsc` does not replace them. Keep
those patterns out by review until a type-aware linter returns. `npm test`
runs the whole Vitest suite; the tiered `test:unit`, `test:integration` and `test:e2e`
scripts remain available for focused runs. `npm run test:all` runs the full
local gate that CI and release use.

Git hygiene:

- `pre-commit`: whitespace/conflict check, staged Biome check, staged gitleaks scan
- `pre-push`: full `npm run test:all`

## Release

Target package:

```text
@alexeiled/pi-fusion
```

Commit the reviewed implementation and matching changelog section before tagging.
Choose the version increment explicitly; this example cuts a minor release:

```bash
npm run test:all
npm version minor -m "release: v%s"
git push origin master --follow-tags
```

The release workflow runs on pushed `v*` tags only. The tag must match `package.json` version and point to a commit on `master`. It reads that version's committed `CHANGELOG.md` section, publishes npm with provenance, and creates the GitHub release with the tag as its title and the same notes. Missing or empty notes fail before publication. Existing package versions and GitHub releases are not overwritten.

npm publish uses Trusted Publishing. Configure npm for repository `alexei-led/pi-fusion` and workflow `.github/workflows/release.yml` before the first release.
