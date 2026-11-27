import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { WIN32_HELPER_NAME } from '../../shared/constants';
import type { TerminalWindowRef } from '../../shared/types';

const execFileAsync = promisify(execFile);

export interface OSProcessEntry {
  pid: number;
  ppid: number;
  exeName: string;
  commandLine?: string;
}

export interface OSTcpListener {
  pid: number;
  port: number;
  host: string;
}

export interface TerminalFocusResult {
  ok: boolean;
  hwnd?: string;
  pid?: number;
  processName?: string;
  title?: string;
  error?: string;
}

export interface PlatformDriver {
  listProcesses(): Promise<OSProcessEntry[]>;
  listTcpListeners(): Promise<OSTcpListener[]>;
  getCommandLinesForPids(pids: number[]): Promise<Record<number, string>>;
  resolveTerminalRef(pid: number): Promise<TerminalWindowRef | null>;
  focusTerminal(pid?: number, ref?: TerminalWindowRef): Promise<TerminalFocusResult>;
  isForegroundFullscreen(): Promise<boolean>;
  killProcessTree(pid: number): Promise<{ ok: boolean; message?: string }>;
}

export function resolveWin32HelperPath(appResourcesPath?: string): string {
  const archFolder = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
  const candidates = [
    appResourcesPath ? path.join(appResourcesPath, 'bin', archFolder, `${WIN32_HELPER_NAME}.exe`) : '',
    path.resolve(process.cwd(), 'resources', 'bin', archFolder, `${WIN32_HELPER_NAME}.exe`),
    path.resolve(__dirname, '..', '..', '..', 'resources', 'bin', archFolder, `${WIN32_HELPER_NAME}.exe`),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

export class Win32PlatformDriver implements PlatformDriver {
  constructor(private readonly helperExePath: string) {}

  private async runHelper<T>(args: string[]): Promise<T> {
    const { stdout } = await execFileAsync(this.helperExePath, args, {
      timeout: 4000,
      windowsHide: true,
    });
    return JSON.parse(stdout.trim() || '{}') as T;
  }

  async listProcesses(): Promise<OSProcessEntry[]> {
    try {
      const list = await this.runHelper<OSProcessEntry[]>(['processes']);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async listTcpListeners(): Promise<OSTcpListener[]> {
    try {
      const list = await this.runHelper<OSTcpListener[]>(['tcp-listeners']);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async getCommandLinesForPids(pids: number[]): Promise<Record<number, string>> {
    const unique = Array.from(new Set(pids.filter((p) => p > 4)));
    if (unique.length === 0) return {};
    const out: Record<number, string> = {};
    const missing: number[] = [];
    try {
      const res = await this.runHelper<Record<string, string>>([
        'command-lines',
        '--pids',
        unique.join(','),
      ]);
      for (const p of unique) {
        if (res && res[String(p)]) {
          out[p] = res[String(p)];
        } else {
          missing.push(p);
        }
      }
    } catch {
      missing.push(...unique);
    }

    if (missing.length > 0) {
      const fallback = await this.fallbackPowerShellCommandLines(missing);
      Object.assign(out, fallback);
    }
    return out;
  }

  private async fallbackPowerShellCommandLines(pids: number[]): Promise<Record<number, string>> {
    if (pids.length === 0) return {};
    const filter = pids.map((p) => `ProcessId=${p}`).join(' OR ');
    const psCmd = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCmd],
        { timeout: 3500, windowsHide: true },
      );
      const trimmed = stdout.trim();
      if (!trimmed) return {};
      const parsed = JSON.parse(trimmed) as
        | { ProcessId: number; CommandLine?: string }
        | Array<{ ProcessId: number; CommandLine?: string }>;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const out: Record<number, string> = {};
      for (const row of rows) {
        if (row.ProcessId && row.CommandLine) {
          out[row.ProcessId] = row.CommandLine;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  async resolveTerminalRef(pid: number): Promise<TerminalWindowRef | null> {
    try {
      const res = await this.runHelper<TerminalFocusResult>(['resolve-terminal', '--pid', String(pid)]);
      if (!res.ok) return null;
      return {
        hwnd: res.hwnd,
        pid: res.pid,
        processName: res.processName,
        title: res.title,
      };
    } catch {
      return null;
    }
  }

  async focusTerminal(pid?: number, ref?: TerminalWindowRef): Promise<TerminalFocusResult> {
    const args = ['focus-terminal'];
    if (pid) args.push('--pid', String(pid));
    if (ref?.hwnd) args.push('--hwnd', ref.hwnd);
    if (!pid && !ref?.hwnd) {
      return { ok: false, error: 'No terminal process or window handle recorded for this session.' };
    }
    try {
      return await this.runHelper<TerminalFocusResult>(args);
    } catch (err) {
      return { ok: false, error: `Could not focus terminal window: ${String(err)}` };
    }
  }

  async isForegroundFullscreen(): Promise<boolean> {
    try {
      const res = await this.runHelper<{ fullscreen: boolean }>(['is-fullscreen']);
      return Boolean(res.fullscreen);
    } catch {
      return false;
    }
  }

  async killProcessTree(pid: number): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.runHelper(['kill-tree', '--pid', String(pid)]);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }
}

export class PosixDevPlatformDriver implements PlatformDriver {
  async listProcesses(): Promise<OSProcessEntry[]> {
    try {
      const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 2000 });
      const out: OSProcessEntry[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        out.push({
          pid: Number(m[1]),
          ppid: Number(m[2]),
          exeName: path.basename(m[3].trim()),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async listTcpListeners(): Promise<OSTcpListener[]> {
    try {
      const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P', '-F', 'pn'], {
        timeout: 2000,
      });
      const out: OSTcpListener[] = [];
      let currentPid = 0;
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith('p')) {
          currentPid = Number(line.slice(1));
        } else if (line.startsWith('n') && currentPid > 0) {
          const idx = line.lastIndexOf(':');
          if (idx !== -1) {
            const port = Number(line.slice(idx + 1));
            const host = line.slice(1, idx) || '127.0.0.1';
            if (port > 0) out.push({ pid: currentPid, port, host });
          }
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async getCommandLinesForPids(pids: number[]): Promise<Record<number, string>> {
    if (pids.length === 0) return {};
    try {
      const { stdout } = await execFileAsync('ps', ['-p', pids.join(','), '-o', 'pid=,args='], {
        timeout: 2000,
      });
      const out: Record<number, string> = {};
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (m) out[Number(m[1])] = m[2].trim();
      }
      return out;
    } catch {
      return {};
    }
  }

  async resolveTerminalRef(pid: number): Promise<TerminalWindowRef | null> {
    return pid > 0 ? { pid, processName: 'Terminal' } : null;
  }

  async focusTerminal(pid?: number): Promise<TerminalFocusResult> {
    if (!pid) {
      return { ok: false, error: 'No terminal PID recorded for this session.' };
    }
    return {
      ok: false,
      pid,
      error: 'Win32 terminal focusing runs natively on Windows (simulated environment on macOS/Linux).',
    };
  }

  async isForegroundFullscreen(): Promise<boolean> {
    return false;
  }

  async killProcessTree(pid: number): Promise<{ ok: boolean; message?: string }> {
    try {
      const procs = await this.listProcesses();
      const childrenByParent = new Map<number, number[]>();
      for (const p of procs) {
        const list = childrenByParent.get(p.ppid) ?? [];
        list.push(p.pid);
        childrenByParent.set(p.ppid, list);
      }
      const toKill: number[] = [];
      const stack = [pid];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        toKill.push(cur);
        for (const ch of childrenByParent.get(cur) ?? []) {
          stack.push(ch);
        }
      }
      for (const target of toKill.reverse()) {
        try {
          process.kill(target, 'SIGTERM');
        } catch {
          // Ignore exited processes.
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }
}

export function createPlatformDriver(appResourcesPath?: string): PlatformDriver {
  if (process.platform === 'win32') {
    return new Win32PlatformDriver(resolveWin32HelperPath(appResourcesPath));
  }
  return new PosixDevPlatformDriver();
}
