import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createFusionMessageSink } from '../../src/completion-wake.js';

for (const idle of [true, false]) {
  for (const triggerTurn of [true, false]) {
    test(`Fusion wake uses prompt preparation only when idle=${idle}, requested=${triggerTurn}`, () => {
      const messages: unknown[] = [];
      const prompts: unknown[] = [];
      const send = createFusionMessageSink(
        {
          sendMessage(message, options) {
            messages.push({ message, options });
          },
          sendUserMessage(message, options) {
            prompts.push({ message, options });
          },
        },
        () => ({ isIdle: () => idle }),
      );
      const message = {
        customType: 'fusion-report',
        content: 'Report',
        display: true,
      };
      send(message, { triggerTurn, deliverAs: 'followUp' });
      assert.deepEqual(messages, [
        {
          message,
          options:
            idle && triggerTurn
              ? { triggerTurn: false }
              : { triggerTurn, deliverAs: 'followUp' },
        },
      ]);
      assert.deepEqual(
        prompts,
        idle && triggerTurn
          ? [
              {
                message: 'Fusion update above.',
                options: { deliverAs: 'followUp' },
              },
            ]
          : [],
      );
    });
  }
}
