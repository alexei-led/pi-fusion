import type { TestContext } from 'vitest';
import fusionExtension from '../../src/index.js';
import { createProjectDir, FakePi, nextTick } from './fake-pi.js';

export async function mountFusion(
  t: TestContext,
  options: { pi?: FakePi; restoreSession?: boolean } = {},
) {
  const pi = options.pi ?? new FakePi();
  const cwd = await createProjectDir(t);
  const ctx = pi.createContext(cwd);
  fusionExtension(pi.asExtensionApi());
  let shutdown = false;
  const close = async () => {
    if (shutdown) return;
    shutdown = true;
    await pi.emitLifecycle('session_shutdown', {}, ctx);
  };
  t.onTestFinished(close);
  if (options.restoreSession !== false)
    await pi.emitLifecycle('session_start', {}, ctx);
  return {
    pi,
    cwd,
    ctx,
    close,
    start: () => pi.runCommand('fusion', 'review', ctx),
    complete: async (runId = 'panel-1') => {
      pi.events.emit('subagent:async-complete', { runId });
      await nextTick();
    },
  };
}
