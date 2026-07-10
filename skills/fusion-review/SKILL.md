---
name: fusion-review
description: >
  Trigger a pi-fusion multi-model panel review implicitly. Use when the user asks to
  "invoke fusion", "run a fusion panel", "discuss this through fusion", "get multi-model
  opinions", "panel review", or any phrasing that implies running a parallel model review.
  Call the start_fusion_review tool with the user's topic or prompt.
---

# Fusion Review

Use the `start_fusion_review` tool to launch a fusion panel without the user needing to type `/fusion`.

## When to use

Use Fusion for hard decisions, design tradeoffs, risk review, tricky debugging, or questions where independent model perspectives are useful.

Do not use Fusion for routine edits, formatting, obvious one-step fixes, or simple questions. Keep those on the normal Pi path.

- "invoke fusion panel to discuss this"
- "run fusion on this"
- "get a panel review of …"
- "use multi-model review for …"
- "discuss this through fusion"
- Any prompt that implies parallel model review or multi-perspective analysis

## How to use

Call `start_fusion_review` with:

- `prompt` — the topic, question, or code excerpt to review (required)
- `profile` — a named fusion profile (optional; omit to use the default)

The tool queues a `/fusion` command as a follow-up, so the panel starts immediately after the current turn.
