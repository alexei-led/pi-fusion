# pi-fusion

Subagent-native multi-model deliberation for Pi.

`pi-fusion` adds an explicit `/fusion` command that runs a read-only panel through `pi-subagents`, asks a judge to synthesize successful panel outputs, and returns a Markdown report. It publishes only the `fusion` status key for footer/status integration. It never owns or replaces the Pi footer.

## Requirements

- Pi with Node.js 22.19 or newer.
- `pi-subagents` installed and reachable over its RPC channel.
- Optional: `pi-powerline-footer` if you want a footer item that reads the `fusion` status key.

Install the required subagent extension if needed:

```bash
pi install npm:pi-subagents
```

## Install

From a local checkout:

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

## Commands

```text
/fusion-init
/fusion-status
/fusion-cancel
/fusion Compare two implementation approaches.
/fusion --profile fast Compare two implementation approaches.
/fusion -p fast Compare two implementation approaches.
```

- `/fusion-init` writes a project-local `.pi/fusion.json` template for trusted projects.
- `/fusion-status` shows the active or last run, phase, profile, run IDs, progress, and warnings.
- `/fusion-cancel` stops the active panel or judge run, falling back to interrupt when stop is unavailable.
- `/fusion` starts the configured panel. If one panelist succeeds, the report uses that single result. If two or more succeed, a judge synthesizes the final report.

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

Bundled panel agents are read-only by default. They are instructed not to edit files, stage changes, commit changes, run destructive commands, ask other agents, or run nested subagents.

## Development

```bash
npm install
npm run check
npm test
npm run pack:dry
```
