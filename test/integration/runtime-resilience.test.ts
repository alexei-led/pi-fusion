import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import fusionExtension from '../../src/index.js';
import { createProjectDir, FakePi, nextTick } from '../support/fake-pi.js';

test('workflow failure category reaches the persisted run and failure report', async (t) => {
  const cwd = await createProjectDir(t);
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);
  fusionExtension(pi.asExtensionApi());
  await pi.emitLifecycle('session_start', {}, ctx);
  t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
  await pi.runCommand('fusion', 'review', ctx);
  pi.events.statusResults.set('panel-1', {
    runId: 'panel-1',
    state: 'failed',
    error: 'runtime broke',
    workflow: { failureKind: 'runtime' },
  });
  pi.events.emit('subagent:async-complete', { runId: 'panel-1' });
  await nextTick();
  assert.match(
    pi.messages.at(-1)?.content ?? '',
    /Workflow failure category: runtime/,
  );
  assert.equal(
    (pi.entries.at(-1)?.data as { failureKind: string } | undefined)
      ?.failureKind,
    'runtime',
  );
});

test('authoritative artifact failure category reaches zero-success panel report', async (t) => {
  const cwd = await createProjectDir(t);
  const root = await mkdtemp(join(tmpdir(), 'fusion-result-category-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'async-subagent-runs', 'panel-1');
  await mkdir(join(root, 'async-subagent-results'), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'status.json'),
    JSON.stringify({ runId: 'panel-1', state: 'running' }),
  );
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);
  fusionExtension(pi.asExtensionApi());
  await pi.emitLifecycle('session_start', {}, ctx);
  t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
  pi.events.spawnAsyncDirs.set('panel-1', dir);
  await pi.runCommand('fusion', 'review', ctx);
  await writeFile(
    join(root, 'async-subagent-results', 'panel-1.json'),
    JSON.stringify({
      state: 'complete',
      workflow: { failureKind: 'child' },
      results: [
        { success: false, error: 'child failed' },
        { success: false, error: 'child failed' },
        { success: false, error: 'child failed' },
      ],
    }),
  );
  pi.events.emit('subagent:async-complete', { runId: 'panel-1' });
  await nextTick();
  assert.match(
    pi.messages.at(-1)?.content ?? '',
    /Workflow failure category: child/,
  );
  assert.equal(
    (pi.entries.at(-1)?.data as { failureKind?: string } | undefined)
      ?.failureKind,
    'child',
  );
});

test('launch tool returns a structured receipt and marks conflicts as errors', async (t) => {
  const cwd = await createProjectDir(t);
  const pi = new FakePi();
  const ctx = pi.createContext(cwd);
  fusionExtension(pi.asExtensionApi());
  await pi.emitLifecycle('session_start', {}, ctx);
  t.onTestFinished(() => pi.emitLifecycle('session_shutdown', {}, ctx));
  const tool = pi.tools.get('start_fusion_review');
  assert.ok(tool);
  const result = (await tool.execute(
    'one',
    { prompt: 'review' },
    undefined,
    undefined,
    ctx,
  )) as {
    structuredContent: { status: string; runId: string };
    isError: boolean;
  };
  assert.equal(result.structuredContent.status, 'started');
  assert.ok(result.structuredContent.runId);
  assert.equal(result.isError, false);
  const conflict = (await tool.execute(
    'two',
    { prompt: 'review' },
    undefined,
    undefined,
    ctx,
  )) as { structuredContent: { status: string }; isError: boolean };
  assert.equal(conflict.structuredContent.status, 'conflict');
  assert.equal(conflict.isError, true);
});
