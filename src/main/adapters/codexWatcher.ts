import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NormalizedEvent } from '../../shared/types';
import { getFolderNameFromCwd } from './pathResolver';

interface FileCursor {
  offset: number;
  sessionId?: string;
  cwd?: string;
}

/**
 * Watches recent Codex rollout-*.jsonl files incrementally so sessions and read-only
 * terminal approval / turn states surface even when Codex hooks aren't active.
 */
export class CodexRolloutWatcher {
  private cursors = new Map<string, FileCursor>();
  private initialized = false;
  private isPolling = false;

  async poll(sessionsDir: string, onEvent: (event: NormalizedEvent) => void): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      if (!fs.existsSync(sessionsDir)) return;
      const files = await findRecentRolloutFilesAsync(sessionsDir, 20);
      const isInitialScan = !this.initialized;
      this.initialized = true;

      for (const filePath of files) {
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          continue;
        }

        let cursor = this.cursors.get(filePath);
        if (!cursor) {
          cursor = {
            // On initial launch, fast-forward to EOF so historical sessions don't spam live alerts.
            offset: isInitialScan ? stat.size : 0,
          };
          this.cursors.set(filePath, cursor);
        }

        if (stat.size <= cursor.offset) {
          if (stat.size < cursor.offset) cursor.offset = 0;
          continue;
        }

        const len = Math.min(stat.size - cursor.offset, 512 * 1024);
        const buf = Buffer.alloc(len);
        let handle: fs.promises.FileHandle | undefined;
        try {
          handle = await fs.promises.open(filePath, 'r');
          await handle.read(buf, 0, len, cursor.offset);
        } catch {
          continue;
        } finally {
          if (handle !== undefined) {
            await handle.close();
          }
        }

        const chunk = buf.toString('utf8');
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline === -1) continue;
        cursor.offset += Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8');

        const lines = chunk.slice(0, lastNewline).split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const ev = this.parseRolloutLine(parsed, filePath, cursor);
            if (ev) onEvent(ev);
          } catch {
            // Ignore partial or malformed lines.
          }
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  private parseRolloutLine(
    line: Record<string, unknown>,
    filePath: string,
    cursor: FileCursor,
  ): NormalizedEvent | null {
    const type = String(line.type || '');
    const payload = (line.payload && typeof line.payload === 'object'
      ? line.payload
      : {}) as Record<string, unknown>;

    if (type === 'session_meta') {
      cursor.sessionId = String(payload.id || payload.session_id || path.basename(filePath, '.jsonl'));
      cursor.cwd = String(payload.cwd || '');
      return {
        id: crypto.randomUUID(),
        type: 'session_started',
        agent: 'codex',
        sessionId: cursor.sessionId,
        timestamp: Date.now(),
        cwd: cursor.cwd,
        folderName: getFolderNameFromCwd(cursor.cwd),
        transcriptPath: filePath,
      };
    }

    const sessionId = cursor.sessionId || path.basename(filePath, '.jsonl');
    const cwd = cursor.cwd || '';
    const folderName = getFolderNameFromCwd(cwd);

    if (type === 'event_msg') {
      const pType = String(payload.type || '');
      if (pType === 'exec_approval_request' || pType === 'apply_patch_approval_request') {
        const command = Array.isArray(payload.command)
          ? payload.command.join(' ')
          : String(payload.command || payload.reason || 'Codex approval requested');
        return {
          id: crypto.randomUUID(),
          type: 'permission_requested',
          requestId: String(payload.call_id || crypto.randomUUID()),
          agent: 'codex',
          sessionId,
          timestamp: Date.now(),
          cwd,
          folderName,
          toolName: pType === 'apply_patch_approval_request' ? 'apply_patch' : 'Bash',
          commandOrAction: command,
          readOnlyInTerminal: true,
          transcriptPath: filePath,
        };
      }
      if (pType === 'turn_aborted' || pType === 'error') {
        return {
          id: crypto.randomUUID(),
          type: 'error',
          agent: 'codex',
          sessionId,
          timestamp: Date.now(),
          cwd,
          folderName,
          errorMessage: String(payload.reason || payload.message || 'Codex turn aborted'),
          transcriptPath: filePath,
        };
      }
    }

    return null;
  }
}

async function findRecentRolloutFilesAsync(rootDir: string, limit: number): Promise<string[]> {
  const results: Array<{ file: string; mtimeMs: number }> = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
        try {
          const st = await fs.promises.stat(full);
          results.push({ file: full, mtimeMs: st.mtimeMs });
        } catch {
          // Ignore vanished files.
        }
      }
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit).map((r) => r.file);
}
