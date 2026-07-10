# pi-fusion user guide

README covers the why. This guide covers commands, config, and troubleshooting.

## Mental model

`pi-fusion` turns one hard question into a small parallel panel:

```text
prompt → parallel panel → judge synthesis → final report
```

Fusion keeps the command simple: one prompt starts the panel, then the judge turns the collected evidence into a human-readable Markdown report. Older runs created as a single `pi-subagents` chain remain supported when restored.

Panel diversity can come from different model choices, different perspective prompts, or both. In practice, mixing models is usually the main lever.

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
- `/fusion stop` stops the active panel, legacy chain, or judge run.
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
      "context": "fresh",
      "stopWhenPanelAgrees": false
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
- `stopWhenPanelAgrees`: optional boolean, default `false`. When enabled, Fusion may stop unfinished panelists only when at least two completed panelists have the same normalized recommendation, every successful panelist reports `high` confidence, none requests more evidence, and work remains. The judge still runs over the collected answers. The policy is intentionally fixed; there are no agreement threshold knobs.

Panel member:

- `id`: stable machine name
- `label`: human-readable report label
- `agent`: subagent name
- `model`: optional model override; often the main source of panel diversity. Supports normal Pi model ids, and if `pi-claude-alias` is configured, Claude alias shorthand like `claude-work/opus-4.8`
- Claude alias handles must be unique across global and project alias files; duplicate handles are rejected.
- `thinking`: optional `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`
- `role`: optional perspective hint layered on top of the model

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
          "model": "claude-work/sonnet-4.6",
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
        "model": "claude-work/sonnet-4.6",
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

When agreement stopping is enabled, panelists append a final tagged JSON decision record containing a short recommendation, confidence, and whether more evidence is needed. Fusion uses it only to decide whether an unfinished panel may stop early; malformed, missing, or non-final records disable early stopping. Users see the preceding human-readable Markdown answer, not the record.

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

When lifecycle data is available, the final report also includes per-panel and judge time, aggregate model time, token usage, estimated cost, and concise model/provider failure summaries. Aggregate model time sums agent durations and is not wall-clock latency when panelists overlap. Missing usage is shown as unknown; local zero-cost usage remains zero. `Model` comes from lifecycle metadata; `Configured model` is the profile request. Both appear when a provider reports a different executed model.

## Status and footer integration

`pi-fusion` uses only the Pi status key `fusion` while a run is active.

It does not own the footer. If you use a footer extension, configure it to read the `fusion` status key.

## Data sharing and provider use

Fusion uses model providers the same way normal Pi work does. The difference is fan-out:

- normal work usually sends a prompt and tool results to one selected model;
- Fusion sends the prompt to every configured panel model;
- local file snippets read by a panelist go to that panelist's model;
- the judge receives the original prompt plus successful panel answers and failure summaries.

This is not an extra privacy guarantee. A mixed-provider panel can send copies of the work to several providers. An all-local panel can keep those model calls local, depending on your Pi model configuration. Bundled Fusion agents are read-only, but providers still receive the context needed to answer.

Fusion does not currently inspect or rewrite the final provider payload. Configure provider privacy and local-model routing in Pi.

## Small and economical profiles

These are configuration examples, not built-in provider presets. Omit `model` to inherit the model selected in Pi, or set any model IDs supported by your Pi `models.json` configuration.

Small local-style panel:

```json
{
  "defaultProfile": "small",
  "profiles": {
    "small": {
      "panel": [
        {
          "id": "reviewer",
          "label": "Reviewer",
          "agent": "pi-fusion.fusion-panelist",
          "thinking": "low",
          "role": "practical risks and next step"
        },
        {
          "id": "tester",
          "label": "Tester",
          "agent": "pi-fusion.fusion-panelist",
          "thinking": "low",
          "role": "edge cases and verification"
        }
      ],
      "judge": { "agent": "pi-fusion.fusion-judge", "thinking": "low" },
      "concurrency": 2,
      "timeoutMs": 120000,
      "context": "fresh"
    }
  }
}
```

For an economical mixed panel, give each member a fast or inexpensive frontier, Chinese-lab, or local Ollama/LM Studio/vLLM model ID. Keep the profile composition small instead of adding provider-specific code to Fusion.

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

Notes:

- `Panel run` is the normal panel phase for new Fusion runs.
- `Judge run` is the normal synthesis phase for new runs. `Fallback judge run` appears only while restoring a legacy chain that completed without its judge result.
- If `pi-subagents` completion notifications are delayed or missed, Fusion still reconciles from lifecycle artifacts written under the subagent async run directory.
