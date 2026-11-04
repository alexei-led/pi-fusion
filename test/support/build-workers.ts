import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareGitTemplates } from './git-fixtures.js';

export default async function buildWorkers(): Promise<() => Promise<void>> {
  const agentDir = await mkdtemp(join(tmpdir(), 'fusion-test-agent-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const templates = join(agentDir, 'git-templates');
  process.env.PI_FUSION_TEST_GIT_TEMPLATES = templates;
  await prepareGitTemplates(templates);
  await mkdir(join(agentDir, 'extensions/subagent'), { recursive: true });
  await writeFile(
    join(agentDir, 'extensions/subagent/config.json'),
    '{"autoResume":false}',
  );
  await promisify(execFile)(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--project',
      'tsconfig.test-workers.json',
    ],
    { timeout: 60_000 },
  );
  return () => rm(agentDir, { recursive: true, force: true });
}
