---
name: fusion-review
description: >
  Run a pi-fusion review: several models answer in parallel, then one synthesis
  step returns a single report. Use when the user says "invoke fusion", "run a
  fusion panel", "discuss this through fusion", "get multi-model opinions",
  "panel review", "compare <model> and <model> on this", or asks to cover
  something from several angles ("what did we miss", "audit this release").
  Call the start_fusion_review tool with the topic. NOT for routine edits,
  formatting, or one-step fixes. NOT for arguing one claim from both sides (use
  dialectic) and NOT for open-ended idea generation (use brainstorming) —
  Fusion panelists work independently and never talk to each other.
---

# Fusion Review

Call `start_fusion_review` so the user does not have to type `/fusion`.

## When to use

Use Fusion when independent perspectives are worth the extra latency:

- a hard decision or a design tradeoff
- risk or release review
- tricky debugging
- a research-heavy question
- a breadth sweep, such as an audit or "what did we miss"

Do not use Fusion for routine edits, formatting, obvious one-step fixes, or
simple questions. Keep those on the normal Pi path.

## Not this skill

- The user wants one claim argued for and against. That is `dialectic`.
- The user wants options generated, or a draft plan stress-tested. That is
  `brainstorming-ideas`.

Fusion differs from both. Panelists run in isolation and never see the answers of
the others. The value is uncorrelated errors, not debate.

## How to call it

| Parameter | Required | Use                                                           |
| --------- | -------- | ------------------------------------------------------------- |
| `prompt`  | yes      | The topic, question, or code excerpt                          |
| `profile` | no       | A named profile that the user already has. Omit it otherwise. |
| `panel`   | no       | Models for this run only. Use it when the user names models.  |

Each `panel` entry is `<model>` or `<agent>:<model>`. For example: `opus`, or
`pi-fusion.fusion-panelist-web:gpt-5.5`.

Pass `panel` only when the user names the models. If the user asks for a kind of
review but names no model, omit `panel` and let the profile decide.

Do not pass a `profile` name that you have not seen in the config of the user.
An unknown name fails the run.

## Two shapes of report

The shape follows the profile. You do not select it, and there is no flag.

**Select** is the default. Every panelist answers the whole question. The judge
compares the answers and reports consensus, disagreements, contested claims, and
blind spots. This fits a decision question, where the failure mode is the bad
reasoning path of one model.

**Merge** happens when the profile gives its members a `question` field. Each
panelist then answers a different facet. A composer unions the answers into a
coverage map, a combined answer, and a list of gaps. This fits a breadth
question, where the failure mode is incomplete coverage.

If the user asks for a multi-angle audit and has no faceted profile, run the
default panel. Then tell them that a profile with `question` fields covers this
better.

## After the call

The tool returns at once. The panel and the synthesis step run in the background,
and Fusion posts the report when they finish.

- Do not call the tool again while a run is active. It returns a conflict with
  the id of the active run.
- Do not summarize or predict the report. Wait for it.
- To show progress or stop a run, tell the user to type `/fusion status` or
  `/fusion stop`. No tool does this.
