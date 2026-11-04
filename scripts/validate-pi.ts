import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = process.argv[2] ?? (await mkdtemp(join(tmpdir(), 'fusion-tui-')));
const tuiMode = process.argv[3] ?? 'fullscreen';
if (tuiMode !== 'regular' && tuiMode !== 'fullscreen')
  throw new Error('TUI mode must be regular or fullscreen');
const agentDir = join(root, 'agent');
const cwd = join(root, 'cwd');
const home = join(root, 'home');
for (const directory of [
  cwd,
  home,
  join(agentDir, 'agents'),
  join(agentDir, 'extensions/subagent'),
])
  await mkdir(directory, { recursive: true });
await writeFile(
  join(agentDir, 'extensions/subagent/config.json'),
  '{"autoResume":false}',
);
for (const name of ['fusion-panelist', 'fusion-judge', 'fusion-composer']) {
  const source = await readFile(join(project, 'agents', `${name}.md`), 'utf8');
  await writeFile(
    join(agentDir, 'agents', `${name}.md`),
    source
      .replace('package: pi-fusion\n', '')
      .replace('inheritProjectContext: true', 'inheritProjectContext: false'),
  );
}
const panel = ['architecture', 'reliability', 'usability'].map((id) => ({
  id,
  agent: 'fusion-panelist',
}));
const base = {
  panel,
  judge: { agent: 'fusion-judge' },
  concurrency: 2,
  panelTimeoutMs: 60_000,
  panelistTimeoutMs: 50_000,
  judgeTimeoutMs: 50_000,
};
await writeFile(
  join(agentDir, 'fusion.json'),
  JSON.stringify({
    defaultProfile: 'select',
    profiles: {
      select: base,
      wake: { ...base, wakeOnCompletion: true },
      merge: {
        ...base,
        panel: panel.map((member) => ({
          ...member,
          question: `Cover ${member.id}: {task}`,
        })),
        judge: { agent: 'fusion-composer' },
      },
      partial: {
        ...base,
        panel: [
          ...panel.slice(0, 2),
          { id: 'FAIL_FIXTURE', agent: 'fusion-panelist' },
        ],
      },
      single: { ...base, panel: panel.slice(0, 1) },
    },
  }),
);
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  request.on('end', () => {
    if (body.includes('Panel member: FAIL_FIXTURE')) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: 'Fixture authentication failure',
            type: 'authentication_error',
          },
        }),
      );
      return;
    }
    const send = () => {
      if (response.destroyed) return;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const content =
        '# Fusion Report\n## Summary\nNative Pi validation: 東京, café and 🦊. This is a deterministic local model fixture, not a live provider answer.\n## Coverage Map\nArchitecture, reliability and usability.\n## Combined Answer\nKeep public RPC and fail-closed recovery.\n## Gaps\nOnly fixture evidence.\n## Conflicts At Seams\nNone.\n## Recommendation\nUse the bounded native path.\n## Evidence\nLocal fixture response.\n## Risks\nFixture results do not establish model quality.\n## Next Step\nInspect the complete report with the configured expand key.\nTUI_FIXTURE_END';
      const chunk = {
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content },
            finish_reason: null,
          },
        ],
      };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    };
    const timer = setTimeout(
      send,
      body.includes('SLOW_FIXTURE') && body.includes('Panel member:')
        ? 10_000
        : 300,
    );
    response.on('close', () => clearTimeout(timer));
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string')
  throw new Error('Fixture server has no local port');
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
            maxTokens: 4096,
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
    tuiMode,
  }),
);
await writeFile(
  join(root, 'fixture.json'),
  JSON.stringify({ root, pid: process.pid, port: address.port, project }),
);
console.log(
  `Fusion real-Pi fixture: ${root}\nNo credentials or external model calls. Use /fusion doctor, /fusion --profile merge compare, /fusion --profile partial compare, /fusion SLOW_FIXTURE then /fusion stop. /reload during a slow run tests quarantine. Artifacts are retained.\n`,
);
const child = spawn(
  process.execPath,
  [
    join(project, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    '--no-extensions',
    '--no-skills',
    '--no-mcp',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--extension',
    join(project, 'node_modules/pi-subagents/index.js'),
    '--extension',
    join(project, 'src/index.ts'),
    '--extension',
    join(project, 'test/fixtures/ui-evidence.ts'),
    '--session',
    join(root, 'session.jsonl'),
  ],
  {
    cwd,
    stdio: 'inherit',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_FUSION_VALIDATION_EVIDENCE: join(root, 'ui-events.jsonl'),
      TERM: process.env.TERM,
      COLORTERM: process.env.COLORTERM,
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name.startsWith('AGTERM_') || name === 'TERM_PROGRAM',
        ),
      ),
    },
  },
);
process.on('SIGTERM', () => child.kill('SIGTERM'));
const [code, signal] = await once(child, 'close');
server.closeAllConnections();
server.close();
process.exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
