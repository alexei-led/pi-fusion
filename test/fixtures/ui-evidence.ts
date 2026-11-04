import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function uiEvidence(pi: ExtensionAPI): void {
  const path = process.env.PI_FUSION_VALIDATION_EVIDENCE;
  if (!path) return;
  const record = (data: object) =>
    appendFileSync(path, `${JSON.stringify(data)}\n`);
  pi.on('session_start', (_event, ctx) =>
    record({
      event: 'session_start',
      sessionId: ctx.sessionManager.getSessionId(),
    }),
  );
  pi.on('session_shutdown', (_event, ctx) =>
    record({
      event: 'session_shutdown',
      sessionId: ctx.sessionManager.getSessionId(),
    }),
  );
  pi.registerCommand('fusion-test-idle-wake', {
    description: 'Isolated validation only: native idle custom-message wake',
    handler: async () => {
      pi.sendMessage(
        {
          customType: 'fusion-report',
          content:
            '# Fusion Report\n## Summary\nNative idle-wake probe only; no Fusion review was started.',
          display: true,
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
    },
  });
  pi.on('before_agent_start', (event, ctx) =>
    record({
      event: 'before_agent_start',
      sessionId: ctx.sessionManager.getSessionId(),
      messageType: event.messageType,
      ...(event.messageType === 'custom'
        ? { customType: event.message.customType }
        : {}),
    }),
  );
  pi.on('agent_settled', (event, ctx) =>
    record({
      event: 'agent_settled',
      sessionId: ctx.sessionManager.getSessionId(),
      aborted: event.aborted,
    }),
  );
}
