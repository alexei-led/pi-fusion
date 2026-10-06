/** Extract only the authored section for the exact package version. */
export function extractReleaseNotes(
  changelog: string,
  version: string,
): string {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line === `## ${version}` || line.startsWith(`## ${version} - `),
  );
  if (start === -1)
    throw new Error(`Missing changelog section for ${version}.`);
  const next = lines.findIndex(
    (line, index) => index > start && line.startsWith('## '),
  );
  const notes = lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join('\n')
    .trim();
  if (!notes) throw new Error(`Empty changelog section for ${version}.`);
  return notes;
}
