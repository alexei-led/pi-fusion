import assert from 'node:assert/strict';
import { test } from 'vitest';
import { nativePanelResults } from '../../src/native-workflow-results.js';

test('retained workflow values keep full child text and stable panel identities', () => {
  const result = nativePanelResults({
    workflow: {
      value: [
        {
          key: 'panel-2',
          ok: true,
          output: 'preview',
          results: [
            {
              agent: 'panel',
              model: 'provider/model',
              finalOutput: 'Complete answer END',
            },
          ],
        },
        { key: 'panel-1', ok: false, error: 'Native failure', results: [] },
      ],
    },
  });
  assert.equal(result?.[0]?.workflowKey, 'panel-2');
  assert.equal(result?.[0]?.output, 'Complete answer END');
  assert.equal(result?.[0]?.model, 'provider/model');
  assert.equal(result?.[1]?.success, false);
  assert.equal(result?.[1]?.error, 'Native failure');
});

for (const value of [
  null,
  [{ key: 'unrelated', ok: true }],
  [{ key: 'panel-1', ok: 'true' }],
  [{ key: 'panel-1', ok: true, results: [{}, {}] }],
]) {
  test(`unknown workflow return shape is not adopted: ${JSON.stringify(value)}`, () => {
    assert.equal(nativePanelResults({ workflow: { value } }), undefined);
  });
}
