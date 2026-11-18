import { debuglog } from 'node:util';
import type { FusionRun } from './types.js';

const debug = debuglog('pi-fusion');

// Only callers' metadata projections go here, never wire payloads or errors.
export function traceFusion(
  event: string,
  run: FusionRun,
  fields: () => object = () => ({}),
): void {
  if (!debug.enabled) return;
  debug(
    '%s',
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      runId: traceId(run.id),
      phase: run.phase,
      ...fields(),
    }),
  );
}

export function traceId(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

export function traceFailureKind(message: string | undefined): string {
  if (!message) return 'unknown';
  const text = message.slice(0, 1024);
  if (
    /oauth.*(?:refresh|expired)|authentication|unauthorized|not signed in|(?:http|status[=:]?)\s*401\b/i.test(
      text,
    )
  )
    return 'authentication';
  if (/model not found|unknown model/i.test(text)) return 'model-unavailable';
  if (
    /required (?:child extension|tools?)|tool allowlist|tools?.*replaced/i.test(
      text,
    )
  )
    return 'child-tools';
  if (/maximum output length|response was truncated/i.test(text))
    return 'truncated';
  if (/timed out|timeout/i.test(text)) return 'timeout';
  return 'unknown';
}
