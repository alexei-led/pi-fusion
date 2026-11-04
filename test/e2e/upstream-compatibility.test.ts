import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { onTestFinished, test } from 'vitest';
import { isRecord } from '../../src/utils.js';

test('real Pi and subagents execute Fusion select, merge and single profiles', {
  timeout: 100_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-upstream-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'cwd');
  const home = join(root, 'home');
  for (const dir of [cwd, home, join(agentDir, 'agents')])
    await mkdir(dir, { recursive: true });
  let panelCalls = 0;
  let judgeCalls = 0;
  let composerCalls = 0;
  let parentCalls = 0;
  let completeSynthesisInputs = 0;
  let passed = false;
  let webResults = 0;
  let webCalls = 0;
  let missingWebCalls = 0;
  const webConfig = join(root, 'webfox.json');
  const webfoxPath = resolve('node_modules/webfox/dist/pi.js');
  await writeFile(
    webConfig,
    JSON.stringify({
      defaults: Object.fromEntries(
        ['search', 'contents', 'answer', 'research'].map((capability) => [
          capability,
          { provider: 'custom' },
        ]),
      ),
      providers: {
        custom: {
          commands: Object.fromEntries(
            ['search', 'contents', 'answer', 'research'].map((capability) => [
              capability,
              {
                argv: [
                  process.execPath,
                  resolve('node_modules/webfox/examples/custom/provider.mjs'),
                ],
              },
            ]),
          ),
        },
      },
    }),
  );
  await mkdir(join(home, '.config/webfox'), { recursive: true });
  await copyFile(webConfig, join(home, '.config/webfox/config.yaml'));
  await mkdir(join(agentDir, 'extensions/subagent'), { recursive: true });
  await writeFile(
    join(agentDir, 'extensions/subagent/config.json'),
    '{"autoResume":false}',
  );
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (data: Buffer) => {
      body += data.toString();
    });
    req.on('end', () => {
      if (body.includes('You are the fusion judge.')) judgeCalls++;
      else if (body.includes('You are the fusion composer.')) composerCalls++;
      else if (body.includes('Panel member: web-member-missing'))
        missingWebCalls++;
      else if (body.includes('Panel member: web-member')) webCalls++;
      else if (body.includes('Panel member:')) panelCalls++;
      else parentCalls++;
      if (
        (body.includes('You are the fusion judge.') ||
          body.includes('You are the fusion composer.')) &&
        body.includes('LONG_OUTPUT_END')
      )
        completeSynthesisInputs++;
      if (body.includes('Panel member: FAIL_FIRST (FAIL_FIRST)')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'Fixture authentication failure',
              type: 'authentication_error',
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (
        body.includes('Panel member: web-member') &&
        !body.includes('"role":"tool"')
      ) {
        const call = {
          id: 'web-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'web-call',
                    type: 'function',
                    function: {
                      name: 'web_search',
                      arguments: JSON.stringify({ queries: ['fixture query'] }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(call)}\n\n`);
        res.write(
          `data: ${JSON.stringify({ ...call, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      if (
        body.includes('Panel member: web-member') &&
        body.includes('Example result for fixture query')
      )
        webResults++;
      const role = body.includes('You are the fusion judge.')
        ? 'JUDGE'
        : body.includes('You are the fusion composer.')
          ? 'COMPOSER'
          : 'PANEL';
      const text =
        '# Fusion Report\n## Summary\nFIXTURE_OK\n## Coverage Map\nBoth facets.\n## Combined Answer\nFIXTURE_OK\n## Gaps\nNone.\n## Conflicts At Seams\nNone.\n## Recommendation\nChoose the simple option.\n' +
        'Fixture evidence. '.repeat(160) +
        `\n${role}_FINAL_END\nLONG_OUTPUT_END`;
      const chunk = {
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: text },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        smoke: {
          api: 'openai-completions',
          apiKey: 'fixture-not-a-secret',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [
            {
              id: 'fixture',
              reasoning: false,
              contextWindow: 128000,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'smoke',
      defaultModel: 'fixture',
      defaultThinkingLevel: 'off',
    }),
  );
  for (const name of ['fixture-panel', 'fixture-judge']) {
    await writeFile(
      join(agentDir, 'agents', `${name}.md`),
      `---\nname: ${name}\ndescription: Read-only fixture\nmodel: smoke/fixture\nthinking: off\ntools: read\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritSkills: false\n---\nReturn the fixture response.\n`,
    );
  }
  for (const [name, extensions] of [
    ['fixture-web', [webfoxPath]],
    ['fixture-web-missing', []],
  ] as const) {
    await writeFile(
      join(agentDir, 'agents', `${name}.md`),
      `---\nname: ${name}\ndescription: Web integration fixture\nmodel: smoke/fixture\nthinking: off\ntools: read, web_search, web_contents, web_answer\nextensions: ${extensions.length ? `\n${extensions.map((path) => `  - ${path}`).join('\n')}` : '[]'}\ninheritProjectContext: false\ninheritSkills: false\n---\nUse the configured web tools for evidence.\n`,
    );
  }
  const base = {
    panel: [
      { id: 'a', agent: 'fixture-panel' },
      { id: 'b', agent: 'fixture-panel' },
    ],
    judge: { agent: 'fixture-judge' },
    concurrency: 2,
    wakeOnCompletion: false,
    panelTimeoutMs: 35_000,
    panelistTimeoutMs: 25_000,
    judgeTimeoutMs: 25_000,
  };
  await writeFile(
    join(agentDir, 'fusion.json'),
    JSON.stringify({
      defaultProfile: 'select',
      profiles: {
        select: base,
        merge: {
          ...base,
          panel: base.panel.map((member) => ({
            ...member,
            question: `Cover ${member.id}: {task}`,
          })),
        },
        single: { ...base, panel: [base.panel[0]] },
        web: { ...base, panel: [{ id: 'web-member', agent: 'fixture-web' }] },
        'web-missing': {
          ...base,
          panel: [{ id: 'web-member-missing', agent: 'fixture-web-missing' }],
        },
        refill: {
          ...base,
          concurrency: 4,
          panel: Array.from({ length: 6 }, (_, index) => ({
            id: index === 0 ? 'FAIL_FIRST' : `refill-${index}`,
            agent: 'fixture-panel',
          })),
        },
      },
    }),
  );
  const child = spawn(
    process.execPath,
    [
      resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
      '--mode',
      'rpc',
      '--no-extensions',
      '--no-skills',
      '--no-mcp',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--extension',
      resolve('node_modules/pi-subagents/index.js'),
      '--extension',
      webfoxPath,
      '--extension',
      resolve('src/index.ts'),
      '--extension',
      resolve('test/fixtures/rpc-compatibility-extension.ts'),
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: root,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: '1',
        WEBFOX_CONFIG: webConfig,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const closed = once(child, 'close');
  let stderr = '';
  let stdout = '';
  let pending = '';
  let report: unknown;
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  child.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    stdout += text;
    pending += text;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline === -1) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        isRecord(event) &&
        event.type === 'message_end' &&
        isRecord(event.message) &&
        event.message.customType === 'fusion-compatibility-done' &&
        typeof event.message.content === 'string'
      ) {
        report = JSON.parse(event.message.content);
        child.stdin.end();
      }
    }
  });
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 90_000);
  onTestFinished(async () => {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await closed;
    server.closeAllConnections();
    server.close();
    if (passed) await rm(root, { recursive: true, force: true });
    else {
      await writeFile(join(root, 'host-stderr.log'), stderr);
      await writeFile(join(root, 'host-stdout.jsonl'), stdout);
      console.error(`Retained failed real-Pi fixture: ${root}`);
    }
  });
  child.stdin.write(
    `${JSON.stringify({
      id: 'smoke',
      type: 'prompt',
      message: '/fusion-compatibility',
    })}\n`,
  );
  const [code, signal] = await closed;
  clearTimeout(watchdog);
  assert.equal(code, 0, stderr + stdout.slice(-8000));
  assert.equal(signal, null);
  assert.ok(isRecord(report), stderr + stdout.slice(-8000));
  assert.equal(report.success, true, JSON.stringify(report));
  assert.equal(report.legacyRejected, true);
  assert.deepEqual(report.nativeStopRejections, ['invalid_state', 'not_found']);
  assert.equal(report.unsupportedLifetimeRejected, true);
  assert.deepEqual(
    report.runs,
    ['select', 'merge', 'single', 'refill', 'web', 'web-missing'].map(
      (profile) => ({
        profile,
        phase: profile === 'web-missing' ? 'failed' : 'done',
      }),
    ),
  );
  assert.equal(panelCalls, 11);
  assert.equal(webCalls, 2);
  assert.ok(missingWebCalls <= 2);
  assert.equal(webResults, 1);
  assert.equal(judgeCalls, 2);
  assert.equal(completeSynthesisInputs, 3);
  assert.equal(composerCalls, 1);
  // RPC completion wakes are native upstream behavior, not controlled by Fusion's option.
  assert.ok(parentCalls > 0);
  passed = true;
});
