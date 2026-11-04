import assert from 'node:assert/strict';
import { test } from 'vitest';
import { registerFusionCommands } from '../../src/commands.js';
import { parseFusionArgs } from '../../src/fusion-args.js';
import { FakePi } from '../support/fake-pi.js';

test('natural-language finish and continue prompts do not become controls', async () => {
  const pi = new FakePi();
  const prompts: unknown[] = [];
  registerFusionCommands(pi.asExtensionApi(), {
    startRun: async (args) => {
      prompts.push(args);
    },
    showStatus: async () => undefined,
    cancelActiveRun: async () => undefined,
  });
  const ctx = pi.createContext();
  for (const prompt of [
    'finish reviewing the parser',
    'continue analysis',
    '-- finish run 2',
  ])
    await pi.runCommand('fusion', prompt, ctx);
  assert.deepEqual(prompts, [
    'finish reviewing the parser',
    'continue analysis',
    '-- finish run 2',
  ]);
  assert.equal(parseFusionArgs('-- finish run 2').prompt, 'finish run 2');
});

test('explicit deadline syntax preserves exact native decision targets', async () => {
  const pi = new FakePi();
  const decisions: unknown[] = [];
  registerFusionCommands(pi.asExtensionApi(), {
    startRun: async () => assert.fail('control must not launch work'),
    showStatus: async () => undefined,
    cancelActiveRun: async () => undefined,
    resolvePanelDeadline: async (...args) => {
      decisions.push(args);
    },
  });
  await pi.runCommand(
    'fusion',
    'deadline finish fusion-1 2',
    pi.createContext(),
  );
  assert.deepEqual(decisions, [['fusion-1', 2, 'finish']]);
});

test('completions expose commands and configured profile names without starting work', async () => {
  const pi = new FakePi();
  registerFusionCommands(pi.asExtensionApi(), {
    startRun: async () => assert.fail('completion must not launch work'),
    showStatus: async () => undefined,
    cancelActiveRun: async () => undefined,
    getProfileNames: async () => ['quality', 'quick', 'research team'],
  });
  const complete = pi.commands.get('fusion')?.getArgumentCompletions;
  assert.ok(complete);
  assert.ok((await complete('do'))?.some((item) => item.value === 'doctor'));
  assert.deepEqual(
    (await complete('--profile qu'))?.map((item) => item.value),
    ['--profile quality', '--profile quick'],
  );
  assert.deepEqual(
    (await complete('-p research'))?.map((item) => item.value),
    ['-p "research team"'],
  );
  assert.equal(await complete('review the parser'), null);
  assert.equal(await complete('doctor'), null);
  assert.equal(await complete('--profile quick'), null);
});
