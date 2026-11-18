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

The lockfile tests Pi 1.5.2, pi-subagents 0.89.0, and TypeBox 1.4.7. Pi, TUI,
and TypeBox are peers. pi-subagents and the optional Webfox extension are
development dependencies for the test harness, not Fusion runtime dependencies.
Fusion uses pi-subagents through public event-bus RPC only.

The pre-1.0 pi-subagents range `^0.89.0` stops before 0.90. Test the public
contract with a real Pi process before widening that range or admitting Pi 2.x.
Keep Node types on the latest Node 24 release; the runtime minimum remains
Node 22.19. The declared npm 12 version requires at least Node 22.22.2 or 24.15.0;
use the Node-bundled npm for the minimum-runtime test.

The SDK smoke test disables model network refresh. The upstream E2E test loads
both real extensions in a separate Pi process, with an isolated home and agent
directory and a localhost fake model provider. It checks the public RPC validator,
select/merge/single-member runs, rolling refill after authentication failure,
native stop rejection codes, operation replay, full outputs beyond the native
2,000-character preview, rejection of unsupported strict lifetime requests before
native spawn, configured Webfox tool calls inside native children, explicit
missing-tool failures, metadata-only Fusion tracing, and clean host shutdown.
It does not read personal credentials or call a paid model. Native completion
wakes are observed as an upstream limitation, not mistaken for Fusion wakes.

- Uses `pi-subagents` over its event-bus RPC channel.
- New runs use one async parallel panel run followed by a standalone judge run; restored legacy chain runs remain supported.
- Completion recovery keeps matching event evidence across native result consumption and reads narrow retained workflow values. Explicit running workflow state outranks a temporarily settled rolling child roster.
- Ordinary cancellation persists intent and exact delivery, then waits for native tracked-run retirement proof. It is not a kernel containment guarantee.
- Native `owner-exited` and `runtime-replaced` preserve admission in quarantine; Fusion never adopts or replays successor runs automatically.
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

Biome is the only linter and formatter. `npm run lint` runs its lint rules.
`npm run check` also checks formatting, import organization, and TypeScript
types. The shared Biome config adds checks for dropped promises and rejections,
unsafe returns from typed functions, mismatched map keys, and unresolved
imports. It includes source, tests, scripts, and root TypeScript files.
Only selected nursery rules are enabled because their diagnostics can change
between Biome releases. These checks complement TypeScript and do not cover
all of the former type-aware ESLint rules.

`npm test` runs the whole Vitest suite. Use `test:unit`, `test:integration`,
or `test:e2e` for focused runs. `npm run test:all` also checks the package
contents.

Git hygiene:

- `pre-commit`: whitespace/conflict check, staged Biome check, staged gitleaks scan
- `pre-push`: full `npm run test:all`

### Real Pi TUI validation

Run `node scripts/validate-pi.ts` in a dedicated agterm session. It launches the
real installed Pi and pi-subagents with candidate Fusion code and a localhost
model fixture. It uses isolated HOME/agent/session/config directories, no
personal credentials, and no paid provider. The printed fixture root retains
evidence. To reopen it, pass that root as the first argument; the second optional
argument is `regular` or `fullscreen` (default). Do not reopen while its old host
is alive.

Exercise `/fusion doctor`, command/profile completion, select/merge/partial,
configured expand key, narrow/wide resize, `SLOW_FIXTURE` plus stop, and reload
while work is active. `ui-events.jsonl` records native hook types without prompt
or credential content. A reload/crash should hold admission, not replay work.
Keep the quarantine record; do not delete snapshots to make the check pass.

Test discovery is limited to `test/unit`, `test/integration`, and `test/e2e`.
Global setup only isolates the native agent configuration. The execution-contract
suite compiles its process workers and creates Git templates once in a private
temporary directory, then removes it after the suite. Unit tests do not build
those fixtures. Worker teardown owns close/exit, and workers do not inherit Pi
loader aliases or personal state.
Git repository setup runs in setup hooks, outside behavioral test time limits.
Git-context integration cases have a 20-second harness budget because each real
Git verification already has a 10-second operation cap; unit tests keep their
five-second default. This does not change Fusion's execution deadlines.
Two Vitest workers limit overlapping native-host imports and filesystem work;
no behavior assertions or runtime deadlines are disabled. CI checks locked Node
22.19/24 plus latest-allowed dependencies on Node 24. A future breaking version
needs a separate contract review; it is not silently admitted.

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
