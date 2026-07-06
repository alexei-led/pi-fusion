# pi-fusion

[![npm](https://img.shields.io/badge/npm-%40alexeiled%2Fpi--fusion-cb3837?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@alexeiled/pi-fusion)
[![node](https://img.shields.io/badge/node-%3E%3D22.19.0-5fa04e?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

When a coding question deserves a design review, not a guess.

`pi-fusion` is a Pi extension that runs a small panel of read-only subagents in parallel, then asks a judge agent to synthesize one final report.

You get:

- consensus
- disagreements
- blind spots
- risks
- recommended next step

It applies the [Fusion](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) idea to Pi: spend extra tokens only on questions where multiple perspectives are worth it.

## Good fit

Use it for questions like:

- Which design should we choose?
- What will break if I change this?
- Is this PR or release flow safe?
- What did I miss?
- What is the right test strategy here?

Do not use it for trivial edits, formatting, or obvious one-step fixes.

## How it works

```text
/fusion Should this extension use node:test or Vitest?

1. Panelists inspect the problem independently.
2. The judge compares their answers.
3. Pi shows one final Markdown report.
```

Default roles:

- **Architect** — tradeoffs and failure modes
- **Implementer** — contracts, edge cases, practical fit
- **Tester** — regressions and verification
- **Judge** — synthesis and recommendation

Bundled agents are read-only by default. They can inspect files, but they do not edit code, commit changes, or run nested subagents.

## Quick start

Requirements:

- Pi
- Node.js 22.19+
- `pi-subagents`

```bash
pi install npm:pi-subagents
pi install npm:@alexeiled/pi-fusion
```

Then reload Pi:

```text
/reload
```

## Commands

```text
/fusion
/fusion <prompt>
/fusion --profile <name> <prompt>
/fusion status
/fusion stop
/fusion init
```

## Notes

- Bare `/fusion` shows a short command summary.
- Config is optional. Defaults work. Use `/fusion init` when you want project config.
- Project config lives at `.pi/fusion.json`. Global config lives at `~/.pi/agent/fusion.json`.
- Output appears as a Pi custom message. Active progress also uses the `fusion` status key.
- `pi-fusion` does not own the footer.
- Prompts and inspected snippets may be sent to your configured model providers through `pi-subagents`.

## Read more

- [`docs/user-guide.md`](./docs/user-guide.md) — commands, config, profiles, privacy, troubleshooting
- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — contributor workflow
