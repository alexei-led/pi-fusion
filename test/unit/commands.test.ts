import assert from "node:assert/strict";
import test from "node:test";
import {
  registerFusionCommands,
  type FusionRuntimeCommandHandler,
} from "../../src/commands.js";
import type { ParsedFusionArgs } from "../../src/types.js";

test("deadline commands route decisions without starting a new run", async () => {
  let command: { handler(args: string, ctx: { ui: { notify(message: string): void } }): Promise<void> } | undefined;
  const decisions: unknown[][] = [];
  const notices: string[] = [];
  registerFusionCommands({ registerCommand: (_name, definition) => { command = definition; } }, {
    startRun: async () => { assert.fail("A deadline command must not spawn work"); },
    showStatus: async () => undefined,
    cancelActiveRun: async () => undefined,
    resolvePanelDeadline: async (...args) => { decisions.push(args); },
  });
  assert.ok(command);
  const ctx = { ui: { notify: (message: string) => { notices.push(message); } } };
  await command.handler("continue fusion-id 2", ctx);
  await command.handler("finish fusion-id 1", ctx);
  await command.handler("continue fusion-id 0", ctx);
  assert.deepEqual(decisions, [["fusion-id", 2, "continue"], ["fusion-id", 1, "finish"]]);
  assert.match(notices.at(-1) ?? "", /Use \/fusion/);
});

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
