# Development Guide

## Local install

```bash
npm install
npm run check
npm test
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

## Commands

```text
/fusion-init
/fusion-status
/fusion-cancel
/fusion Compare two implementation approaches.
/fusion --profile fast Compare two implementation approaches.
/fusion -p fast Compare two implementation approaches.
```

## Config

Project config lives at `.pi/fusion.json` and is read only for trusted projects. Global config lives at `~/.pi/agent/fusion.json`.

```json
{
  "defaultProfile": "quality",
  "profiles": {
    "quality": {
      "panel": [
        {
          "id": "architect",
          "label": "Architect",
          "agent": "pi-fusion.fusion-panelist",
          "model": "openai/gpt-5.5",
          "thinking": "high",
          "role": "architecture and tradeoffs"
        },
        {
          "id": "tester",
          "label": "Tester",
          "agent": "pi-fusion.fusion-panelist",
          "model": "anthropic/claude-sonnet-4",
          "thinking": "medium",
          "role": "test strategy and regressions"
        }
      ],
      "judge": {
        "agent": "pi-fusion.fusion-judge",
        "model": "openai/gpt-5.5",
        "thinking": "xhigh"
      },
      "concurrency": 2,
      "timeoutMs": 300000,
      "context": "fresh"
    }
  }
}
```

`thinking` is appended to a configured model as a suffix when the model does not already have one, for example `openai/gpt-5.5:xhigh`.

## Footer integration

`pi-fusion` calls `ctx.ui.setStatus("fusion", ...)` while a run is active and clears that key when idle. It does not call `ctx.ui.setFooter(...)`.

With `pi-powerline-footer`, add a custom item that reads status key `fusion`. Keep footer ownership in the footer extension.

## Privacy and tool access

Prompts are sent to the configured panel and judge model providers through `pi-subagents`. If a panelist inspects local files, relevant file contents or snippets can also be sent to those providers. Configure profiles and providers accordingly.

Bundled panel agents are instructed not to edit files, stage changes, commit changes, run destructive commands, ask other agents, or run nested subagents.

## Validation

```bash
npm run check
npm test
npm run pack:dry
npm run publish:dry
```

## Release

Target package:

```text
@alexeiled/pi-fusion
```

Release steps:

```bash
npm login
npm whoami
npm run check
npm test
npm run publish:dry
npm publish
```
