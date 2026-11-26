import { describe, expect, it } from 'vitest';
import { deriveMascotMood } from '../../src/renderer/components/Mascot';
import type { SessionRecord } from '../../src/shared/types';

function makeSession(state: SessionRecord['state']): SessionRecord {
  return {
    id: `s-${state}`,
    agent: 'claude_code',
    cwd: '/tmp/app',
    folderName: 'app',
    title: 'task',
    state,
    startedAt: 1000,
    lastEventAt: 2000,
    summary: '',
  };
}

describe('M7 Mascot mood state machine', () => {
  it('transitions cleanly across sleeping, working, cheer, and alert moods', () => {
    expect(
      deriveMascotMood({ sessions: [], pendingCount: 0, lastTurnFinishedAt: 0, now: 10_000 }),
    ).toBe('sleeping');

    expect(
      deriveMascotMood({
        sessions: [makeSession('working')],
        pendingCount: 0,
        lastTurnFinishedAt: 0,
        now: 10_000,
      }),
    ).toBe('working');

    expect(
      deriveMascotMood({
        sessions: [makeSession('done')],
        pendingCount: 0,
        lastTurnFinishedAt: 9_000,
        now: 10_000,
      }),
    ).toBe('cheer');

    expect(
      deriveMascotMood({
        sessions: [makeSession('working')],
        pendingCount: 1,
        lastTurnFinishedAt: 9_500,
        now: 10_000,
      }),
    ).toBe('alert');
  });
});
