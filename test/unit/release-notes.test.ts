import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { extractReleaseNotes } from '../../scripts/release-notes.js';

test('release notes select the exact version and preserve authored headings', () => {
  const changelog =
    '# Changelog\n\n## 0.12.1 - 2026-10-07\nLater.\n\n## 0.12.0 - 2026-10-06\n\n### Changes\n\n- Fix launches.\n\n### Upgrade\n\nRestart Pi.\n\n## 0.11.1\nOld.';
  assert.equal(
    extractReleaseNotes(changelog, '0.12.0'),
    '### Changes\n\n- Fix launches.\n\n### Upgrade\n\nRestart Pi.',
  );
  assert.equal(
    extractReleaseNotes(changelog.replaceAll('\n', '\r\n'), '0.11.1'),
    'Old.',
  );
});

test('publication refuses missing and empty changelog sections', () => {
  assert.throws(
    () => extractReleaseNotes('## 0.12.1\nLater.', '0.12.0'),
    /Missing/,
  );
  assert.throws(
    () => extractReleaseNotes('## 0.12.0\n\n## 0.11.1\nOld.', '0.12.0'),
    /Empty/,
  );
});

test('the package version has reviewed upgrade notes in the changelog', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const notes = extractReleaseNotes(
    await readFile('CHANGELOG.md', 'utf8'),
    pkg.version,
  );
  assert.match(notes, /### Changes/);
  assert.match(notes, /### Upgrade/);
  assert.match(notes, /pi-subagents 0\.76\.1/);
});
