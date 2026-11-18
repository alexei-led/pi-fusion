import { readFileSync } from 'node:fs';

const advisory = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function acceptsDevAudit(report: unknown, lock: unknown): boolean {
  if (
    !isRecord(report) ||
    report.error !== undefined ||
    report.auditReportVersion !== 2 ||
    !isRecord(report.vulnerabilities) ||
    !isRecord(lock) ||
    !isRecord(lock.packages)
  )
    return false;
  const findings = report.vulnerabilities;
  const packages = lock.packages;
  function allowed(name: string, ancestors = new Set<string>()): boolean {
    if (ancestors.has(name)) return false;
    const finding = findings[name];
    if (
      !isRecord(finding) ||
      !Array.isArray(finding.nodes) ||
      finding.nodes.length === 0 ||
      !Array.isArray(finding.via) ||
      finding.via.length === 0
    )
      return false;
    if (
      !finding.nodes.every((node: unknown) => {
        if (typeof node !== 'string') return false;
        const entry = packages[node];
        return isRecord(entry) && entry.dev === true;
      })
    )
      return false;
    const visited = new Set(ancestors).add(name);
    return finding.via.every((cause: unknown) =>
      typeof cause === 'string'
        ? allowed(cause, visited)
        : name === 'picomatch' &&
          isRecord(cause) &&
          cause.name === name &&
          cause.url === advisory &&
          cause.severity === 'high',
    );
  }

  return Object.entries(findings).every(
    ([name, finding]) =>
      isRecord(finding) &&
      (finding.severity === 'info' ||
        finding.severity === 'low' ||
        allowed(name)),
  );
}

if (import.meta.main) {
  const input = readFileSync(0, 'utf8');
  const report: unknown = JSON.parse(input);
  const lock: unknown = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  if (!acceptsDevAudit(report, lock)) {
    console.error(input);
    process.exitCode = 1;
  } else if (
    isRecord(report) &&
    isRecord(report.vulnerabilities) &&
    Object.keys(report.vulnerabilities).length > 0
  ) {
    console.log(
      `Dependency audit passed with one permitted dev-only advisory: ${advisory}`,
    );
  }
}
