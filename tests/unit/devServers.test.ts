import { describe, expect, it } from 'vitest';
import { DevServerTracker } from '../../src/main/devservers/devServerTracker';
import type { PlatformDriver } from '../../src/main/platform/platformDriver';
import type { SessionRecord } from '../../src/shared/types';

describe('M6 DevServerTracker', () => {
  it('maps listening child processes of tracked agent sessions and removes them when stopped', async () => {
    let killedPid = 0;
    let alive = true;

    const mockDriver: PlatformDriver = {
      listProcesses: async () =>
        alive
          ? [
              { pid: 100, ppid: 50, exeName: 'claude.exe' },
              { pid: 200, ppid: 100, exeName: 'cmd.exe' },
              { pid: 300, ppid: 200, exeName: 'node.exe' },
              { pid: 999, ppid: 1, exeName: 'postgres.exe' },
            ]
          : [{ pid: 100, ppid: 50, exeName: 'claude.exe' }],
      listTcpListeners: async () =>
        alive
          ? [
              { pid: 300, port: 5173, host: '127.0.0.1' },
              { pid: 999, port: 5432, host: '127.0.0.1' },
            ]
          : [],
      getCommandLinesForPids: async (pids): Promise<Record<number, string>> =>
        pids.includes(300)
          ? { 300: 'node node_modules/vite/bin/vite.js --port 5173' }
          : ({} as Record<number, string>),
      resolveTerminalRef: async () => null,
      focusTerminal: async () => ({ ok: false }),
      isForegroundFullscreen: async () => false,
      killProcessTree: async (pid) => {
        killedPid = pid;
        alive = false;
        return { ok: true };
      },
    };

    const sessions: SessionRecord[] = [
      {
        id: 's1',
        agent: 'claude_code',
        cwd: 'C:\\Users\\dev\\billing',
        folderName: 'billing',
        title: 'Build UI',
        state: 'working',
        startedAt: 1000,
        lastEventAt: 2000,
        summary: '',
        pid: 100,
      },
    ];

    const tracker = new DevServerTracker(mockDriver);
    const list = await tracker.poll(sessions, 44444);

    expect(list).toHaveLength(1);
    expect(list[0].port).toBe(5173);
    expect(list[0].url).toBe('http://localhost:5173');
    expect(list[0].folderName).toBe('billing');
    expect(list[0].commandShort).toBe('vite');
    expect(list[0].trackedChild).toBe(true);

    const stopRes = await tracker.stopServer(300);
    expect(stopRes.ok).toBe(true);
    expect(killedPid).toBe(300);
    expect(await tracker.poll(sessions, 44444)).toHaveLength(0);
  });
});
