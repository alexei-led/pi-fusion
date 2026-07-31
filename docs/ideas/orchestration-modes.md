# Fusion orchestration modes — competitive scan and idea backlog

Status: brainstorm, not a plan. No code changed.

Scope: what OpenRouter Fusion, Sakana AI, Anthropic's research system, and the
LLM-jury literature do that `pi-fusion` does not, and which of it is worth
taking for a 13k-LOC Pi extension.

---

## 0. Where pi-fusion stands today

Verified against source, not assumed:

| Fact                                                                                               | Where                                           |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Exactly one topology: same prompt → N panelists in parallel → judge                                | `src/run-builder.ts`, `src/orchestrator.ts`     |
| `role` is a _lens hint prepended to the full task_ — every member still answers the whole question | `run-builder.ts:266-275` (`buildPanelTask`)     |
| Judge sees `label` + `agent`, **not** the model id                                                 | `run-builder.ts:371-381` (`formatPanelOutputs`) |
| Judge sees panelists in fixed index order                                                          | `comparePanelItems`, `run-builder.ts:400`       |
| `PanelDecision {confidence, needsMoreEvidence}` exists but only feeds `stopWhenPanelAgrees`        | `types.ts`, `panel-completion.ts`               |
| Cost is **post-hoc** provider lifecycle metadata (`usage.costUsd`), there is no local price table  | `report.ts:427-463`                             |
| `claude-aliases.ts` maps handle → provider id. It is not a capability registry                     | `claude-aliases.ts:64-77`                       |
| **`pi-subagents` chains abort on any nonzero child exit** — `failFast` only controls sibling abort | `pi-subagents/.../subagent-runner.ts:3239,3599` |
| `steer` is reachable over the pi-subagents RPC but Fusion does not expose it; `append-step` is not | `pi-subagents/src/extension/rpc.ts:309-327`     |

Three consequences that shape everything below:

1. **Panel diversity today is prior diversity only.** All panelists get the same
   question, the same tools (`read, grep, find, ls`), and the same context mode.
2. **There is no local model metadata.** Any "compose the panel by cost/speed"
   feature needs a registry first. That is the blocking primitive, not the
   selection logic.
3. **Every new mode must be Fusion-level spawn sequencing, not a chain.** Chains
   die on any nonzero child exit, which is the exact opposite of Fusion's
   semantics — `PanelFailureReason` treats panelist failure as expected and
   `renderPanelFailureReport` degrades gracefully. Fusion already does
   spawn → reconcile → spawn (panel, then judge), so an extra wave repeats an
   existing pattern rather than needing new machinery.

---

## 1. Complementary panels — models that complete each other

This is the user's second ask and the one with a real design trap in it.

### The trap

`role` looks like it already does this. It does not. `buildPanelTask` emits:

```
Panel member: Architect (architect)
Role: architecture, tradeoffs, and failure modes

Original task:
<the whole prompt>
```

Everyone answers the whole prompt, wearing a hat. That is still competition —
five overlapping answers that a judge has to rank.

Real complementarity means **different sub-questions**, and that breaks the
judge. `agents/fusion-judge.md` is contracted to emit `Consensus`,
`Disagreements`, and "prefer the smallest realistic recommendation". When
panelists answered non-overlapping questions:

- `Consensus` is vacuous — there is nothing to agree about
- `Disagreements` fires spuriously on what is really _coverage_, not conflict
- "smallest realistic recommendation" actively discards the union you wanted

**So this is not a config flag on the existing judge. It needs a second agent.**

### Shape

Add a `synthesis` axis to the profile, orthogonal to the panel list:

```jsonc
{
  "panel": [/* ... */],
  "synthesis": "select", // today's behaviour, fusion-judge
  // or
  "synthesis": "merge", // new, fusion-composer
}
```

- `select` → `fusion-judge`. Consensus / Disagreements / pick the best. Unchanged.
- `merge` → new `agents/fusion-composer.md`. Contract is different:
  `Coverage map` (which facet each member owned), `Combined answer`,
  `Gaps` (facets nobody covered or covered thinly), `Conflicts at the seams`
  (only where facets genuinely overlap), `Next step`.

Two ways to assign facets, cheapest first:

**a. Static facets (v1).** Add optional `question` to `PanelMemberConfig` — a
template with `{task}` in it. When present, `buildPanelTask` sends the facet
question instead of the raw prompt.

```jsonc
{
  "id": "sec",
  "label": "Security",
  "question": "For this task, cover ONLY the security and data-exposure surface: {task}",
}
```

No planner, no new phase, no new run state. This is genuinely small.

**b. Dynamic facets (v2).** A cheap `fusion-scout` pass reads the prompt and
emits a facet list as JSON; the orchestrator instantiates one panelist per
facet. This is Anthropic's orchestrator-worker: the lead agent "analyzes it,
develops a strategy, and spawns subagents to explore different aspects
simultaneously", each with its own context window, then compresses. It adds a
real phase to `FusionPhase` and a real failure mode (bad decomposition poisons
the whole run), so it should land after (a) proves the composer works.

### When merge beats select

Not always, and the difference is worth encoding in the docs:

- **Merge wins** on breadth-limited questions — "what did I miss", audits,
  research surveys, release-risk sweeps. The failure mode is _incomplete
  coverage_, and redundant panelists all miss the same things.
- **Select wins** on decision questions — "which design", "is this safe to
  ship". The failure mode is _one model's bad reasoning path_, and redundancy
  is exactly the fix.

Sakana makes the same observation from the search side: "one LLM might be better
at defining the overall strategy, while another is better at writing the
specific code."

Keep both. Do not replace one with the other.

---

## 2. Dynamic panels

Four levels of dynamism. Ordered by cost to build.

### a. Inline panel override (trivial)

`/fusion --panel opus,gpt-5.5,gemini-pro <prompt>` — build an ephemeral profile
from a comma list, no config edit. Purely an argument-parsing change in
`fusion-args.ts` + `config.ts`. Removes the main friction of trying a panel.

### b. Recruiter pass (the real one)

One cheap model call before the panel: given the prompt and a declared model
registry, emit a panel spec.

```jsonc
{
  "members": [{ "model": "...", "role": "...", "thinking": "high" }],
  "why": "...",
}
```

The important part is **the constraints live in TypeScript, not in the prompt**:
panel size bounds, minimum provider-family diversity, budget ceiling, fallback
to the named profile if the spec is invalid. Taste from the model, guarantees
from code. The jury literature's one durable practical rule is the diversity
constraint — a panel of three models from one family is redundancy, not an
ensemble, because their errors correlate.

Cheap fallback if a recruiter call feels like too much latency: keyword/heuristic
routing to a named profile (`review` / `design` / `debug`), which is just a
lookup table.

### c. Adaptive panel size

Start with 2, expand to 4 only if they disagree or report low confidence.
`PanelDecision` already carries `confidence` and `needsMoreEvidence` — the
signals exist.

**This is not `stopWhenPanelAgrees` with the sign flipped.** That setting kills
panelists that are already running; the tokens are largely spent. Expansion
means tier 2 is _never launched_ on easy questions. Different control flow,
strictly better cost profile, and it composes with the cascade in §4.

### d. Adaptive model selection inside a search loop

Sakana's Multi-LLM AB-MCTS adds a third decision to tree search: after choosing
go-wider (new solution) vs go-deeper (refine existing), it also chooses **which
LLM** to call next, learning per-model promise as the search runs. Their
o4-mini + Gemini-2.5-Pro + R1-0528 combination beat each model individually on
ARC-AGI-2 by a wide margin.

It is also the thing pi-fusion is furthest from shipping — see §5.

---

## 3. Composing by cost, speed, thinking level, capability

The user's third ask. **Blocked on one missing primitive.**

`report.ts` reads `usage.costUsd` off provider lifecycle metadata _after_ the run
finishes. There is nothing to plan against beforehand. So step one is not
selection logic, it is a registry:

```jsonc
{
  "models": {
    "opus": {
      "id": "claude-work/opus-4.8",
      "family": "anthropic",
      "tier": "frontier",
      "usdPerMTokIn": 5,
      "usdPerMTokOut": 25,
      "speed": "slow",
      "maxThinking": "xhigh",
      "tags": ["reasoning", "code", "long-context"],
    },
  },
}
```

Then `panel` can be a _selector_ instead of a literal list:

```jsonc
"panel": {
  "pick": 3,
  "budgetUsd": 0.50,
  "minFamilies": 2,
  "prefer": ["reasoning", "code"],
  "thinking": "high"
}
```

Both forms stay valid — the array is the explicit escape hatch, the object is
the constraint solver. Selection itself is a small greedy pass over the
registry, not ML.

Falls out of the same registry, roughly in value order:

- **Preset axes.** `--fast`, `--cheap`, `--quality`, `--max`. OpenRouter ships
  the same idea as named presets (`general-fast`, Quality) on `openrouter/fusion`.
- **Pre-flight estimate.** `/fusion --estimate <prompt>` prints projected token
  cost per member before spending anything. Fan-out makes surprise bills real —
  a 5-member panel plus judge is 6 completions on one question.
- **Hard budget cap.** Abort rather than exceed `budgetUsd`. Report already
  computes actuals; this closes the loop.
- **Local win-rate.** `run-store.ts` already persists runs. Log which members
  the judge cited or picked, aggregate per model per repo. After ~30 runs you
  know which models actually earn their slot _here_ — no training, just counting.
  This is the honest, lazy version of the literature's reliability predictors.

---

## 4. Also worth stealing

**Split the analyst from the writer.** OpenRouter Fusion is three tiers, not two:
panel → an _analyst_ model that returns structured analysis JSON → the _outer
calling model_ writes the final answer from that analysis. `pi-fusion`'s judge
does both jobs in one pass. Splitting buys: machine-readable analysis over the
existing `fusion:rpc:v1`, a `--json` output mode, showing the disagreement map
_before_ the prose lands, and letting the writer be a cheaper model than the
analyst. Configurable as an optional `writer` block; default off, judge keeps
doing both.

**Emit the analysis as a record, not only prose.** `fusion-judge` already
produces exactly the right sections (Consensus, Disagreements, Unique Insights,
Blind Spots). Add a trailing `<fusion-analysis>{...}</fusion-analysis>` record
the same way `<fusion-panel-decision>` works today. Cheap, and it unlocks
everything programmatic: RPC consumers, run diffing, confidence scoring.

**Evidence diversity, not just prior diversity.** Panelist tools are hardcoded
to `read, grep, find, ls`. OpenRouter runs _every_ panel model with
`openrouter:web_search` and `openrouter:web_fetch` enabled — their panel disagrees
about retrieved facts, not just about priors. Letting one member have web access,
or a different tool set, or `context: "fork"` while others are `fresh`, is
probably the largest quality-per-line-of-code lever on this list.

**Verifier hook.** `verify: { command: "npm test" }` — score candidates by
something objective rather than judge taste. For code questions this beats
LLM ranking outright, and it is the precondition for anything search-shaped
(TreeQuest requires a score normalized to `[0,1]`; without one there is nothing
to search on).

**Cascade mode.** Tier 1 = one cheap model. If it returns `high` confidence and
`needsMoreEvidence: false`, stop and skip the judge entirely. Otherwise launch
the full panel. Cheaper to build than it looks: `decidePanelCompletion` already
returns `{kind: "complete"}` via `renderSinglePanelReport` when exactly one
panelist succeeded, so the skip-the-judge render path exists today. The gate
signals already exist in `PanelDecision`. On easy questions this turns a
6-completion run into a 1-completion run.

**One rebuttal round.** After the panel, each member sees the others' claims
anonymized and adjudicates them. Costs 2× the panel phase, and needs no new
concepts — just a second panel wave whose task template includes peer outputs.
The contract matters more than the mechanism: see §4c.

**Panel pipelines.** A profile as a sequence of stages — research panel → design
panel → review panel — each stage's report feeding the next. `fusion:rpc:v1`
already lets another extension drive this externally; making it a first-class
profile shape is mostly orchestrator state.

---

## 4b. Scanned, not borrowed

Martian, Not Diamond, RouteLLM, Portkey, Unify, Chorus were all looked at and
left out on purpose. They are **routers** — pick _one_ model per request from a
quality/cost/latency policy — not **panels**, which run several and synthesize.
Different category, and pi-fusion is deliberately on the panel side.

The one transferable idea is the per-request tradeoff knob, and it is already in
§3 as the preset axes (`--fast` / `--cheap` / `--quality` / `--max`). A router
mode would be a different product, not an improvement to this one.

---

## 4c. Debate — panelists seeing each other's answers

_В споре рождается истина_ — but the literature says it depends entirely on what
kind of argument you run. Splitting this into the version that is bad for this
product and the version that is good for it.

### What the evidence actually says

**The whole literature splits on which baseline was used.** Against one sample,
debate wins. Against _N independent samples aggregated at the same budget_, it
ties or loses almost everywhere. Most measured "debate" gains are ensembling, not
communication.

**Debate beats single-sample baselines:**

- **Du et al., [2305.14325](https://arxiv.org/abs/2305.14325)** — the original
  positive result. N instances "propose and debate their individual responses and
  reasoning processes over multiple rounds **to arrive at a common final answer**."
  Gains on math and strategic reasoning, better factual validity. The abstract
  positions self-consistency as complementary prior work, not as the head-to-head
  baseline.

**Debate does not beat compute-matched independent sampling:**

- **Smit et al., [2311.17371](https://arxiv.org/abs/2311.17371)** (ICML 2024) —
  "Multi-agent debating systems, **in their current form, do not reliably
  outperform** other proposed prompting strategies, such as self-consistency and
  ensembling using multiple reasoning paths." Also: MAD is "more sensitive to
  different hyperparameter settings and difficult to optimize," and tuned
  agent-agreement levels "even surpass all other non-debate protocols we
  evaluated."
- **Wang et al., [2402.18272](https://arxiv.org/abs/2402.18272)** (ACL 2024) — "a
  single-agent LLM with strong prompts can achieve almost the same performance as
  the best existing discussion approach"; multi-agent wins "only when there is no
  demonstration in the prompt."
- **Wang et al., "Reasoning in Token Economies"** (EMNLP 2024) — budget-aware:
  CoT self-consistency "frequently outperforms reasoning strategies proposed in
  the literature," and multi-agent debate **degrades** as token allocation grows
  while self-consistency does not.
- **ICLR 2025 blogpost** — 5 MAD frameworks × 9 benchmarks including HumanEval
  and MBPP, budget-matched against self-consistency: "most MAD frameworks cannot
  even perform better than CoT."
- **Choi, Zhu & Li, [2508.17536](https://arxiv.org/abs/2508.17536)** — decomposes
  MAD into voting + debate: "**Majority Voting alone accounts for most of the
  performance gains typically attributed to MAD.**" Theoretically, debate induces
  a **martingale** over belief trajectories, so "debate alone does not improve
  expected correctness." This is the single strongest line against the
  converge-to-consensus mode.
- **Bertalanič & Fortuna, [2605.00914](https://arxiv.org/abs/2605.00914)** —
  "Debate consumes 2.1–3.4× more tokens ... for equal or lower accuracy."
  Sycophantic modal adoption up to 85.5%; voting discards correct answers already
  present in the pool, oracle gap up to 32.3 pp.
- **Dong & Shigida, [2605.08478](https://arxiv.org/abs/2605.08478)** — 216
  Codeforces problems: "k-shot consistently achieves a better accuracy-cost and
  accuracy-query tradeoff." The closest thing to a coding-task verdict.

**Mechanism and failure modes:**

- **Zhang et al., [2310.02124](https://arxiv.org/abs/2310.02124)** — LLM agents
  "manifest human-like social behaviors, such as **conformity and consensus
  reaching**."
- **Wynn et al., [2509.05396](https://arxiv.org/abs/2509.05396)** — "debate can
  lead to a **decrease** in accuracy over time — even in settings where stronger
  models outnumber their weaker counterparts."
- **Cemri et al., [2503.13657](https://arxiv.org/abs/2503.13657)** (MAST, 1600+
  traces, 7 frameworks, includes coding) — MAS gains "often minimal"; one of three
  failure categories is **inter-agent misalignment**.

**Scalable-oversight strand — related, but do not merge it with the above.**
Its baselines are consultancy and blind QA, not compute-matched sampling.

- **Khan et al., [2402.06782](https://arxiv.org/abs/2402.06782)** (ICML 2024) —
  debate lifts non-expert models to 76% and humans to 88% vs 48%/60%. **Those
  baselines are blind-QA floors** — the judge cannot see the source text — not
  competitive baselines.
- **Kenton et al., [2407.04622](https://arxiv.org/abs/2407.04622)** (NeurIPS 2024) — replicates Khan, and finds debate beats QA-**without**-article but
  **not** QA-**with**-article. Without information asymmetry, "either small or no
  advantage to debate over QA without article."
- **Jiang et al., [2607.01251](https://arxiv.org/abs/2607.01251)** — Double
  Consultancy **49.2%** and Debate **49.2%**, identical. Showing the judge two
  _independent_ answers matched adversarial debate exactly.

Net: **converge-to-consensus debate is not contested — it is losing.** And the
adversarial strand's advantage is contingent on information asymmetry that
pi-fusion does not have (see below).

### Why the converge-to-consensus version is specifically wrong here

Independent of the benchmarks, it breaks this product's core signal.

The README's thesis is "errors are less correlated, so blind spots do not line up
perfectly" and "disagreement tells you where the answer is fragile". After round
one of open debate the panel's errors are correlated **by construction** — every
member has now read the same peer text. `fusion-judge`'s `Consensus` section
stops meaning _"N models independently reached this"_ and starts meaning _"they
talked and settled"_. That is a strictly worse report wearing a better report's
clothes, and nothing in the output would reveal the difference.

Combine that with Zhang's documented conformity and you get the specific failure:
a correct panelist abandons a correct answer because a peer stated a wrong one
more confidently. Independent panels cannot produce that failure. Debating ones
can.

### The version worth building: one adversarial rebuttal round

Not "discuss". A **rebuttal contract** with no room for opinion-merging. Each
panelist receives peer claims, anonymized, and must classify each one:

- `confirmed` — I checked this independently, here is my evidence
- `refuted` — this is wrong, here is `file:line` or a counter-example
- `out-of-scope` — I cannot evaluate it
- `retract` — I withdraw my own claim, and why

Output is a **claim-level ledger**, not a revised essay. This propagates
_evidence_, not persuasion — structurally the Khan setup rather than the Du setup.

**Correction to an earlier draft of this section.** It claimed this is "exactly
the regime where debate has evidence." That is wrong, and Kenton
[2407.04622](https://arxiv.org/abs/2407.04622) is why. Khan's advantage depends on
**information asymmetry** — the judge cannot see the source. pi-fusion's judge
_does_ receive the panelists' evidence, which puts it in Kenton's
QA-**with**-article condition, where debate showed "either small or no
advantage." Jiang [2607.01251](https://arxiv.org/abs/2607.01251) is blunter:
showing a judge two _independent_ answers scored identically to adversarial
debate (49.2% both). The verifiable-claim half of the Khan setup transfers here;
the information-asymmetry half does not, and that was the half doing the work.

So the rebuttal round's case rests on a **mechanism nobody has measured**, not on
the literature. State it that way and treat it accordingly.

### The cheaper idea this research produced: give the judge a verification budget

The problem is real: a large share of panel disagreement in a code repo is not
judgment, it is _one model read the file and another hallucinated the API_.
Today the judge gets both as competing prose and arbitrates on style.

But a rebuttal round is not the cheapest fix for it. **The judge already has
`read, grep, find, ls`.** It can check a contested claim itself. That is one
agent doing targeted verification on the handful of claims that actually
conflict — roughly `1/N` the cost of another full panel wave, with no conformity
surface at all, because no panelist ever sees another's text.

Jiang's result is the argument: if presenting a judge with two independent
answers already matches what adversarial debate achieves, then spending the extra
tokens on _the judge's ability to verify_ beats spending them on _panelists
arguing_.

Concretely: extend `fusion-judge`'s contract with a `Contested claims` pass —
list claims where panelists conflict, resolve each by direct inspection, cite
`file:line`, and mark anything it could not check. Cost is bounded by a
`verifyBudget` (max tool calls). This should be tried **before** the rebuttal
round, and it may well remove the reason to build one.

**The design rule that keeps it honest:** the judge must never see the
post-rebuttal state as consensus. It must see `original position → what changed →
why → who changed`. A model that changed under _evidence_ is a strong signal; a
model that changed under _confidence_ is the failure mode — and only the delta
distinguishes them. So persist both rounds and hand the judge the diff, never the
settled state. Smit's finding that agreement level is the decisive tunable argues
for making stubbornness explicit: instruct panelists to hold position unless
shown evidence, and make that a knob.

**One reason to expect this to work better here than in the papers.** A
pi-fusion panel is typically different model families, so priors start less
correlated and conformity has more to overcome. That is reasoning, not
measurement — nobody has measured it for this setup, the abstracts above do not
report panel composition, and it should not be stated as fact in user docs.

### Cost, and the decision rule

R rounds cost R× the panel phase, and Bertalanič measured 2.1–3.4× tokens "for
equal or lower accuracy." For pi-fusion the matched-cost comparison is not
self-consistency — it is **a wider panel**. 3 panelists × 2 rounds ≈ 6 panelists
× 1 round. Three candidates now, in ascending cost:

1. **Judge verification budget** — 1 agent, targeted checks. Cheapest, no
   conformity surface, and the literature's closest analogue (Jiang) says it
   should match debate.
2. **Wider panel** — buys genuinely new priors. Wins on open design questions,
   where a rebuttal round mostly buys agreement, which is what you least want.
3. **Rebuttal round** — most expensive, only plausible win is on evidence-bearing
   tasks, and that win is unmeasured.

Do 1 first. Only build 3 if 1 demonstrably leaves contested claims unresolved.

### The measurement gap, stated plainly

**No study compares debate against compute-matched independent sampling on
agentic code review with repo file access** — pi-fusion's actual workload. The
nearest neighbours are Codeforces problems (self-contained, no repo) and
HumanEval/MBPP. So this is genuinely unmeasured territory, which cuts both ways:
the negative results do not automatically transfer either. That makes a measured
A/B on this repo's own tasks the only defensible way to ship any debate mode, not
a nice-to-have.

Note also that nearly every number in this literature is single-run without seeds
or confidence intervals. Treat sub-3-point gaps as noise in both directions.

### One tension with the README worth naming

`README.md` states "This is evidence selection, not majority vote." The evidence
above makes majority vote the **strong** baseline, not the weak one — it is the
method that keeps winning these benchmarks, and Choi et al. find it accounts for
most of what gets attributed to debate.

That is still defensible for pi-fusion: open-ended code review has no single
extractable answer to vote on, so voting is not well-defined over the outputs.
But it is an untested design choice, not one this evidence supports. Worth
knowing before quoting the line as a principle.

### Implementation notes

- A rebuttal round is **another spawn wave**, not a chain step — see §0, chains
  abort on any nonzero child exit. Fusion's existing spawn → reconcile → spawn
  pattern already covers it.
- `steer` is reachable over the pi-subagents RPC (§0) though Fusion does not
  expose it. It could inject peer answers into a _live_ panelist without
  re-spawning, saving a re-read of the repo. **Reject it anyway** — steering a
  panelist mid-flight contaminates its answer while it is still forming its own
  position, so there is no clean round-one answer left to diff against. That
  destroys the delta view the design rule above depends on. Not a bias to
  mitigate; incompatible with the mechanism.
- `decidePanelCompletion` short-circuits at `panelOutputs.length === 1` and skips
  the judge. Under a debate mode that path needs a guard, same as under merge
  mode (§1).
- This supersedes the vaguer "refine round" bullet in §4 — same mechanism, but
  the rebuttal contract is what makes it defensible rather than a herding engine.

---

## 5. Deliberately not doing

- **Full AB-MCTS / tree search.** Dead on arrival without a programmatic scorer.
  Correct ordering is _verifier hook first, tree search maybe never_. The honest
  version for a CLI is "best-of-N with a verifier", not MCTS.
- **Trained per-instance reliability predictors, DSPy-style pipeline
  optimization, Elo tournaments.** Disproportionate for a 13k-LOC extension, and
  each needs a labeled set this project does not have. The win-rate counter in §3
  gets 80% of the value for ~50 lines.
- **Free-form multi-round debate that converges on a common answer.** See §4c —
  this is a narrower reject than it first looks, and the structured variant is
  worth building.
- **Majority vote.** The README already commits to "not majority vote — best
  evidence wins". Do not regress into it while adding consensus machinery.

---

## 6. One concrete defect found while reading

`formatPanelOutputs` presents panelists to the judge in fixed index order
(`comparePanelItems` sorts by `index`), labeled with their role name
(`## Architect`, `## Tester`).

Model identity is **not** leaked — that bias is already avoided. But:

- **Position bias** is live. LLM judges systematically favor first- or
  last-presented candidates. The order is currently deterministic, so the bias
  is deterministic too: the same member is advantaged on every run.
- **Role labels are authority cues.** "Architect" reads as more senior than
  "Tester" before a word of content is compared.

Fix is small: shuffle presentation order per run, and optionally present as
`Candidate A/B/C` with the mapping restored in the final report so the user
still sees who said what. Roughly 30 lines in `run-builder.ts` plus a report
change.

Seed the shuffle from `runId`, not `Math.random()`. `run-store.ts` persists runs
and `fusion:rpc:v1` exposes `adopt`/replay — a deterministic-per-run shuffle
keeps an old run reproducible when someone re-reads it.

---

## 7. Suggested order

> **Status:** items 1, 2 (static facets), 3, 4, 5b, and the tools work shipped on
> 2026-07-31 — see `docs/plans/completed/20260731-fusion-panel-modes-and-tools.md`.
> Item 6 (model registry) and everything gated on it were dropped: cost is not a
> constraint for this project. The rebuttal round remains unbuilt, as argued in §4c.


| #   | Item                                                                   | Effort | Value                        |
| --- | ---------------------------------------------------------------------- | ------ | ---------------------------- |
| 1   | Shuffle + optional blind labels for judge input (§6)                   | XS     | correctness                  |
| 2   | Static facet `question` + `fusion-composer` + `synthesis: merge` (§1a) | S      | high — answers the core ask  |
| 3   | `--panel a,b,c` inline override (§2a)                                  | XS     | ergonomics                   |
| 4   | `<fusion-analysis>` structured record (§4)                             | S      | unlocks RPC/JSON             |
| 5   | Cascade mode (§4) — reuses `PanelDecision`                             | S      | cost                         |
| 5b  | Judge verification budget (§4c)                                        | S      | resolves contested claims    |
| 6   | Model registry (§3)                                                    | M      | unblocks all budget work     |
| 7   | Per-member tools / web access (§4)                                     | M      | largest quality lever        |
| 8   | Selector-form `panel` + presets + `--estimate` (§3)                    | M      | the cost/speed ask           |
| 9   | Recruiter pass (§2b)                                                   | M      | the dynamic-panel ask        |
| 10  | Verifier hook (§4)                                                     | M      | objective scoring for code   |
| 11  | Dynamic facets via `fusion-scout` (§1b)                                | L      | after 2 proves out           |
| 12  | Panel pipelines (§4)                                                   | L      | later                        |
| —   | Adversarial rebuttal round (§4c)                                       | M      | **unmeasured — do 5b first** |

Items 1–5 need no new subsystem. Item 6 is the gate for 8 and 9.

The rebuttal round is deliberately unnumbered. Judge verification (5b) targets
the same failure at roughly `1/N` the cost with no conformity surface, and the
compute-matched literature says debate does not beat independent sampling. Build
it only if 5b ships and demonstrably leaves contested claims unresolved — and
then only behind an A/B against a matched-budget wider panel. It also wants
items 1 (blinding) and 4 (claim records) first: a rebuttal round without
anonymized structured claims is a herding engine.

---

## Sources

**Verified — pages fetched directly:**

- OpenRouter Fusion router (`openrouter/fusion`): panel → analyst → outer writer;
  params `analysis_models` (1–8, defaults to Quality preset of Claude Opus /
  GPT / Gemini Pro), `model` (analyst), `max_tool_calls` (default 8, range 1–16),
  `max_completion_tokens`, `reasoning`; every panel model runs with
  `openrouter:web_search` + `openrouter:web_fetch`.
  <https://openrouter.ai/docs/guides/routing/routers/fusion-router>
- OpenRouter Auto Router: cost/quality tradeoff selection, standard model
  pricing, no router fee. <https://openrouter.ai/docs/features/model-routing>
- Sakana AI, AB-MCTS / Multi-LLM AB-MCTS: go-wider vs go-deeper plus
  select-which-LLM; o4-mini + Gemini-2.5-Pro + R1-0528 beat each individually on
  ARC-AGI-2 (250-call budget, Pass@k). <https://sakana.ai/ab-mcts/>
- TreeQuest (Apache-2.0): `generate_fns` dict of per-LLM actions, score must be
  normalized to `[0,1]`, checkpointing for long runs.
  <https://github.com/SakanaAI/treequest>
- Anthropic multi-agent research system: orchestrator-worker; lead agent
  decomposes and spawns subagents per aspect, each with its own context window,
  compressing before returning.
  <https://www.anthropic.com/engineering/multi-agent-research-system>
- Multi-agent debate — five abstracts read directly, quoted in §4c:
  Du et al. [2305.14325](https://arxiv.org/abs/2305.14325) (positive, converge to
  common answer); Smit et al. [2311.17371](https://arxiv.org/abs/2311.17371)
  (does not reliably beat self-consistency; agreement level is the decisive
  tunable); Zhang et al. [2310.02124](https://arxiv.org/abs/2310.02124)
  (conformity and consensus-reaching are measured behaviours); Cemri et al.
  [2503.13657](https://arxiv.org/abs/2503.13657) (MAST — gains "often minimal",
  inter-agent misalignment is a top-level failure category); Khan et al.
  [2402.06782](https://arxiv.org/abs/2402.06782) (76%/88% vs 48%/60%, under
  assigned-side adversarial debate with information asymmetry and a weak judge).
  Only abstracts were read — not full method sections.
- The remaining §4c citations — Wang [2402.18272](https://arxiv.org/abs/2402.18272),
  Wang (EMNLP 2024 "Reasoning in Token Economies"), the ICLR 2025 MAD blogpost,
  Choi/Zhu/Li [2508.17536](https://arxiv.org/abs/2508.17536), Bertalanič
  [2605.00914](https://arxiv.org/abs/2605.00914), Dong & Shigida
  [2605.08478](https://arxiv.org/abs/2605.08478), Wynn
  [2509.05396](https://arxiv.org/abs/2509.05396), Kenton
  [2407.04622](https://arxiv.org/abs/2407.04622), Jiang
  [2607.01251](https://arxiv.org/abs/2607.01251) — come from a delegated web
  research pass that verified IDs and quote accuracy, but were not re-read here.
  Several are within months of this writing and unreplicated. Almost all numbers
  in this space are single-run without seeds or CIs; treat sub-3-point gaps as
  noise in either direction.
- `pi-subagents` internals (chain abort semantics, RPC surface) were read from
  the installed package at `~/.pi/agent/npm/node_modules/pi-subagents`.

**Unverified — from a Perplexity survey, directional only.** Specific paper
names, thresholds, and improvement figures it returned (Jury-on-Demand, AdaRubric,
RULERS, ATLAS, κ thresholds, "cost < 2–3×") were **not** independently checked and
some may be constructed. The general patterns they describe — dynamic jury
selection, provider-diversity constraints against correlated errors, adaptive
stopping, rubric-anchored scoring, position/verbosity/self-preference bias — are
well-established and are what §2, §3, and §6 lean on. Do not cite the numbers.
