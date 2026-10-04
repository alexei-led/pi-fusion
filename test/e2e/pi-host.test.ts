import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { onTestFinished, test } from 'vitest';

test('Fusion loads and runs a command in an isolated Pi SDK session', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-fusion-host-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, 'agent');
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(agentDir, 'models-cache.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [resolve('src/index.ts')],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  onTestFinished(() => session.dispose());
  await session.bindExtensions({});

  const tools = session.getAllTools();
  for (const name of ['start_fusion_review', 'resolve_fusion_deadline']) {
    assert.equal(
      tools.find((tool) => tool.name === name)?.exposure,
      'model-only',
    );
    assert.ok(session.getActiveToolNames().includes(name));
  }
  await session.prompt('/fusion status');
  assert.equal(session.messages.length, 1);
  const message = session.messages[0];
  assert.equal(message?.role, 'custom');
  if (message?.role !== 'custom') throw new Error('Expected Fusion status');
  assert.equal(message.customType, 'fusion-status');
}, 20_000);
