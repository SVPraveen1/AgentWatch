import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentId,
  NormalizedEvent,
  PendingPermission,
  SessionRecord,
  SessionState,
  TerminalWindowRef,
} from '../../shared/types';
import { getFolderNameFromCwd } from '../adapters/pathResolver';
import { atomicWriteFileSync } from './settingsStore';

const STATE_PRIORITY: Record<SessionState, number> = {
  needs_you: 0,
  error: 1,
  working: 2,
  done: 3,
  ended: 4,
};

export interface SessionStoreData {
  sessions: SessionRecord[];
  history: NormalizedEvent[];
}

export class SessionStore {
  private readonly filePath: string;
  private sessions = new Map<string, SessionRecord>();
  private history: NormalizedEvent[] = [];

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'sessions.json');
    this.load();
  }

  getSessions(): SessionRecord[] {
    return Array.from(this.sessions.values()).sort((a, b) => {
      const pDiff = STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state];
      if (pDiff !== 0) return pDiff;
      return b.lastEventAt - a.lastEventAt;
    });
  }

  getSession(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  getHistory(): NormalizedEvent[] {
    return [...this.history].sort((a, b) => b.timestamp - a.timestamp);
  }

  applyEvent(event: NormalizedEvent, retentionDays = 90): SessionRecord {
    const existing = this.sessions.get(event.sessionId);
    const folderName = event.folderName || getFolderNameFromCwd(event.cwd);

    const session: SessionRecord = existing
      ? { ...existing }
      : {
          id: event.sessionId,
          agent: event.agent,
          cwd: event.cwd,
          folderName,
          title: event.title || folderName,
          state: 'working',
          startedAt: event.timestamp,
          lastEventAt: event.timestamp,
          summary: '',
        };

    if (event.cwd) session.cwd = event.cwd;
    if (folderName && folderName !== 'unknown') session.folderName = folderName;
    if (event.title && (!existing || existing.title === existing.folderName || existing.title === 'unknown')) {
      session.title = event.title;
    }
    if (event.pid && !session.pid) {
      session.pid = event.pid;
    }
    if (event.transcriptPath) {
      session.transcriptPath = event.transcriptPath;
    }
    session.lastEventAt = Math.max(session.lastEventAt, event.timestamp);

    switch (event.type) {
      case 'session_started':
        session.state = 'working';
        session.endedReason = undefined;
        break;
      case 'prompt_submitted':
        session.state = 'working';
        session.pendingPermission = undefined;
        session.pendingPermissions = undefined;
        session.endedReason = undefined;
        break;
      case 'working':
        session.state = 'working';
        session.lastTool = event.toolName;
        if (!session.pendingPermissions || session.pendingPermissions.length === 0) {
          session.pendingPermission = undefined;
        }
        if (event.summary) session.summary = event.summary;
        break;
      case 'permission_requested':
        session.state = 'needs_you';
        if (event.summary) session.summary = event.summary;
        break;
      case 'permission_resolved':
        if (event.decision === 'deny') {
          session.state = 'needs_you';
        } else if (!session.pendingPermissions || session.pendingPermissions.length === 0) {
          session.pendingPermission = undefined;
          session.state = 'working';
        }
        break;
      case 'needs_input':
        session.state = 'needs_you';
        if (event.summary) session.summary = event.summary;
        break;
      case 'turn_finished':
        session.state = 'done';
        session.pendingPermission = undefined;
        session.pendingPermissions = undefined;
        if (event.summary) session.summary = event.summary;
        break;
      case 'error':
        session.state = 'error';
        session.pendingPermission = undefined;
        session.pendingPermissions = undefined;
        session.summary = event.summary || event.errorMessage || 'Agent encountered an error.';
        break;
      case 'session_ended':
        session.state = 'ended';
        session.pendingPermission = undefined;
        session.pendingPermissions = undefined;
        session.endedReason = 'hook';
        break;
    }

    this.sessions.set(session.id, session);
    this.history.unshift(event);
    this.pruneByRetention(retentionDays);
    this.save();
    return session;
  }

  attachPendingPermission(sessionId: string, pending: PendingPermission): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const existing = s.pendingPermissions ?? (s.pendingPermission ? [s.pendingPermission] : []);
    const filtered = existing.filter((p) => p.requestId !== pending.requestId);
    filtered.push(pending);
    s.pendingPermissions = filtered;
    s.pendingPermission = filtered[0];
    s.state = 'needs_you';
    this.save();
  }

  clearPendingPermission(sessionId: string, requestId: string, nextState: SessionState): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const existing = s.pendingPermissions ?? (s.pendingPermission ? [s.pendingPermission] : []);
    const filtered = existing.filter((p) => p.requestId !== requestId);
    s.pendingPermissions = filtered.length > 0 ? filtered : undefined;
    s.pendingPermission = filtered[0];
    if (s.state !== 'ended') {
      s.state = filtered.length > 0 ? 'needs_you' : nextState;
    }
    this.save();
  }

  setTerminalWindowRef(sessionId: string, ref: TerminalWindowRef): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.terminalWindowRef = ref;
    this.save();
  }

  updateSummary(sessionId: string, summary: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.summary = summary;
    this.save();
  }

  expireStaleSessions(
    idleTimeoutMinutes: number,
    isPidAlive: (pid: number) => boolean,
    now = Date.now(),
  ): boolean {
    const idleMs = Math.max(1, idleTimeoutMinutes) * 60_000;
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.state === 'ended') continue;
      if (session.pid && !isPidAlive(session.pid)) {
        session.state = 'ended';
        session.pendingPermission = undefined;
        session.endedReason = 'process_exited';
        changed = true;
        continue;
      }
      if (now - session.lastEventAt > idleMs) {
        session.state = 'ended';
        session.pendingPermission = undefined;
        session.endedReason = 'idle_timeout';
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  pruneByRetention(retentionDays: number, now = Date.now()): void {
    const cutoff = now - Math.max(1, retentionDays) * 86_400_000;
    this.history = this.history.filter((e) => e.timestamp >= cutoff).slice(0, 5000);
    for (const [id, session] of this.sessions.entries()) {
      if (session.state === 'ended' && session.lastEventAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }

  clearHistory(): void {
    this.history = [];
    for (const [id, session] of this.sessions.entries()) {
      if (session.state === 'ended' || session.state === 'done') {
        this.sessions.delete(id);
      }
    }
    this.save();
  }

  dismissSession(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);
    if (existed) {
      this.save();
    }
    return existed;
  }

  filterHistory(filter: { agent?: AgentId | 'all'; state?: SessionState | 'all'; search?: string }): SessionRecord[] {
    const q = (filter.search || '').trim().toLowerCase();
    return this.getSessions().filter((s) => {
      if (filter.agent && filter.agent !== 'all' && s.agent !== filter.agent) return false;
      if (filter.state && filter.state !== 'all' && s.state !== filter.state) return false;
      if (q) {
        const hay = `${s.folderName} ${s.title} ${s.summary} ${s.cwd}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as SessionStoreData;
      for (const s of parsed.sessions ?? []) {
        // Pending permissions from previous app run cannot still be answered by hook; demote cleanly.
        if (s.pendingPermission) {
          s.pendingPermission = undefined;
          if (s.state === 'needs_you') s.state = 'done';
        }
        this.sessions.set(s.id, s);
      }
      this.history = Array.isArray(parsed.history) ? parsed.history : [];
    } catch {
      this.sessions.clear();
      this.history = [];
    }
  }

  private save(): void {
    const payload: SessionStoreData = {
      sessions: this.getSessions(),
      history: this.history.slice(0, 5000),
    };
    atomicWriteFileSync(this.filePath, JSON.stringify(payload, null, 2) + '\n');
  }
}
