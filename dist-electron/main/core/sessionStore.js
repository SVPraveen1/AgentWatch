"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const pathResolver_1 = require("../adapters/pathResolver");
const settingsStore_1 = require("./settingsStore");
const STATE_PRIORITY = {
    needs_you: 0,
    error: 1,
    working: 2,
    done: 3,
    ended: 4,
};
class SessionStore {
    filePath;
    sessions = new Map();
    history = [];
    constructor(dataDir) {
        this.filePath = node_path_1.default.join(dataDir, 'sessions.json');
        this.load();
    }
    getSessions() {
        return Array.from(this.sessions.values()).sort((a, b) => {
            const pDiff = STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state];
            if (pDiff !== 0)
                return pDiff;
            return b.lastEventAt - a.lastEventAt;
        });
    }
    getSession(id) {
        return this.sessions.get(id);
    }
    getHistory() {
        return [...this.history].sort((a, b) => b.timestamp - a.timestamp);
    }
    applyEvent(event, retentionDays = 90) {
        const existing = this.sessions.get(event.sessionId);
        const folderName = event.folderName || (0, pathResolver_1.getFolderNameFromCwd)(event.cwd);
        const session = existing
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
        if (event.cwd)
            session.cwd = event.cwd;
        if (folderName && folderName !== 'unknown')
            session.folderName = folderName;
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
                session.endedReason = undefined;
                break;
            case 'working':
                session.state = 'working';
                session.lastTool = event.toolName;
                session.pendingPermission = undefined;
                if (event.summary)
                    session.summary = event.summary;
                break;
            case 'permission_requested':
                session.state = 'needs_you';
                if (event.summary)
                    session.summary = event.summary;
                break;
            case 'permission_resolved':
                session.pendingPermission = undefined;
                session.state = event.decision === 'deny' ? 'needs_you' : 'working';
                break;
            case 'needs_input':
                session.state = 'needs_you';
                if (event.summary)
                    session.summary = event.summary;
                break;
            case 'turn_finished':
                session.state = 'done';
                session.pendingPermission = undefined;
                if (event.summary)
                    session.summary = event.summary;
                break;
            case 'error':
                session.state = 'error';
                session.pendingPermission = undefined;
                session.summary = event.summary || event.errorMessage || 'Agent encountered an error.';
                break;
            case 'session_ended':
                session.state = 'ended';
                session.pendingPermission = undefined;
                session.endedReason = 'hook';
                break;
        }
        this.sessions.set(session.id, session);
        this.history.unshift(event);
        this.pruneByRetention(retentionDays);
        this.save();
        return session;
    }
    attachPendingPermission(sessionId, pending) {
        const s = this.sessions.get(sessionId);
        if (!s)
            return;
        s.pendingPermission = pending;
        s.state = 'needs_you';
        this.save();
    }
    clearPendingPermission(sessionId, requestId, nextState) {
        const s = this.sessions.get(sessionId);
        if (!s || s.pendingPermission?.requestId !== requestId)
            return;
        s.pendingPermission = undefined;
        if (s.state !== 'ended') {
            s.state = nextState;
        }
        this.save();
    }
    setTerminalWindowRef(sessionId, ref) {
        const s = this.sessions.get(sessionId);
        if (!s)
            return;
        s.terminalWindowRef = ref;
        this.save();
    }
    updateSummary(sessionId, summary) {
        const s = this.sessions.get(sessionId);
        if (!s)
            return;
        s.summary = summary;
        this.save();
    }
    expireStaleSessions(idleTimeoutMinutes, isPidAlive, now = Date.now()) {
        const idleMs = Math.max(1, idleTimeoutMinutes) * 60_000;
        let changed = false;
        for (const session of this.sessions.values()) {
            if (session.state === 'ended')
                continue;
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
        if (changed)
            this.save();
        return changed;
    }
    pruneByRetention(retentionDays, now = Date.now()) {
        const cutoff = now - Math.max(1, retentionDays) * 86_400_000;
        this.history = this.history.filter((e) => e.timestamp >= cutoff).slice(0, 5000);
        for (const [id, session] of this.sessions.entries()) {
            if (session.state === 'ended' && session.lastEventAt < cutoff) {
                this.sessions.delete(id);
            }
        }
    }
    clearHistory() {
        this.history = [];
        for (const [id, session] of this.sessions.entries()) {
            if (session.state === 'ended' || session.state === 'done') {
                this.sessions.delete(id);
            }
        }
        this.save();
    }
    filterHistory(filter) {
        const q = (filter.search || '').trim().toLowerCase();
        return this.getSessions().filter((s) => {
            if (filter.agent && filter.agent !== 'all' && s.agent !== filter.agent)
                return false;
            if (filter.state && filter.state !== 'all' && s.state !== filter.state)
                return false;
            if (q) {
                const hay = `${s.folderName} ${s.title} ${s.summary} ${s.cwd}`.toLowerCase();
                if (!hay.includes(q))
                    return false;
            }
            return true;
        });
    }
    load() {
        try {
            if (!node_fs_1.default.existsSync(this.filePath))
                return;
            const parsed = JSON.parse(node_fs_1.default.readFileSync(this.filePath, 'utf8'));
            for (const s of parsed.sessions ?? []) {
                // Pending permissions from previous app run cannot still be answered by hook; demote cleanly.
                if (s.pendingPermission) {
                    s.pendingPermission = undefined;
                    if (s.state === 'needs_you')
                        s.state = 'done';
                }
                this.sessions.set(s.id, s);
            }
            this.history = Array.isArray(parsed.history) ? parsed.history : [];
        }
        catch {
            this.sessions.clear();
            this.history = [];
        }
    }
    save() {
        const payload = {
            sessions: this.getSessions(),
            history: this.history.slice(0, 5000),
        };
        (0, settingsStore_1.atomicWriteFileSync)(this.filePath, JSON.stringify(payload, null, 2) + '\n');
    }
}
exports.SessionStore = SessionStore;
