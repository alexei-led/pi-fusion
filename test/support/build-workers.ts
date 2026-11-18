import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { prepareGitTemplates } from './git-fixtures.js';

export async function buildWorkerFixtures() {
  // Emitted ESM imports runtime peers from the repo's node_modules.
  const cache = resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'pi-fusion-workers-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  const templates = join(directory, 'git-templates');
  try {
    await prepareGitTemplates(templates);
    await promisify(execFile)(
      process.execPath,
      [
        'node_modules/typescript/bin/tsc',
        '--project',
        'tsconfig.test-workers.json',
        '--outDir',
        directory,
      ],
      { timeout: 60_000 },
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    templates,
    worker: (name: 'shared-admission' | 'stale-recovery') =>
      join(directory, 'test', 'support', `${name}-worker.js`),
    cleanup,
  };
}
