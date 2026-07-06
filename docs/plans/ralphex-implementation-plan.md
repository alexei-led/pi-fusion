# RALPHEX implementation plan: subagent-native `pi-fusion`

Status: planning only. No implementation yet.

This replaces the current `synthetic-recon/pi-fusion` extension after it is uninstalled. No backward compatibility with its footer behavior, config shape, or direct model-call engine is required.

Docs checked:

- Context7 `/earendil-works/pi`: Pi TypeScript extension API, commands, tools, `setStatus`, `setWidget`, `appendEntry`.
- Context7 `/nicobailon/pi-subagents`: async runs, parallel runs, lifecycle artifacts, extension RPC.
- Context7 `/sinclairzx81/typebox`: TypeBox schemas for extension command/tool inputs.
- `gh` repo/issue reads for `synthetic-recon/pi-fusion`: issues #12, #13, #14.
- `gh` repo read for `nicobailon/pi-powerline-footer`: custom status items via `ctx.ui.setStatus`.

## R — Requirements

### Goals

- Provide explicit multi-model/subagent deliberation inside Pi.
- Use `pi-subagents` as the execution engine.
- Show progress through Pi status/widget APIs, not by owning the footer.
- Integrate cleanly with `pi-powerline-footer` via status key `fusion`.
- Support named profiles/panels from day one.
- Support reasoning effort by mapping profile `thinking` to subagent model/thinking settings.
- Produce a concise final Markdown report.
- Keep package, code, tests, docs, and license minimal.

### Non-goals for v1

- No direct OpenRouter Fusion API/server-tool integration.
- No direct model fan-out from this extension.
- No automatic `available` mode where the model decides to call fusion.
- No mutating panel agents by default.
- No recursive debates or nested subagent fanout.
- No cost dashboard or persistent run history beyond last-run metadata.
- No compatibility with the old `pi-fusion` config or footer renderer.

### Required extension

- `pi-subagents`
  - Used through its stable in-process RPC channels:
    - `subagents:rpc:v1:ready`
    - `subagents:rpc:v1:request`
    - `subagents:rpc:v1:reply:<requestId>`
  - Methods used: `ping`, `spawn`, `status`, `interrupt` or `stop`.

### Integrated extension

- `pi-powerline-footer`
  - No code dependency.
  - Reads `ctx.ui.setStatus("fusion", text)` when configured as a custom item.

Recommended user setting:

```json
{
  "powerline": {
    "preset": "default",
    "customItems": [
      {
        "id": "fusion",
        "statusKey": "fusion",
        "position": "right",
        "prefix": "fusion",
        "color": "accent"
      }
    ]
  }
}
```

## A — Architecture

### High-level design

```text
/fusion command
  -> load config/profile
  -> create FusionRun state
  -> spawn panel with pi-subagents RPC
  -> track panel status
  -> collect successful panel results
  -> spawn judge with pi-subagents RPC
  -> track judge status
  -> render final report
  -> publish status through ctx.ui.setStatus("fusion", ...)
```

### Why two-phase orchestration, not one subagent chain

A single `chain` with a parallel panel step and a judge step is simpler, but partial-failure continuation is not a safe assumption until verified against `pi-subagents` internals.

v1 should run two explicit phases:

1. Panel phase: one async parallel `spawn` with N panel tasks.
2. Judge phase: one async single `spawn` after successful panel outputs are known.

This makes partial failure behavior explicit:

- 0 successful panelists: fail run.
- 1 successful panelist: return single-panel report, no judge.
- 2+ successful panelists: run judge.

### Package modules

```text
src/index.ts             Pi extension entrypoint and command registration
src/commands.ts          /fusion, /fusion-status, /fusion-cancel, /fusion-init handlers
src/config.ts            Config loading, validation, defaults
src/types.ts             Domain types and constants
src/subagents-rpc.ts     Narrow RPC client for pi-subagents
src/run-store.ts         In-memory/session-backed active run state
src/run-builder.ts       Profile -> subagent spawn params
src/orchestrator.ts      Start panel, handle completions, start judge, finalize
src/status.ts            Footer/widget status formatting
src/report.ts            Final Markdown report rendering
src/result-extract.ts    Normalize pi-subagents status/result shapes
src/errors.ts            Error variants and formatting
src/utils.ts             Small pure helpers
```

### Runtime state

Use a discriminated union. Avoid boolean flag state.

```ts
export type FusionPhase =
  "idle" | "panel_running" | "judging" | "done" | "failed" | "cancelled";

export interface FusionRun {
  id: string;
  profileName: string;
  prompt: string;
  promptPreview: string;
  phase: FusionPhase;
  startedAt: number;
  updatedAt: number;
  panelRunId?: string;
  judgeRunId?: string;
  panelTotal: number;
  panelCompleted: number;
  panelFailed: number;
  report?: string;
  error?: string;
}
```

Persist only compact run metadata with `pi.appendEntry("fusion-run", ...)` so `/resume` can show the last known run and `/fusion-status` can recover context.

## L — Lifecycle

### Commands

#### `/fusion <prompt>`

Run default profile.

#### `/fusion --profile <name> <prompt>`

Run named profile.

Aliases:

- `-p <name>`

#### `/fusion-status`

Show:

- active/last run
- profile
- phase
- panel progress
- subagent run IDs
- final report path if known
- install/config warnings

#### `/fusion-cancel`

Stop active panel or judge run through `pi-subagents` RPC.

#### `/fusion-init`

Create `.pi/fusion.json` template after confirming overwrite. Project must be trusted.

### Status UX

Use only extension status/widget APIs.

```ts
ctx.ui.setStatus("fusion", "quality panel 1/3");
ctx.ui.setStatus("fusion", "quality judging");
ctx.ui.setStatus("fusion", "done");
ctx.ui.setStatus("fusion", undefined);
```

Optional compact widget while active:

```text
Fusion quality
panel: 2 done, 1 running, 0 failed
judge: pending
```

No `ctx.ui.setFooter(...)` calls.

### Event handling

Use `pi.events` for `pi-subagents` integration:

- On startup: `ping` subagents RPC.
- On `/fusion`: `spawn` panel run.
- On `subagent:async-complete`: if run ID matches active panel, collect results and maybe spawn judge.
- On `subagent:async-complete`: if run ID matches active judge, finalize report.
- On `/fusion-status`: call RPC `status` and refresh local status.

If event payload shape is not enough, use RPC `status` and lifecycle artifacts. Do not scrape TUI text.

## P — Plugin/package structure

### File tree

```text
pi-fusion/
  package.json
  package-lock.json
  tsconfig.json
  README.md
  LICENSE
  AGENTS.md
  agents/
    fusion-panelist.md
    fusion-judge.md
  src/
    index.ts
    commands.ts
    config.ts
    errors.ts
    orchestrator.ts
    report.ts
    result-extract.ts
    run-builder.ts
    run-store.ts
    status.ts
    subagents-rpc.ts
    types.ts
    utils.ts
    __tests__/
      args.test.ts
      config.test.ts
      report.test.ts
      result-extract.test.ts
      run-builder.test.ts
      status.test.ts
      subagents-rpc.test.ts
```

### `package.json`

```json
{
  "name": "@alexei/pi-fusion",
  "version": "0.1.0",
  "description": "Subagent-native multi-model deliberation for Pi",
  "type": "module",
  "main": "./src/index.ts",
  "license": "MIT",
  "engines": {
    "node": ">=22.19.0"
  },
  "keywords": [
    "pi-package",
    "pi-extension",
    "pi-subagents",
    "fusion",
    "multi-agent",
    "multi-model"
  ],
  "files": ["agents/*.md", "src/*.ts", "README.md", "LICENSE", "tsconfig.json"],
  "scripts": {
    "check": "tsc --noEmit",
    "test": "node --import jiti/register --test src/__tests__/*.test.ts",
    "pack:dry": "npm pack --dry-run"
  },
  "pi": {
    "extensions": ["./src/index.ts"],
    "subagents": {
      "agents": ["./agents"]
    }
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "jiti": "^2.4.0",
    "typescript": "^5.5.0"
  }
}
```

Notes:

- Use scoped package name if publishing because `pi-fusion` is already taken.
- No runtime dependencies unless implementation proves one is needed.
- `typebox` stays a peer because Pi provides it for extension schemas.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

## H — Hardening and boundaries

### Failure handling

- Missing `pi-subagents`: `/fusion` fails with install guidance.
- Missing profile: list valid profiles.
- Empty panel: config error.
- One active run exists: reject new run and show `/fusion-status` + `/fusion-cancel` hint.
- Panel all failed: final failed report with each error.
- Judge failed: final report includes raw panel summaries and judge error.
- Cancel: call `stop` first; fallback to `interrupt` if needed.
- Status extraction failure: show subagent run ID and artifact path; do not pretend success.

### Security defaults

- Panelist agent tools: read-only only.
- Judge agent tools: read-only or no mutating tools.
- No `bash`, `edit`, or `write` in bundled agents for v1.
- Prompt warns that panel models may receive prompt and read file contents when they inspect code.
- No project-local config unless `ctx.isProjectTrusted()`.

### Footer rule

Never call `ctx.ui.setFooter`. Fusion status is status text, not footer ownership.

## E — Code skeletons

### `src/index.ts`

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFusionCommands } from "./commands.ts";
import { createFusionOrchestrator } from "./orchestrator.ts";

export default function (pi: ExtensionAPI): void {
  const orchestrator = createFusionOrchestrator(pi);

  registerFusionCommands(pi, orchestrator);

  pi.on("session_start", async (_event, ctx) => {
    orchestrator.restore(ctx);
    orchestrator.refreshStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    orchestrator.clearUi(ctx);
  });

  pi.events.on("subagent:async-complete", async (event: unknown) => {
    await orchestrator.handleSubagentComplete(event);
  });
}
```

### `src/subagents-rpc.ts`

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RPC_VERSION = 1 as const;
const REQUEST_CHANNEL = "subagents:rpc:v1:request";

export type SubagentsMethod =
  "ping" | "spawn" | "status" | "interrupt" | "stop";

export interface RpcError {
  code?: string;
  message: string;
}

export type RpcReply<T> =
  | { version: 1; requestId: string; success: true; data: T }
  | { version: 1; requestId: string; success: false; error: RpcError };

export interface EventBusLike {
  on(channel: string, listener: (payload: unknown) => void): unknown;
  emit(channel: string, payload: unknown): void;
  off?(channel: string, listener: (payload: unknown) => void): void;
  removeListener?(channel: string, listener: (payload: unknown) => void): void;
}

export interface SubagentsRpcClient {
  request<T>(
    method: SubagentsMethod,
    params: unknown,
    timeoutMs?: number,
  ): Promise<T>;
}

export function createSubagentsRpcClient(
  pi: Pick<ExtensionAPI, "events">,
): SubagentsRpcClient {
  return createSubagentsRpcClientFromBus(pi.events as EventBusLike);
}

export function createSubagentsRpcClientFromBus(
  bus: EventBusLike,
): SubagentsRpcClient {
  return {
    request<T>(method, params, timeoutMs = 10_000): Promise<T> {
      const requestId = crypto.randomUUID();
      const replyChannel = `subagents:rpc:v1:reply:${requestId}`;

      return new Promise<T>((resolve, reject) => {
        let settled = false;
        let subscription: unknown;

        const cleanup = (): void => {
          if (typeof subscription === "function") {
            subscription();
            return;
          }
          bus.off?.(replyChannel, onReply);
          bus.removeListener?.(replyChannel, onReply);
        };

        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          fn();
        };

        const onReply = (payload: unknown): void => {
          const reply = payload as Partial<RpcReply<T>>;
          if (reply.requestId !== requestId) return;
          if (reply.success === true) {
            finish(() => resolve(reply.data as T));
            return;
          }
          const message =
            reply.success === false
              ? (reply.error?.message ?? "subagents RPC failed")
              : "invalid subagents RPC reply";
          finish(() => reject(new Error(message)));
        };

        const timer = setTimeout(() => {
          finish(() => reject(new Error(`subagents RPC ${method} timed out`)));
        }, timeoutMs);

        subscription = bus.on(replyChannel, onReply);
        bus.emit(REQUEST_CHANNEL, {
          version: RPC_VERSION,
          requestId,
          method,
          params,
        });
      });
    },
  };
}
```

### `src/config.ts`

```ts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FusionConfig, FusionProfile } from "./types.ts";

export const DEFAULT_CONFIG_FILE = "fusion.json";

export function loadFusionConfig(
  cwd: string,
  projectTrusted: boolean,
): FusionConfig {
  const paths = [
    ...(projectTrusted ? [join(cwd, ".pi", DEFAULT_CONFIG_FILE)] : []),
    join(getAgentDir(), DEFAULT_CONFIG_FILE),
  ];

  for (const path of paths) {
    if (!existsSync(path)) continue;
    return parseConfig(readFileSync(path, "utf8"), path);
  }

  return defaultConfig();
}

export function resolveProfile(
  config: FusionConfig,
  requested?: string,
): { name: string; profile: FusionProfile } {
  const name = requested ?? config.defaultProfile;
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(
      `Unknown fusion profile '${name}'. Available: ${Object.keys(config.profiles).join(", ")}`,
    );
  }
  if (profile.panel.length === 0)
    throw new Error(`Fusion profile '${name}' has no panel members.`);
  return { name, profile };
}

function parseConfig(text: string, path: string): FusionConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return normalizeConfig(raw, path);
}

function normalizeConfig(raw: unknown, path: string): FusionConfig {
  // Implement with narrow type guards, not broad casts.
  // Keep validation close to this JSON boundary.
  // Return a fully defaulted domain config.
  throw new Error(`normalizeConfig not implemented yet for ${path}`);
}

export function defaultConfig(): FusionConfig {
  return {
    defaultProfile: "quality",
    profiles: {
      quality: {
        panel: [
          {
            id: "architect",
            label: "Architect",
            agent: "pi-fusion.fusion-panelist",
            role: "architecture and tradeoffs",
          },
          {
            id: "critic",
            label: "Critic",
            agent: "pi-fusion.fusion-panelist",
            role: "risks and simplification",
          },
          {
            id: "implementer",
            label: "Implementer",
            agent: "pi-fusion.fusion-panelist",
            role: "implementation practicality",
          },
        ],
        judge: { agent: "pi-fusion.fusion-judge" },
        concurrency: 3,
        timeoutMs: 300_000,
        context: "fresh",
      },
    },
  };
}
```

### `src/types.ts`

```ts
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface PanelMemberConfig {
  id: string;
  label?: string;
  agent: string;
  model?: string;
  thinking?: ThinkingLevel;
  role?: string;
}

export interface JudgeConfig {
  agent: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface FusionProfile {
  panel: PanelMemberConfig[];
  judge: JudgeConfig;
  concurrency?: number;
  timeoutMs?: number;
  context?: "fresh" | "fork";
}

export interface FusionConfig {
  defaultProfile: string;
  profiles: Record<string, FusionProfile>;
}
```

### `src/run-builder.ts`

```ts
import type { FusionProfile, PanelMemberConfig } from "./types.ts";

export interface SubagentTaskParams {
  agent: string;
  task: string;
  model?: string;
  label?: string;
  phase?: string;
  progress?: boolean;
}

export interface PanelSpawnParams {
  tasks: SubagentTaskParams[];
  concurrency: number;
  context: "fresh" | "fork";
  async: true;
  timeoutMs?: number;
}

export function buildPanelSpawnParams(
  profile: FusionProfile,
  prompt: string,
): PanelSpawnParams {
  return {
    async: true,
    context: profile.context ?? "fresh",
    concurrency: profile.concurrency ?? Math.min(profile.panel.length, 3),
    timeoutMs: profile.timeoutMs,
    tasks: profile.panel.map((member) => ({
      agent: member.agent,
      label: member.label ?? member.id,
      phase: "panel",
      model: modelWithThinking(member.model, member.thinking),
      progress: true,
      task: buildPanelTask(member, prompt),
    })),
  };
}

function buildPanelTask(member: PanelMemberConfig, prompt: string): string {
  return [
    `You are panel member '${member.label ?? member.id}' in a pi-fusion run.`,
    member.role ? `Role focus: ${member.role}` : undefined,
    "Work independently. Do not assume other panelists agree.",
    "Return concise Markdown with: Summary, Recommendation, Evidence, Risks, Confidence, Open Questions.",
    "Do not modify project/source files.",
    "",
    "Task:",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

export function modelWithThinking(
  model: string | undefined,
  thinking: string | undefined,
): string | undefined {
  if (!model || !thinking || thinking === "off") return model;
  return /:(minimal|low|medium|high|xhigh)$/.test(model)
    ? model
    : `${model}:${thinking}`;
}
```

### `src/status.ts`

```ts
import type { FusionRun } from "./run-store.ts";

export function footerText(run: FusionRun | undefined): string | undefined {
  if (!run) return undefined;
  switch (run.phase) {
    case "panel_running":
      return `${run.profileName} panel ${run.panelCompleted}/${run.panelTotal}`;
    case "judging":
      return `${run.profileName} judging`;
    case "done":
      return `${run.profileName} done`;
    case "failed":
      return `${run.profileName} failed`;
    case "cancelled":
      return `${run.profileName} cancelled`;
    case "idle":
      return undefined;
  }
}
```

### `agents/fusion-panelist.md`

```md
---
name: fusion-panelist
package: pi-fusion
description: Independent read-only panel member for pi-fusion deliberation.
tools: read, grep, find, ls
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
completionGuard: false
---

You are a pi-fusion panelist.

Work independently. Inspect relevant local files when the task needs code evidence.
Do not edit files. Do not ask other agents. Do not run subagents.

Return concise Markdown:

## Summary

## Recommendation

## Evidence

## Risks

## Confidence

## Open Questions
```

### `agents/fusion-judge.md`

```md
---
name: fusion-judge
package: pi-fusion
description: Judge and synthesizer for pi-fusion panel outputs.
tools: read
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
completionGuard: false
---

You are the pi-fusion judge.

Compare panel outputs. Do not invent consensus. If panelists disagree, preserve the disagreement.
Prefer the smallest realistic recommendation.

Return final Markdown:

# Fusion Report

## Summary

## Consensus

## Disagreements

## Unique Insights

## Blind Spots

## Recommendation

## Risks

## Next Step
```

## X — Execution plan and tests

### Phase 1 — package skeleton

Files:

- `package.json`
- `tsconfig.json`
- `LICENSE`
- `README.md`
- `agents/fusion-panelist.md`
- `agents/fusion-judge.md`
- empty `src/index.ts`

Checks:

```bash
npm install
npm run check
npm run test
npm run pack:dry
```

### Phase 2 — config and argument parsing

Implement:

- `parseFusionArgs(args)`
- `loadFusionConfig(cwd, trusted)`
- `resolveProfile(config, requested)`
- `.pi/fusion.json` template writer

Tests:

- default config has `quality` profile
- project config wins only when trusted
- unknown profile errors with available names
- empty panel errors
- `--profile fast prompt` parses
- `-p fast prompt` parses
- prompt with `--` content is preserved

### Phase 3 — subagents RPC client

Implement:

- `createSubagentsRpcClient`
- `ping`
- request timeout
- failed reply handling
- cleanup on reply/timeout

Tests:

- emits correct request envelope
- resolves success reply
- rejects failure reply
- ignores wrong request IDs
- rejects timeout and removes listener

### Phase 4 — run builder

Implement:

- profile -> panel spawn params
- thinking suffix helper
- judge task builder

Tests:

- creates one task per panel member
- caps/defaults concurrency
- passes `context: fresh`
- appends `:high`/`:xhigh` thinking suffix
- does not double-append thinking suffix
- tasks include role and no-edit instruction

### Phase 5 — orchestrator

Implement:

- single active run guard
- start panel
- handle panel completion
- start judge when 2+ successes
- return one-result report when 1 success
- fail when 0 successes
- cancel active run
- restore compact run state on session start

Tests:

- missing subagents ping fails with install message
- start run sets footer status
- active run blocks second run
- panel completion with 0 successes fails
- panel completion with 1 success skips judge
- panel completion with 2 successes spawns judge
- judge completion renders final report
- cancel calls `stop` for active run ID

### Phase 6 — result extraction

Implement a normalizer around `pi-subagents` status data. Keep raw input `unknown` until narrowed.

Tests use fixtures, not real subagent runs:

- extracts successful child outputs
- extracts failed child errors
- handles missing optional fields
- surfaces artifact paths when content missing
- never throws on unknown status shape; returns a typed error variant

### Phase 7 — UI and reporting

Implement:

- `ctx.ui.setStatus("fusion", ...)`
- optional `ctx.ui.setWidget("fusion-panel", ...)`
- custom message renderer only if needed
- Markdown final report renderer

Tests:

- footer text for all phases
- widget hides when no run
- report includes failed panelists
- report includes judge error fallback
- report is deterministic for snapshot-style assertion

### Phase 8 — live smoke checks

Manual checks after unit tests pass:

```bash
pi install /path/to/pi-fusion
pi install npm:pi-subagents
pi install npm:pi-powerline-footer
```

Then in Pi:

```text
/reload
/fusion-init
/fusion-status
/fusion Compare two approaches for this extension.
/fusion --profile quality Review this design for scope creep.
/fusion-cancel
```

Expected:

- one footer/status item only
- no duplicate footer block
- subagent async widget shows panel work
- `/fusion-status` shows run IDs
- final report appears once
- failed panelists are visible in report

## Minimal README outline

```md
# pi-fusion

Subagent-native multi-model deliberation for Pi.

## Requires

- pi-subagents

## Integrates with

- pi-powerline-footer through status key `fusion`

## Install

pi install /path/to/pi-fusion

## Usage

/fusion <prompt>
/fusion --profile quality <prompt>
/fusion-status
/fusion-cancel
/fusion-init

## Config

See `.pi/fusion.json`.

## Notes

Panel agents are read-only by default. Prompts and inspected file contents may be sent to configured model providers.
```

## MIT license file

Use the standard MIT license text with copyright owner:

```text
MIT License

Copyright (c) 2026 Alexei Ledenev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Acceptance criteria

- `npm run check` passes.
- `npm test` passes.
- `npm run pack:dry` includes only intended files.
- `/fusion-init` writes trusted project config only after confirmation.
- `/fusion <prompt>` starts a `pi-subagents` parallel panel run.
- `/fusion-status` shows active run and profile.
- `/fusion-cancel` stops active panel/judge run.
- `pi-powerline-footer` shows one `fusion` custom item when configured.
- The extension never calls `ctx.ui.setFooter`.
- Final report is clear and includes partial failures.
