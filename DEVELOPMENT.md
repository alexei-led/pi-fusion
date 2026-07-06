# Development Guide

## Local install

```bash
npm install
git config --local core.hooksPath scripts/git-hooks
npm run test:all
pi install /path/to/pi-fusion
```

Then reload Pi:

```text
/reload
```

## Runtime behavior

- Uses `pi-subagents` over its event-bus RPC channel.
- Publishes only the `fusion` status key.
- Bundled panel agents are read-only by default.
- Does not replace the Pi footer.

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

`npm test` runs the unit tier. `npm run test:all` runs the full local gate that CI and release use.

Git hygiene:

- `pre-commit`: whitespace/conflict check, staged ESLint, staged gitleaks scan
- `pre-push`: full `npm run test:all`

## Release

Target package:

```text
@alexeiled/pi-fusion
```

Release flow:

```bash
npm run test:all
npm version patch
git push origin master --follow-tags
```

The release workflow runs on pushed `v*` tags only. The tag must match `package.json` version and point to a commit on `master`.

npm publish uses Trusted Publishing. Configure npm for repository `alexei-led/pi-fusion` and workflow `.github/workflows/release.yml` before the first release.
