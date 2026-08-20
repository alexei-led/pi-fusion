import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerFusionCommands } from "./commands.js";
import {
  FusionOrchestrator,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type FusionCommandContext,
} from "./orchestrator.js";
import { registerFusionRpc } from "./fusion-rpc.js";
import { FusionRunStore } from "./run-store.js";
import {
  AutoDetectingAdapter,
  TINTINWEB_COMPLETED_EVENT,
  TINTINWEB_FAILED_EVENT,
} from "./subagent-adapter.js";

function registerFusionTool(
  pi: ExtensionAPI,
  orchestrator: FusionOrchestrator,
): void {
  pi.registerTool({
    name: "start_fusion_review",
    label: "Fusion Review",
    description:
      "Start a pi-fusion review. Several models answer in parallel, then one synthesis step returns a single report. Use it for a hard decision, a design tradeoff, a risk or release review, tricky debugging, a research-heavy question, or a breadth sweep such as an audit or 'what did we miss'. Do not use it for routine edits, formatting, or obvious one-step fixes.",
    promptSnippet: "Start a fusion panel review for a topic or code",
    promptGuidelines: [
      "Use start_fusion_review only for hard decisions, design tradeoffs, risk review, tricky debugging, research-heavy questions, or breadth sweeps such as audits. Do not use it for routine edits, formatting, or obvious one-step fixes.",
      "Pass panel only when the user names the models to compare. Otherwise omit it and let the profile decide.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "What to review or discuss" }),
      profile: Type.Optional(
        Type.String({ description: "Fusion profile name (optional)" }),
      ),
      panel: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Models to use for this run, overriding the profile panel. Each entry is <model> or <agent>:<model>. Use only when the user names specific models.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await orchestrator.startRun(
        {
          prompt: params.prompt,
          ...(params.profile ? { profile: params.profile } : {}),
          ...(params.panel?.length ? { panel: params.panel } : {}),
        },
        ctx,
      );
      const text =
        result.status === "started"
          ? "Fusion panel review started. The report will be posted when the panel and judge finish."
          : result.status === "conflict"
            ? `A fusion run is already active (${result.activeRunId}). Do not start another; wait for its report.`
            : `Fusion review failed to start: ${result.status === "failed" ? result.error : result.status}`;
      return {
        content: [{ type: "text", text }],
        details: {
          prompt: params.prompt,
          profile: params.profile,
          panel: params.panel,
          status: result.status,
        },
      };
    },
  });
}

export default function fusionExtension(pi: ExtensionAPI): void {
  const store = new FusionRunStore({ persistence: pi });
  let sessionContext: FusionCommandContext | undefined;
  const adapter = new AutoDetectingAdapter({ events: pi.events });
  const orchestrator = new FusionOrchestrator({
    adapter,
    runStore: store,
    sendMessage: (message) => pi.sendMessage(message),
  });

  registerFusionCommands(pi, orchestrator);
  registerFusionTool(pi, orchestrator);

  const unsubscribeComplete = pi.events.on(
    SUBAGENT_ASYNC_COMPLETE_EVENT,
    (payload) => {
      void orchestrator.handleSubagentComplete(payload);
    },
  );
  const unsubTintinCompleted = pi.events.on(
    TINTINWEB_COMPLETED_EVENT,
    (payload) => {
      void orchestrator.handleSubagentComplete(payload);
    },
  );
  const unsubTintinFailed = pi.events.on(
    TINTINWEB_FAILED_EVENT,
    (payload) => {
      void orchestrator.handleSubagentComplete(payload);
    },
  );
  const unsubscribeRpc = registerFusionRpc({
    events: pi.events,
    orchestrator,
    store,
    getContext: () => sessionContext,
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    await orchestrator.restore(ctx);
  });

  pi.on("session_shutdown", () => {
    sessionContext = undefined;
    orchestrator.clearUi();
    orchestrator.dispose();
    adapter.dispose();
    if (typeof unsubscribeComplete === "function") unsubscribeComplete();
    if (typeof unsubTintinCompleted === "function") unsubTintinCompleted();
    if (typeof unsubTintinFailed === "function") unsubTintinFailed();
    unsubscribeRpc();
  });
}
