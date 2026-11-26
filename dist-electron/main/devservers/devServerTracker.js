"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DevServerTracker = void 0;
exports.shortenDevCommand = shortenDevCommand;
function shortenDevCommand(commandLine, fallbackExe) {
    const clean = commandLine.trim();
    if (!clean)
        return fallbackExe;
    const patterns = [
        [/\bnext\s+dev\b/i, 'next dev'],
        [/\bvite(?:\.js)?(?:\s+dev)?\b/i, 'vite'],
        [/\bwrangler\s+dev\b/i, 'wrangler dev'],
        [/\bastro\s+dev\b/i, 'astro dev'],
        [/\bnuxt\s+dev\b/i, 'nuxt dev'],
        [/\bwebpack(?:-dev-server)?\s+serve\b/i, 'webpack serve'],
        [/\buvicorn\b/i, 'uvicorn'],
        [/\bflask\s+run\b/i, 'flask run'],
        [/\bcargo\s+run\b/i, 'cargo run'],
        [/\bgo\s+run\b/i, 'go run'],
    ];
    for (const [rx, label] of patterns) {
        if (rx.test(clean))
            return label;
    }
    // Strip executable path prefix for brevity
    const tokens = clean.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
        const firstBase = tokens[0].split(/[\\/]/).pop() || tokens[0];
        const secondBase = tokens[1].split(/[\\/]/).pop() || tokens[1];
        return `${firstBase} ${secondBase}`.slice(0, 42);
    }
    return (tokens[0]?.split(/[\\/]/).pop() || fallbackExe).slice(0, 42);
}
class DevServerTracker {
    driver;
    entries = [];
    firstDetectedAt = new Map();
    constructor(driver) {
        this.driver = driver;
    }
    getEntries() {
        return [...this.entries];
    }
    async poll(sessions, ownServerPort) {
        const activeSessions = sessions.filter((s) => s.state !== 'ended' && typeof s.pid === 'number' && s.pid > 0);
        if (activeSessions.length === 0) {
            this.entries = [];
            return [];
        }
        const [processes, listeners] = await Promise.all([
            this.driver.listProcesses(),
            this.driver.listTcpListeners(),
        ]);
        const byPid = new Map();
        for (const p of processes) {
            byPid.set(p.pid, p);
        }
        const sessionByPid = new Map();
        for (const s of activeSessions) {
            if (s.pid)
                sessionByPid.set(s.pid, s);
        }
        const matched = [];
        const seenPortPid = new Set();
        for (const listener of listeners) {
            if (listener.port <= 0)
                continue;
            if (ownServerPort && listener.port === ownServerPort)
                continue;
            if (listener.pid === process.pid)
                continue;
            const ownerSession = findOwningSession(listener.pid, byPid, sessionByPid);
            if (!ownerSession)
                continue;
            const dedupeKey = `${listener.pid}:${listener.port}`;
            if (seenPortPid.has(dedupeKey))
                continue;
            seenPortPid.add(dedupeKey);
            const proc = byPid.get(listener.pid);
            matched.push({
                pid: listener.pid,
                ppid: proc?.ppid,
                port: listener.port,
                host: normalizeLocalHost(listener.host),
                exeName: proc?.exeName || 'server',
                session: ownerSession.session,
                trackedChild: ownerSession.directChild,
            });
        }
        const cmdLines = await this.driver.getCommandLinesForPids(matched.map((m) => m.pid));
        const now = Date.now();
        const nextEntries = [];
        const activeKeys = new Set();
        for (const m of matched) {
            const id = `${m.pid}:${m.port}`;
            activeKeys.add(id);
            if (!this.firstDetectedAt.has(id)) {
                this.firstDetectedAt.set(id, now);
            }
            const cmd = cmdLines[m.pid] || m.exeName;
            nextEntries.push({
                id,
                pid: m.pid,
                ppid: m.ppid,
                port: m.port,
                host: m.host,
                url: `http://localhost:${m.port}`,
                command: cmd,
                commandShort: shortenDevCommand(cmd, m.exeName),
                sessionId: m.session.id,
                agent: m.session.agent,
                folderName: m.session.folderName,
                cwd: m.session.cwd,
                trackedChild: m.trackedChild,
                detectedAt: this.firstDetectedAt.get(id),
            });
        }
        for (const k of Array.from(this.firstDetectedAt.keys())) {
            if (!activeKeys.has(k))
                this.firstDetectedAt.delete(k);
        }
        nextEntries.sort((a, b) => a.port - b.port);
        this.entries = nextEntries;
        return this.getEntries();
    }
    async stopServer(pid) {
        const res = await this.driver.killProcessTree(pid);
        if (res.ok) {
            this.entries = this.entries.filter((e) => e.pid !== pid);
        }
        return res;
    }
}
exports.DevServerTracker = DevServerTracker;
function normalizeLocalHost(host) {
    if (!host || host === '0.0.0.0' || host === '::' || host === '::1')
        return 'localhost';
    return host;
}
function findOwningSession(listenerPid, byPid, sessionByPid) {
    let cur = listenerPid;
    const visited = new Set();
    let depth = 0;
    while (cur && !visited.has(cur) && depth < 32) {
        visited.add(cur);
        const direct = sessionByPid.get(cur);
        if (direct) {
            return { session: direct, directChild: depth > 0 };
        }
        cur = byPid.get(cur)?.ppid;
        depth++;
    }
    return null;
}
