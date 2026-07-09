import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerFusionCommands } from "./commands.js";
import {
  FusionOrchestrator,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
} from "./orchestrator.js";
import { FusionRunStore } from "./run-store.js";
import { SubagentsRpcClient } from "./subagents-rpc.js";

function registerFusionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "start_fusion_review",
    label: "Fusion Review",
    description:
      "Start a pi-fusion multi-model panel review. Use when the user asks to invoke fusion, run a panel review, get multi-model opinions, or discuss something through the fusion panel.",
    promptSnippet: "Start a fusion panel review for a topic or code",
    promptGuidelines: [
      "Use start_fusion_review when the user says 'invoke fusion', 'run fusion', 'fusion panel', 'multi-model review', 'panel review', or similar.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "What to review or discuss" }),
      profile: Type.Optional(
        Type.String({ description: "Fusion profile name (optional)" }),
      ),
    }),
    execute(_toolCallId, params) {
      const cmd = params.profile
        ? `/fusion --profile ${params.profile} ${params.prompt}`
        : `/fusion ${params.prompt}`;
      pi.sendUserMessage(cmd, { deliverAs: "followUp" });
      return Promise.resolve({
        content: [{ type: "text", text: "Starting fusion panel review…" }],
        details: { prompt: params.prompt, profile: params.profile },
      });
    },
  });
}

export default function fusionExtension(pi: ExtensionAPI): void {
  const orchestrator = new FusionOrchestrator({
    rpc: new SubagentsRpcClient({ events: pi.events }),
    runStore: new FusionRunStore({ persistence: pi }),
    sendMessage: (message) => pi.sendMessage(message),
  });

  registerFusionCommands(pi, orchestrator);
  registerFusionTool(pi);

  const unsubscribeComplete = pi.events.on(
    SUBAGENT_ASYNC_COMPLETE_EVENT,
    (payload) => {
      void orchestrator.handleSubagentComplete(payload);
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    await orchestrator.restore(ctx);
  });

  pi.on("session_shutdown", () => {
    orchestrator.clearUi();
    orchestrator.dispose();
    if (typeof unsubscribeComplete === "function") unsubscribeComplete();
  });
}
