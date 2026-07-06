# pi-fusion

[![npm](https://img.shields.io/badge/npm-%40alexeiled%2Fpi--fusion-cb3837?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@alexeiled/pi-fusion)
[![node](https://img.shields.io/badge/node-%3E%3D22.19.0-5fa04e?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

Subagent-native multi-model deliberation for Pi.

`pi-fusion` adds `/fusion` for read-only panel deliberation through `pi-subagents`, then synthesizes the result into one Markdown report. It publishes only the `fusion` status key. It does not own the Pi footer.

## Install

Requirements:

- Pi with Node.js 22.19 or newer
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
/fusion <prompt>
/fusion --profile <name> <prompt>
/fusion-status
/fusion-cancel
/fusion-init
```

- `/fusion` starts the configured panel.
- `/fusion-status` shows the active or last run.
- `/fusion-cancel` stops the active panel or judge run.
- `/fusion-init` writes a project-local `.pi/fusion.json` template.

## Config

- Project: `.pi/fusion.json`
- Global: `~/.pi/agent/fusion.json`

Run `/fusion-init` to create a project config template.

## Notes

- Bundled panel agents are read-only by default.
- Footer integration should read the `fusion` status key from another extension.
- Prompts and inspected file snippets may be sent to your configured model providers through `pi-subagents`.

## Development

See [`DEVELOPMENT.md`](./DEVELOPMENT.md).
