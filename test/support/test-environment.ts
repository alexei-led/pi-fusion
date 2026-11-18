import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default async function setup(): Promise<() => Promise<void>> {
  const agentDir = await mkdtemp(join(tmpdir(), 'fusion-test-agent-'));
  const cleanup = () => rm(agentDir, { recursive: true, force: true });
  try {
    const config = join(agentDir, 'extensions', 'subagent');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'config.json'), '{"autoResume":false}');
  } catch (error) {
    await cleanup();
    throw error;
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await cleanup();
  };
}
