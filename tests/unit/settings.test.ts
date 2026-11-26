import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../../src/main/core/settingsStore';
import { defaultCostProvider } from '../../src/shared/cost';
import { APP_NAME, FEATURE_FLAGS } from '../../src/shared/constants';

describe('M0 foundation', () => {
  it('keeps APP_NAME centralized and showCost disabled by default', () => {
    expect(APP_NAME).toBe('AgentWatch');
    expect(FEATURE_FLAGS.showCost).toBe(false);
    expect(defaultCostProvider.estimateCost({
      agent: 'claude_code',
      model: 'claude-sonnet-4-5',
      inputTokens: 1000,
      outputTokens: 500,
    })).toBeNull();
  });

  it('persists and reloads settings atomically with showCost locked false', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-settings-'));
    try {
      const store = new SettingsStore(tmp);
      expect(store.get().theme).toBe('system');
      store.update({
        theme: 'light',
        overlay: { offsetTop: 12 },
        featureFlags: { showCost: true },
      });
      const reloaded = new SettingsStore(tmp).get();
      expect(reloaded.theme).toBe('light');
      expect(reloaded.overlay.offsetTop).toBe(12);
      expect(reloaded.featureFlags.showCost).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
