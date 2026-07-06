import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerFusionCommands,
  registerFusionInitCommand,
} from "./commands.js";
import {
  FusionOrchestrator,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
} from "./orchestrator.js";
import { FusionRunStore } from "./run-store.js";
import { SubagentsRpcClient } from "./subagents-rpc.js";

export default function fusionExtension(pi: ExtensionAPI): void {
  const orchestrator = new FusionOrchestrator({
    rpc: new SubagentsRpcClient({ events: pi.events }),
    runStore: new FusionRunStore({ persistence: pi }),
    sendMessage: (message) => pi.sendMessage(message),
  });

  registerFusionCommands(pi, orchestrator);
  registerFusionInitCommand(pi);

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
    if (typeof unsubscribeComplete === "function") unsubscribeComplete();
  });
}
