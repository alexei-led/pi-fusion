import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'vitest';
import {
  isolatedProcessEnvironment,
  observeChild,
} from '../support/child-process.js';

test('early child exit rejects readiness and preserves the actual cause', async (t) => {
  const child = spawn(
    process.execPath,
    ['-e', 'console.error("BOOT_FAILED"); process.exit(9);'],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const observed = observeChild(t, child, 'Fixture');
  await assert.rejects(observed.ready, /Fixture exited 9: BOOT_FAILED/);
  await assert.rejects(observed.exited, /Fixture exited 9: BOOT_FAILED/);
});

test('a child without a readiness consumer is still owned and reaped by teardown', (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  void observeChild(t, child, 'Fixture');
});

test('process workers cannot inherit Pi loader aliases or personal agent state', () => {
  const environment = isolatedProcessEnvironment('/fixture');
  assert.equal(environment.JITI_ALIAS, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.AGTERM_SESSION_ID, undefined);
  assert.equal(environment.PI_CODING_AGENT_DIR, '/fixture/agent');
});
