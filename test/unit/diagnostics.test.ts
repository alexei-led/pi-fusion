import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  formatFusionDoctor,
  readNativeRecoveryPolicy,
  recoveryPolicyError,
  thinkingWarnings,
} from '../../src/diagnostics.js';

for (const [text, expected] of [
  [undefined, 'enabled'],
  ['{}', 'enabled'],
  ['{"autoResume":true}', 'enabled'],
  ['{"autoResume":false}', 'disabled'],
  ['{"autoResume":"false"}', 'unknown'],
  ['{broken', 'unknown'],
] as const) {
  test(`recovery prerequisite reads ${text ?? 'absent config'} honestly`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'fusion-policy-'));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'extensions/subagent'), { recursive: true });
    if (text !== undefined)
      await writeFile(join(root, 'extensions/subagent/config.json'), text);
    const policy = await readNativeRecoveryPolicy(root);
    assert.equal(policy.configured, expected);
    assert.equal(
      recoveryPolicyError(policy) === undefined,
      expected === 'disabled',
    );
  });
}

test('doctor never equates configured policy or parent web tools with effective child guarantees', () => {
  const profile = {
    panel: [
      {
        id: 'a',
        agent: 'pi-fusion.fusion-panelist-web',
        thinking: 'high' as const,
      },
    ],
    judge: { agent: 'judge' },
  };
  assert.equal(thinkingWarnings(profile).length, 1);
  const report = formatFusionDoctor({
    info: { methods: ['ping', 'spawn'], capabilities: { asyncSpawn: true } },
    policy: { path: '/agent/config.json', configured: 'disabled' },
    profile,
    trusted: false,
    parentTools: ['web_search'],
  });
  assert.match(report, /not queryable through RPC/);
  assert.match(report, /ordinary stage deadlines only/);
  assert.match(report, /model\/effort inherited/);
  assert.match(report, /not forwarded/);
  assert.match(report, /do not prove child loading/);
});
