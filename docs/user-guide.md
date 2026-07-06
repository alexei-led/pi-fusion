# pi-fusion user guide

Use this when the README is not enough.

## Mental model

`pi-fusion` turns one hard question into a small review panel:

```text
prompt → panelists in parallel → judge synthesis → final report
```

The base Pi session stays in control. Fusion is a tool for decisions, not a replacement for normal coding.

## Commands

Preferred command shape:

```text
/fusion
/fusion <prompt>
/fusion --profile <name> <prompt>
/fusion -p <name> <prompt>
/fusion status
/fusion stop
/fusion init
```

Notes:

- Bare `/fusion` shows a short help message.
- `/fusion status` shows the active run, last run, warnings, and subagent run IDs.
- `/fusion stop` stops the active panel or judge run.
- `/fusion init` writes `.pi/fusion.json` for the current trusted project.
- Exact one-word prompts `init`, `status`, and `stop` are reserved as `/fusion` subcommands.

## Configuration files

Config lookup order:

1. trusted project config: `.pi/fusion.json`
2. global config: `~/.pi/agent/fusion.json`
3. built-in defaults

Run this inside a trusted project:

```text
/fusion init
```

## Minimal config

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
          "role": "architecture, tradeoffs, and failure modes"
        },
        {
          "id": "implementer",
          "label": "Implementer",
          "agent": "pi-fusion.fusion-panelist",
          "role": "implementation details, API contracts, and edge cases"
        },
        {
          "id": "tester",
          "label": "Tester",
          "agent": "pi-fusion.fusion-panelist",
          "role": "test strategy, regressions, and verification"
        }
      ],
      "judge": {
        "agent": "pi-fusion.fusion-judge"
      },
      "concurrency": 3,
      "timeoutMs": 300000,
      "context": "fresh"
    }
  }
}
```

## Profile fields

Top level:

- `defaultProfile`: profile used when `/fusion` has no `--profile`
- `profiles`: named profile map

Profile:

- `panel`: one or more panel members
- `judge`: judge agent config
- `concurrency`: max parallel panelists
- `timeoutMs`: async subagent timeout in milliseconds
- `context`: `fresh` or `fork`

Panel member:

- `id`: stable machine name
- `label`: human-readable report label
- `agent`: subagent name
- `model`: optional model override
- `thinking`: optional `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`
- `role`: short perspective instruction

Judge:

- `agent`: judge subagent name
- `model`: optional model override
- `thinking`: optional thinking level

## Example profiles

Fast and cheap:

```json
{
  "defaultProfile": "fast",
  "profiles": {
    "fast": {
      "panel": [
        {
          "id": "reviewer",
          "label": "Reviewer",
          "agent": "pi-fusion.fusion-panelist",
          "thinking": "low",
          "role": "practical risks and next step"
        }
      ],
      "judge": {
        "agent": "pi-fusion.fusion-judge",
        "thinking": "low"
      },
      "concurrency": 1,
      "timeoutMs": 120000,
      "context": "fresh"
    }
  }
}
```

Deliberate review:

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
          "model": "anthropic/claude-sonnet-4",
          "thinking": "high",
          "role": "architecture and failure modes"
        },
        {
          "id": "tester",
          "label": "Tester",
          "agent": "pi-fusion.fusion-panelist",
          "model": "openai/gpt-5.5",
          "thinking": "medium",
          "role": "tests, regressions, and observability"
        }
      ],
      "judge": {
        "agent": "pi-fusion.fusion-judge",
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high"
      },
      "concurrency": 2,
      "timeoutMs": 300000,
      "context": "fresh"
    }
  }
}
```

## Output

Panelists return:

- summary
- recommendation
- evidence
- risks
- confidence
- open questions

The judge returns:

- summary
- agent status
- consensus
- disagreements
- unique insights
- blind spots
- recommendation
- risks
- next step

## Status and footer integration

`pi-fusion` uses only the Pi status key `fusion` while a run is active.

It does not own the footer. If you use a footer extension, configure it to read the `fusion` status key.

## Privacy and provider use

Fusion sends work to `pi-subagents`. Those subagents use your configured Pi model providers.

Data that may leave your machine:

- the prompt you pass to `/fusion`
- relevant local file snippets read by panelists or the judge
- panel outputs sent to the judge

Default bundled agents are read-only, but model providers still receive the context needed to answer.

## Troubleshooting

`pi-subagents RPC is unavailable`

- install `pi-subagents`
- reload Pi
- retry `/fusion status`

`Unknown fusion profile`

- check `defaultProfile`
- check the requested `--profile` name
- run `/fusion init` to regenerate a known-good template

Run is stuck or no longer useful:

```text
/fusion stop
```

Need the run IDs:

```text
/fusion status
```
