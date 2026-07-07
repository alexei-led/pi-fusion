import assert from "node:assert/strict";
import test from "node:test";
import {
  registerFusionCommands,
  type FusionRuntimeCommandHandler,
} from "../../src/commands.js";
import type { ParsedFusionArgs } from "../../src/types.js";

test("registerFusionCommands forwards non-inline args unchanged to startRun", async () => {
  let command:
    | {
        handler(
          args: string,
          ctx: { ui: { notify(message: string): void } },
        ): Promise<void>;
      }
    | undefined;
  const startRunCalls: string[] = [];
  const notifications: string[] = [];
  const handler: FusionRuntimeCommandHandler = {
    startRun: async (args: string | ParsedFusionArgs) => {
      if (typeof args !== "string") {
        throw new Error("expected string args");
      }
      startRunCalls.push(args);
    },
    showStatus: async () => undefined,
    cancelActiveRun: async () => undefined,
  };

  registerFusionCommands(
    {
      registerCommand: (_name, definition) => {
        command = definition;
      },
    },
    handler,
  );

  assert.ok(command);
  await command.handler("--profile fast compare APIs", {
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  });

  assert.deepEqual(startRunCalls, ["--profile fast compare APIs"]);
  assert.deepEqual(notifications, []);
});
