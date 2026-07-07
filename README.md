# pi-fusion

[![npm version](https://img.shields.io/npm/v/%40alexeiled%2Fpi-fusion?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@alexeiled/pi-fusion)
[![CI](https://img.shields.io/github/actions/workflow/status/alexei-led/pi-fusion/test.yml?branch=master&style=flat-square&label=ci)](https://github.com/alexei-led/pi-fusion/actions/workflows/test.yml?query=branch%3Amaster)
[![node](https://img.shields.io/badge/node-%3E%3D22.19.0-5fa04e?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

> Parallel models. One judge. Better answers.

`pi-fusion` is a Pi extension for hard technical questions.
It uses `pi-subagents` to send the same prompt through a small parallel model panel,
then asks a judge agent to compare the outputs and return the best realistic answer.

CI covers lint, typecheck, unit tests, integration tests, package smoke tests,
and `npm pack --dry-run`.

![pi-fusion flow](https://raw.githubusercontent.com/alexei-led/pi-fusion/master/docs/assets/fusion-flow.png)

## Why Fusion exists

Hard questions are often bottlenecked by one model's search path.
`pi-fusion` trades latency for diversity:

- the same prompt fans out to several model runs in parallel
- each model explores the problem from a different training prior and reasoning path
- overlap raises confidence
- disagreement exposes risk
- the judge keeps the strongest parts and drops weak, partial, or conflicting ones

This is evidence selection, not majority vote.

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "basis", "nodeSpacing": 28, "rankSpacing": 48}, "themeVariables": {"background": "#050816", "fontFamily": "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", "primaryTextColor": "#E5F0FF", "lineColor": "#38bdf8", "tertiaryColor": "#0b1220"}}}%%
flowchart LR
  classDef prompt fill:#071321,stroke:#38bdf8,color:#dbeafe,stroke-width:2px;
  classDef modelA fill:#081223,stroke:#38bdf8,color:#dbeafe,stroke-width:2px;
  classDef modelB fill:#120826,stroke:#a855f7,color:#f3e8ff,stroke-width:2px;
  classDef modelC fill:#08180f,stroke:#22c55e,color:#dcfce7,stroke-width:2px;
  classDef modelD fill:#241307,stroke:#f59e0b,color:#fef3c7,stroke-width:2px;
  classDef modelE fill:#260712,stroke:#ff4d8d,color:#ffd1e7,stroke-width:2px;
  classDef judge fill:#2b1905,stroke:#f59e0b,color:#fef3c7,stroke-width:3px;
  classDef answer fill:#062814,stroke:#22c55e,color:#dcfce7,stroke-width:3px;
  classDef note fill:#0b1220,stroke:#475569,color:#cbd5e1,stroke-width:1px;

  P["input prompt<br/>same question to every model"]:::prompt

  subgraph PANEL[parallel model panel]
    direction TB
    A["model A<br/>strong baseline candidate"]:::modelA
    B["model B<br/>finds contradiction"]:::modelB
    C["model C<br/>adds unique insight"]:::modelC
    D["model D<br/>fast practical path"]:::modelD
    E["model E<br/>catches edge case"]:::modelE
  end

  J["judge<br/>consensus • contradictions • blind spots"]:::judge
  R["best answer<br/>selected or synthesized"]:::answer
  N["not majority vote<br/>best evidence wins"]:::note

  P --> A
  P --> B
  P --> C
  P --> D
  P --> E

  A --> J
  B --> J
  C --> J
  D --> J
  E --> J

  J --> R
  J -.-> N

  linkStyle 0,5 stroke:#38bdf8,stroke-width:3px;
  linkStyle 1,6 stroke:#a855f7,stroke-width:3px;
  linkStyle 2,7 stroke:#22c55e,stroke-width:3px;
  linkStyle 3,8 stroke:#f59e0b,stroke-width:3px;
  linkStyle 4,9 stroke:#ff4d8d,stroke-width:3px;
  linkStyle 10 stroke:#22c55e,stroke-width:4px;
  linkStyle 11 stroke:#94a3b8,stroke-width:2px,stroke-dasharray: 5 5;
```

## Why a panel can beat one model

Single-model answers are brittle on hard tasks. They are limited by one model's
priors, one reasoning path, and one failure mode.

A panel helps because:

- different models are trained differently and make different bets
- errors are less correlated, so blind spots do not line up perfectly
- consensus is a useful confidence signal without pretending certainty
- disagreement tells you where the answer is fragile
- a judge can select or synthesize the best realistic answer from the set

The result is slower, but usually better for design choices, risk review,
tricky debugging, and research-heavy questions.

## What the judge actually does

The judge gets:

- the original prompt
- every panel output
- panel failures and blind spots
- the configured judge model

It then:

- finds consensus
- preserves real disagreements
- spots weak or incomplete answers
- pulls forward unique insights worth keeping
- returns one clear recommendation and next step

It does not edit files or spawn more subagents. It does one job: choose or
synthesize the best realistic answer.

## Good fit

Use it for questions like:

- Which design should we choose?
- What will break if I change this?
- Is this PR or release flow safe?
- What did I miss?
- What is the right test strategy here?

Do not use it for trivial edits, formatting, or obvious one-step fixes.

## Commands

```text
/fusion
/fusion <prompt>
/fusion --profile <name> <prompt>
/fusion -p <name> <prompt>
/fusion status
/fusion stop
/fusion init
```

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

For commands, config, and troubleshooting details, see [`docs/user-guide.md`](./docs/user-guide.md).

## Notes

- Bare `/fusion` shows a short command summary.
- Config is optional. Defaults work. Use `/fusion init` when you want project config.
- Project config lives at `.pi/fusion.json`. Global config lives at `~/.pi/agent/fusion.json`.
- Output appears as a Pi custom message. Active progress also uses the `fusion` status key.
- Active runs are reconciled from `pi-subagents` lifecycle artifacts, not only completion events.
- `pi-fusion` does not own the footer.
- Prompts and inspected snippets may be sent to your configured model providers through `pi-subagents`.

## Read more

- [`docs/user-guide.md`](./docs/user-guide.md) — commands, config, profiles, privacy, troubleshooting
- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — contributor workflow
