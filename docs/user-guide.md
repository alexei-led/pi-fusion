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
/fusion --panel <entries> <prompt>
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

### `--panel`

Builds a one-off panel without editing config, for trying a composition before
committing to it. The resolved profile still supplies the judge and every other
setting; only the panel is replaced.

```text
/fusion --panel opus,openai/gpt-5.5 Which design should we pick?
/fusion --panel=opus,openai/gpt-5.5 Which design should we pick?
/fusion --profile audit --panel opus,gemini-pro What did we miss?
```

Each comma-separated entry is `<model>` or `<agent>:<model>`:

```text
--panel opus,gpt-5.5                                     # both use the default panelist
--panel pi-fusion.fusion-panelist-web:gpt-5.5,opus       # first member gets web access
```

An entry counts as agent-qualified only when the part before the first `:`
contains a `.`, which package-qualified agent names always do. That keeps
`opus:high` a model with a thinking suffix rather than an agent reference.
Claude alias shorthand works inline: `--panel claude-work/opus-4.8`.

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
- `synthesis`: optional `select` (default) or `merge`. See [Synthesis modes](#synthesis-modes).
- `blindPanelLabels`: optional boolean, default `false`. Presents panel answers to the judge as `Candidate A`, `Candidate B`, … instead of the configured labels, and withholds agent names and artifact paths, which contain the member id. Role labels read as authority cues before any content is compared. Your report always shows the real names.
- `judgeToolBudget`: optional `{ "soft": n, "hard": n }`. Caps the tool calls the judge may spend verifying contested claims. `soft` nudges; after `hard`, tool use is blocked so the judge still produces a report. Both must be positive integers and `soft` must not exceed `hard`.

Panel member:

- `id`: stable machine name
- `label`: human-readable report label
- `agent`: subagent name. This is where a member's tool access comes from — see [Panel agents and tools](#panel-agents-and-tools).
- `model`: optional model override; often the main source of panel diversity. Supports normal Pi model ids, and if `pi-claude-alias` is configured, Claude alias shorthand like `claude-work/opus-4.8`
- Claude alias handles must be unique across global and project alias files; duplicate handles are rejected.
- `thinking`: optional `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`
- `role`: optional perspective hint layered on top of the model
- `question`: optional facet prompt sent **instead of** the raw task. `{task}` is substituted with the original prompt. Use with `synthesis: "merge"` to divide the work rather than duplicate it. If the template omits `{task}`, the original task is still appended so the panelist keeps its context.

## Panel agents and tools

A panel member's tools come from its **agent definition**, not from `fusion.json`.
`pi-subagents` has no per-task tool override, so `agent` is the knob.

Fusion ships five:

| Agent                            | Tools                                                        | Use for                                                        |
| -------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| `pi-fusion.fusion-panelist` | `read, grep, find, ls` | Default. Local inspection only; works with no extra extensions. |
| `pi-fusion.fusion-panelist-web` | above plus `web_search, web_contents, web_answer` | Opt-in. **Requires `pi-web-providers`.** |
| `pi-fusion.fusion-panelist-full` | above plus `bash, edit, write, web_research` | Opt-in. Requires `pi-web-providers`. **See the warning below.** |
| `pi-fusion.fusion-judge` | `read, grep, find, ls` | Judge; the read tools are what let it verify contested claims. |
| `pi-fusion.fusion-composer` | `read, grep, find, ls` | Synthesis under `synthesis: "merge"`. |

> **Tool names are a strict allowlist, not a loader.** If an agent declares a tool
> whose provider extension is not installed, every task using that agent fails
> with `requested unavailable child tools`. That is why the default agents stay on
> Pi core tools: `pi-web-providers` is optional, so depending on it by default
> would break every run for anyone without it. Install it before using the `-web`
> or `-full` variants:
>
> ```bash
> pi install npm:pi-web-providers
> ```

Mix them per member:

```json
{
  "panel": [
    {
      "id": "arch",
      "label": "Architect",
      "agent": "pi-fusion.fusion-panelist"
    },
    {
      "id": "local",
      "label": "Local",
      "agent": "pi-fusion.fusion-panelist-web"
    },
    { "id": "mine", "label": "Custom", "agent": "my-package.my-panelist" }
  ]
}
```

For any other combination, write your own agent markdown file with the `tools:`
frontmatter you want and point `agent` at it. Valid tool names are the Pi core
tools `read, bash, edit, write, grep, find, ls` and, when `pi-web-providers` is
installed, `web_search, web_contents, web_answer, web_research`. A name outside
that set resolves to nothing and the run fails with a missing-tool error.

`web_research` is excluded from the default panelist on purpose: it routes to a
deep-research model that takes minutes, and a panel would fire it concurrently
for every member.

> **`fusion-panelist-full` voids the read-only guarantee.** It grants `edit`,
> `write`, and `bash`. Fusion runs panelists **in parallel in the same working
> directory**, so at `concurrency > 1` two members can mutate the same files or
> git state at once. The prompt asks them not to; nothing enforces it. Use it
> with `"concurrency": 1`, or not at all.

## Synthesis modes

`select` (default) — every panelist answers the whole question and
`fusion-judge` compares them, reporting consensus, disagreements, contested
claims, unique insights, and blind spots. Use it for decision questions, where
the failure mode is one model's bad reasoning path and redundancy is the fix.

`merge` — panelists answer **different facets** and `fusion-composer` unions
them, reporting a coverage map, the combined answer, gaps, and conflicts only
where facets genuinely overlap. Use it for breadth questions — audits, "what did
we miss", release sweeps — where the failure mode is incomplete coverage and
redundant panelists all miss the same things.

Merge mode swaps the synthesis agent, not the run lifecycle: it reuses the judge
run slot, so `fusion:rpc:v1` consumers see no new phase.

**If you set a custom `judge.agent`, it is used in both modes and the merge
contract becomes your responsibility.** Fusion substitutes `fusion-composer` only
when `judge.agent` is still the bundled `pi-fusion.fusion-judge` — explicit
config wins. Under `synthesis: "merge"` your agent receives the composer
instructions and is expected to emit `Coverage Map`, `Combined Answer`, `Gaps`,
and `Conflicts At Seams`. Sections it does not produce are rendered as "Not
specified by the composer" rather than failing the run, so a mismatch shows up as
an empty report, not an error.

```json
{
  "defaultProfile": "audit",
  "profiles": {
    "audit": {
      "synthesis": "merge",
      "panel": [
        {
          "id": "security",
          "label": "Security",
          "agent": "pi-fusion.fusion-panelist",
          "question": "Cover ONLY the security and data-exposure surface of: {task}"
        },
        {
          "id": "perf",
          "label": "Performance",
          "agent": "pi-fusion.fusion-panelist",
          "question": "Cover ONLY throughput, latency, and resource use of: {task}"
        },
        {
          "id": "ops",
          "label": "Operations",
          "agent": "pi-fusion.fusion-panelist",
          "question": "Cover ONLY rollout, rollback, and observability of: {task}"
        }
      ],
      "judge": { "agent": "pi-fusion.fusion-judge", "thinking": "high" },
      "concurrency": 3
    }
  }
}
```

Under `merge`, a run where only one panelist survives still goes to the composer
rather than returning that answer directly — one facet is not the answer, and the
report needs to name what is missing.

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

**Panelists can reach the web, but only if you opt in.** The default panelist,
judge, and composer are local-only. A member using `fusion-panelist-web` or
`fusion-panelist-full` can search: your prompt and whatever query it derives from
your code then go to the provider configured in `~/.pi/agent/web-providers.json`
— a third party separate from your model provider. Keeping every member on the
default agent keeps a run entirely off the web.

This is not an extra privacy guarantee. A mixed-provider panel can send copies of the work to several providers. An all-local panel can keep those model calls local, depending on your Pi model configuration. Every bundled Fusion agent except `fusion-panelist-full` is read-only, but providers still receive the context needed to answer. `fusion-panelist-full` is not read-only; see [Panel agents and tools](#panel-agents-and-tools).

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
