# pi-fusion user guide

README covers the why. This guide covers commands, config, and troubleshooting.

## Mental model

`pi-fusion` turns one hard question into a small parallel panel:

```text
prompt → parallel panel → judge picks the best answer → report
```

The command stays simple. One prompt starts the panel. One synthesis step then
turns the collected evidence into a Markdown report.

There is a second shape. Give panel members a `question` and they answer
*different facets* instead of the same question, and a composer merges their
answers rather than picking between them:

```text
prompt → panel, one facet each → composer merges → report
```

You do not select between these. Facets decide: a panel with `question` fields
merges, a panel without them selects.

Panel diversity comes from different model choices, different perspective
prompts, or both. **Mixing models is the main lever.** The config that
`/fusion init` writes sets no `model`. By default you therefore get one model in
three roles. Give each member its own `model` to get the real benefit.

Fusion launches new panels through `pi-subagents` `workflowScript`; the panel and judge remain separate durable runs. Older runs created as a single `pi-subagents` chain remain supported when restored.

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
setting. Only the panel changes.

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
contains a `.` and the part after it is not a thinking level. That keeps both
`opus:high` and `gpt-4.1:high` models rather than agent references.

The thinking levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
A word that is not one of them is read as a model, so `gpt-4.1:ultra` asks for
the agent `gpt-4.1`, and the run fails with an unknown-agent error. Use a real
level, or write the agent in full.
Claude alias shorthand works inline: `--panel claude-work/opus-4.8`.

## Config files

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
- `concurrency`: max parallel panelists. When `stopWhenPanelAgrees` is on, Fusion evaluates the first two panelists before launching another batch so it can avoid work after strong agreement.
- `timeoutMs`: async subagent timeout in milliseconds
- `context`: `fresh` or `fork`
- `stopWhenPanelAgrees`: optional boolean, default `false`. When it is on, Fusion can stop the panelists that have not finished yet. All four conditions must hold: two or more finished panelists give the same normalized recommendation, every one of them reports `high` confidence, none of them asks for more evidence, and work remains. The judge still runs over the answers already collected. This policy is fixed on purpose. There is no threshold to tune.
- `synthesis`: rarely needed. Inferred from the panel — any member with a `question` means `merge`, otherwise `select`. Set it only to override that. See [Synthesis modes](#synthesis-modes).
- `blindPanelLabels`: optional boolean, default `false`. When it is on, the judge sees `Candidate A`, `Candidate B`, and so on, instead of the configured labels. Fusion also withholds agent names and artifact paths, because they contain the member id. A role label reads as an authority cue before the judge compares any content. Your report always shows the real names.
- `judgeToolBudget`: optional `{ "soft": n, "hard": n }`. It caps the tool calls the judge can spend to verify contested claims. `soft` is a nudge. After `hard`, Fusion blocks further tool use, so the judge still produces a report. Both numbers must be positive integers, and `soft` must not be larger than `hard`.

Panel member:

- `id`: stable machine name
- `label`: optional report label. It defaults to `id`
- `agent`: subagent name. This is where a member's tool access comes from — see [Panel agents and tools](#panel-agents-and-tools).
- `model`: optional model override, and usually the main source of panel diversity. It accepts normal Pi model ids. If `pi-claude-alias` is installed, it also accepts Claude alias shorthand like `claude-work/opus-4.8`
- A Claude alias handle must be unique across the global and project alias files. Fusion rejects a duplicate handle.
- `thinking`: optional `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`
- `role`: optional perspective hint layered on top of the model
- `question`: optional facet prompt sent **instead of** the raw task. `{task}` is substituted with the original prompt. Use with `synthesis: "merge"` to divide the work rather than duplicate it. If the template omits `{task}`, the original task is still appended so the panelist keeps its context.

## Panel agents and tools

A panel member's tools come from its **agent definition**, not from `fusion.json`.
`pi-subagents` has no per-task tool override, so `agent` is the knob.

Fusion ships five:

| Agent                            | Tools                                                        | Use for                                                        |
| -------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| `pi-fusion.fusion-panelist` | `read, grep, find, ls` | Default. Local inspection only. It needs no extra extension. |
| `pi-fusion.fusion-panelist-web` | above plus `web_search, web_contents, web_answer` | Opt-in. **Requires `pi-web-providers`.** |
| `pi-fusion.fusion-panelist-full` | above plus `bash, edit, write, web_research` | Opt-in. Requires `pi-web-providers`. **See the warning below.** |
| `pi-fusion.fusion-judge` | `read, grep, find, ls` | Judge. The read tools let it verify contested claims. |
| `pi-fusion.fusion-composer` | `read, grep, find, ls` | Synthesis under `synthesis: "merge"`. |

> **Tool names are a strict allowlist, not a loader.** If an agent declares a tool
> whose provider extension is not installed, every task using that agent fails
> with `requested unavailable child tools`. That is why the default agents stay on
> Pi core tools: `pi-web-providers` is optional, so depending on it by default
> breaks every run for anyone without it. Install it before you use the `-web`
> or `-full` variant:
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
deep-research model that takes minutes. A panel runs it for every member at the
same time.

> **`fusion-panelist-full` voids the read-only guarantee.** It grants `edit`,
> `write`, and `bash`. Fusion runs panelists **in parallel in the same working
> directory**, so at `concurrency > 1` two members can mutate the same files or
> git state at once. The prompt asks them not to, but nothing enforces this.
> Use it with `"concurrency": 1`, or do not use it at all.

## Synthesis modes

`select` (default) — every panelist answers the whole question and
`fusion-judge` compares them, reporting consensus, disagreements, contested
claims, unique insights, and blind spots. Use it for decision questions, where
the failure mode is one model's bad reasoning path and redundancy is the fix.

`merge` — panelists answer **different facets** and `fusion-composer` unions
them, reporting a coverage map, the combined answer, gaps, and conflicts only
where facets genuinely overlap. **To get this, give the members a `question`.**
You do not also have to set `synthesis`. Use merge for breadth questions such as
audits, "what did we miss", and release sweeps. There the failure mode is
incomplete coverage, and redundant panelists all miss the same things.

Merge mode swaps the synthesis agent, not the run lifecycle. It reuses the judge
run slot, so a `fusion:rpc:v1` consumer sees no new phase.

**If you set a custom `judge.agent`, Fusion uses it in both modes.** The merge
contract then becomes your responsibility. Fusion substitutes `fusion-composer`
only when `judge.agent` is still the bundled `pi-fusion.fusion-judge`. Explicit
config always wins.

Under `synthesis: "merge"` your agent gets the composer instructions. It must
emit `Coverage Map`, `Combined Answer`, `Gaps`, and `Conflicts At Seams`. For a
section it does not produce, Fusion writes "Not specified by the composer". The
run does not fail, so a mismatch appears as an empty report, not as an error.

```json
{
  "defaultProfile": "audit",
  "profiles": {
    "audit": {
      "panel": [
        {
          "id": "security",
          "agent": "pi-fusion.fusion-panelist",
          "question": "Cover ONLY the security and data-exposure surface of: {task}"
        },
        {
          "id": "perf",
          "agent": "pi-fusion.fusion-panelist",
          "question": "Cover ONLY throughput, latency, and resource use of: {task}"
        },
        {
          "id": "ops",
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

Under `merge`, one surviving panelist still goes to the composer. Fusion does
not return that answer directly. One facet is not the answer, and the report must
name what is missing.

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

When agreement stopping is on, each panelist appends one tagged JSON decision record. The record holds a short recommendation, a confidence level, and whether the panelist needs more evidence. Fusion uses it only to decide whether an unfinished panel can stop early. A record that is malformed, missing, or not final turns early stopping off. You see the Markdown answer above the record, not the record itself.

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

When lifecycle data is available, the report gives more. It adds per-panel and judge time, total model time, token usage, and estimated cost. It also adds a short failure summary per model and provider. Total model time is the sum of the agent durations. It is not wall-clock latency, because panelists overlap. Missing usage is shown as unknown, and local zero-cost usage stays zero. `Model` comes from lifecycle metadata. `Configured model` is what the profile asked for. Both appear when a provider reports a different model.

## Status and footer integration

`pi-fusion` uses only the Pi status key `fusion` while a run is active.

It does not own the footer. If you use a footer extension, configure it to read the `fusion` status key.

## Data sharing and provider use

Fusion uses model providers the same way normal Pi work does. The difference is fan-out:

- normal work usually sends a prompt and tool results to one model
- Fusion sends the prompt to every panel model
- a local file snippet that a panelist reads goes to the model of that panelist
- the judge gets the original prompt, the successful panel answers, and the failure summaries

**Panelists can reach the web, but only if you opt in.** The default panelist,
judge, and composer are local-only. A member that uses `fusion-panelist-web` or
`fusion-panelist-full` can search. Your prompt, and any query that the member
derives from your code, then go to the provider set in
`~/.pi/agent/web-providers.json`. That provider is a third party, separate from
your model provider. Keep every member on the default agent to hold a run
entirely off the web.

This is not an extra privacy guarantee. A panel with several providers sends copies of the work to each of them. An all-local panel keeps those model calls local, if your Pi model config allows it. Every bundled Fusion agent except `fusion-panelist-full` is read-only. Each provider still gets the context it needs to answer. `fusion-panelist-full` is not read-only. See [Panel agents and tools](#panel-agents-and-tools).

Fusion does not currently inspect or rewrite the final provider payload. Configure provider privacy and local-model routing in Pi.

## Small and economical profiles

These are config examples, not built-in provider presets. Omit `model` to inherit the model that Pi has selected. You can also set any model id that your Pi `models.json` config supports.

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

- install or update `pi-subagents` to 0.43.0 or later
- reload Pi
- retry `/fusion status`

`RPC spawn no longer accepts top-level chain or parallel inputs; use workflowScript.`

- update `pi-fusion` to 0.6.1 or later
- reload Pi so it loads the updated extension
- retry `/fusion`; do not change your Fusion profile

`Unknown fusion profile`

- verify `defaultProfile`
- verify the requested `--profile` name
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
