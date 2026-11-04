import assert from 'node:assert/strict';
import { initTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { test } from 'vitest';
import { renderFusionReport } from '../../src/report-renderer.js';

const report =
  '# Fusion Report\n## Summary\nPartial coverage: 東京 🦊 and café.\n## Agent Status\n- Successful panelists: 2\n- Failed panelists: 1\n## Recommendation\nChoose the bounded option.\n## Run Details\n- Total estimated cost: $0.1200\n## Run Metadata\n- Fusion run: secret-detail-id';
const options = {
  expanded: false,
  outputPad: 1,
  keyHint: () => 'ctrl+o to expand',
  keyText: () => 'ctrl+o',
};
const theme: Pick<Theme, 'fg' | 'bg' | 'bold'> = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

test('collapsed report shows coverage, recommendation and cost, not artifact metadata', () => {
  initTheme('dark');
  const component = renderFusionReport({ content: report }, options, theme);
  assert.ok(component);
  const text = component.render(80).join('\n');
  assert.match(text, /Partial coverage/);
  assert.match(text, /Successful panelists: 2/);
  assert.match(text, /Choose the bounded option/);
  assert.match(text, /0.1200/);
  assert.match(text, /ctrl\+o to expand/);
  assert.doesNotMatch(text, /secret-detail-id/);
});

for (const appearance of ['dark', 'light']) {
  for (const width of [12, 24, 80]) {
    test(`native report fits ${width} columns with ${appearance} theme and resize`, () => {
      initTheme(appearance);
      const component = renderFusionReport(
        { content: report },
        { ...options, expanded: true },
        theme,
      );
      assert.ok(component);
      component.invalidate();
      for (const line of component.render(width))
        assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
      assert.match(component.render(80).join('\n'), /secret-detail-id/);
    });
  }
}
