import assert from 'node:assert/strict';
import { test } from 'vitest';
import { acceptsDevAudit } from '../../scripts/audit-dev-exception.js';

const known = {
  name: 'picomatch',
  severity: 'high',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
};

test.each([
  {
    name: 'known dev-only advisory and its parent',
    dev: true,
    causes: [known],
    parent: ['picomatch'],
    pass: true,
  },
  {
    name: 'runtime dependency',
    dev: false,
    causes: [known],
    parent: ['picomatch'],
    pass: false,
  },
  {
    name: 'additional advisory on the same package',
    dev: true,
    causes: [known, { ...known, url: 'https://example.invalid/other' }],
    parent: ['picomatch'],
    pass: false,
  },
  {
    name: 'unresolved advisory chain',
    dev: true,
    causes: [known],
    parent: ['missing'],
    pass: false,
  },
  {
    name: 'cyclic advisory chain',
    dev: true,
    causes: [known, 'vitest'],
    parent: ['picomatch'],
    pass: false,
  },
])('audit gate: $name', ({ dev, causes, parent, pass }) => {
  assert.equal(
    acceptsDevAudit(
      {
        auditReportVersion: 2,
        vulnerabilities: {
          picomatch: {
            severity: 'high',
            nodes: ['node_modules/picomatch'],
            via: causes,
          },
          vitest: {
            severity: 'high',
            nodes: ['node_modules/vitest'],
            via: parent,
          },
        },
      },
      {
        packages: {
          'node_modules/picomatch': { dev },
          'node_modules/vitest': { dev: true },
        },
      },
    ),
    pass,
  );
});

test('a failed audit response never qualifies for the exception', () => {
  assert.equal(
    acceptsDevAudit({ error: { code: 'E500' } }, { packages: {} }),
    false,
  );
});
