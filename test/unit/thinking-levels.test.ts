import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseFusionConfig, splitInlinePanelEntry } from '../../src/config.js';
import { appendThinkingSuffix } from '../../src/run-builder.js';
import { FusionRunStore } from '../../src/run-store.js';
import { JUDGE_AGENT, PANEL_AGENT, THINKING_LEVELS } from '../../src/types.js';

describe('canonical thinking levels', () => {
  for (const thinking of new Set([...THINKING_LEVELS, 'max'])) {
    it(`accepts and restores ${thinking} without changing model identity`, () => {
      const config = parseFusionConfig(
        JSON.stringify({
          defaultProfile: 'test',
          profiles: {
            test: {
              panel: [
                { id: 'p', agent: PANEL_AGENT, model: 'gpt-5.5', thinking },
              ],
              judge: { agent: JUDGE_AGENT, model: 'gpt-5.5', thinking },
            },
          },
        }),
        'test',
      );
      const profile = config.profiles.test;
      assert.ok(profile);
      assert.deepEqual(splitInlinePanelEntry(`gpt-5.5:${thinking}`), {
        agent: PANEL_AGENT,
        model: `gpt-5.5:${thinking}`,
      });
      assert.equal(
        appendThinkingSuffix('gpt-5.5', profile.judge.thinking),
        `gpt-5.5:${thinking}`,
      );
      assert.equal(
        appendThinkingSuffix(`gpt-5.5:${thinking}`, 'low'),
        `gpt-5.5:${thinking}`,
      );
      const entries: unknown[] = [];
      const store = new FusionRunStore({
        persistence: {
          appendEntry(type, data) {
            entries.push({ type: 'custom', customType: type, data });
          },
        },
      });
      store.startRun({
        prompt: 'Review',
        profileName: 'test',
        profileSnapshot: { ...profile, minimumSuccessfulPanelists: 1 },
      });
      const restored = new FusionRunStore();
      restored.restoreFromEntries(entries);
      assert.equal(
        restored.getActiveRun()?.profileSnapshot?.judge.thinking,
        thinking,
      );
    });
  }
});
