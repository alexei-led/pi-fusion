import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { FusionMessageSink } from './orchestrator.js';

/** Idle custom-message turns skip before_agent_start; use the normal prompt path. */
export function createFusionMessageSink(
  pi: Pick<ExtensionAPI, 'sendMessage' | 'sendUserMessage'>,
  getContext: () => { isIdle?(): boolean } | undefined,
): FusionMessageSink['sendMessage'] {
  return (message, options) => {
    if (options?.triggerTurn && getContext()?.isIdle?.()) {
      pi.sendMessage(message, { triggerTurn: false });
      pi.sendUserMessage('Fusion update above.', {
        deliverAs: options.deliverAs,
      });
    } else {
      pi.sendMessage(message, options);
    }
  };
}
