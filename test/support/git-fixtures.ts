import { execFileSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function fixtureGit(args: string[]): string {
  const environment = { ...process.env };
  for (const name of Object.keys(environment))
    if (name.startsWith('GIT_')) delete environment[name];
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL =
    process.platform === 'win32' ? 'NUL' : '/dev/null';
  return execFileSync('git', args, {
    encoding: 'utf8',
    env: environment,
    timeout: 15_000,
  }).trim();
}

export async function prepareGitTemplates(root: string): Promise<void> {
  for (const label of ['session', 'candidate']) {
    const cwd = join(root, label);
    await mkdir(cwd, { recursive: true });
    fixtureGit(['init', '--quiet', cwd]);
    await writeFile(join(cwd, 'marker.txt'), label);
    fixtureGit(['-C', cwd, 'add', 'marker.txt']);
    fixtureGit([
      '-C',
      cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      label,
    ]);
  }
}

export async function copyGitTemplate(
  label: string,
  destination: string,
): Promise<void> {
  const root = process.env.PI_FUSION_TEST_GIT_TEMPLATES;
  if (!root)
    throw new Error(
      'Git fixture templates were not prepared by test global setup',
    );
  await cp(join(root, label), destination, { recursive: true });
}
