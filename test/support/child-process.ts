import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { TestContext } from 'vitest';

export function isolatedProcessEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(cwd, 'home'),
    TMPDIR: cwd,
    PI_CODING_AGENT_DIR: join(cwd, 'agent'),
    PI_OFFLINE: '1',
  };
}

export function observeChild(
  t: TestContext,
  child: ChildProcess,
  label: string,
  allowedCodes: readonly number[] = [0],
) {
  let stderr = '';
  let launchError: Error | undefined;
  let notified = false;
  child.stdout?.resume();
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('error', (error) => {
      launchError = error;
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const failure = (code: number | null, signal: NodeJS.Signals | null) =>
    new Error(
      `${label} exited ${code ?? signal}: ${launchError?.message ?? stderr}`,
    );
  const announced = new Promise<void>((resolve) => {
    child.once('message', () => {
      notified = true;
      resolve();
    });
  });
  t.onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await closed;
  });
  return {
    get ready() {
      return Promise.race([
        announced,
        closed.then(({ code, signal }) => {
          if (!notified) throw failure(code, signal);
        }),
      ]);
    },
    get exited() {
      return closed.then(({ code, signal }) => {
        if (launchError || code === null || !allowedCodes.includes(code))
          throw failure(code, signal);
        return code;
      });
    },
  };
}
