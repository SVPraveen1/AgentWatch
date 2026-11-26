"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexRolloutWatcher = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const pathResolver_1 = require("./pathResolver");
/**
 * Watches recent Codex rollout-*.jsonl files incrementally so sessions and read-only
 * terminal approval / turn states surface even when Codex hooks aren't active.
 */
class CodexRolloutWatcher {
    cursors = new Map();
    initialized = false;
    poll(sessionsDir, onEvent) {
        if (!node_fs_1.default.existsSync(sessionsDir))
            return;
        const files = findRecentRolloutFiles(sessionsDir, 20);
        const isInitialScan = !this.initialized;
        this.initialized = true;
        for (const filePath of files) {
            let stat;
            try {
                stat = node_fs_1.default.statSync(filePath);
            }
            catch {
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
                if (stat.size < cursor.offset)
                    cursor.offset = 0;
                continue;
            }
            const len = Math.min(stat.size - cursor.offset, 512 * 1024);
            const buf = Buffer.alloc(len);
            let fd;
            try {
                fd = node_fs_1.default.openSync(filePath, 'r');
                node_fs_1.default.readSync(fd, buf, 0, len, cursor.offset);
            }
            catch {
                continue;
            }
            finally {
                if (fd !== undefined)
                    node_fs_1.default.closeSync(fd);
            }
            const chunk = buf.toString('utf8');
            const lastNewline = chunk.lastIndexOf('\n');
            if (lastNewline === -1)
                continue;
            cursor.offset += Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8');
            const lines = chunk.slice(0, lastNewline).split(/\r?\n/);
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const parsed = JSON.parse(line);
                    const ev = this.parseRolloutLine(parsed, filePath, cursor);
                    if (ev)
                        onEvent(ev);
                }
                catch {
                    // Ignore partial or malformed lines.
                }
            }
        }
    }
    parseRolloutLine(line, filePath, cursor) {
        const type = String(line.type || '');
        const payload = (line.payload && typeof line.payload === 'object'
            ? line.payload
            : {});
        if (type === 'session_meta') {
            cursor.sessionId = String(payload.id || payload.session_id || node_path_1.default.basename(filePath, '.jsonl'));
            cursor.cwd = String(payload.cwd || '');
            return {
                id: node_crypto_1.default.randomUUID(),
                type: 'session_started',
                agent: 'codex',
                sessionId: cursor.sessionId,
                timestamp: Date.now(),
                cwd: cursor.cwd,
                folderName: (0, pathResolver_1.getFolderNameFromCwd)(cursor.cwd),
                transcriptPath: filePath,
            };
        }
        const sessionId = cursor.sessionId || node_path_1.default.basename(filePath, '.jsonl');
        const cwd = cursor.cwd || '';
        const folderName = (0, pathResolver_1.getFolderNameFromCwd)(cwd);
        if (type === 'event_msg') {
            const pType = String(payload.type || '');
            if (pType === 'exec_approval_request' || pType === 'apply_patch_approval_request') {
                const command = Array.isArray(payload.command)
                    ? payload.command.join(' ')
                    : String(payload.command || payload.reason || 'Codex approval requested');
                return {
                    id: node_crypto_1.default.randomUUID(),
                    type: 'permission_requested',
                    requestId: String(payload.call_id || node_crypto_1.default.randomUUID()),
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
                    id: node_crypto_1.default.randomUUID(),
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
exports.CodexRolloutWatcher = CodexRolloutWatcher;
function findRecentRolloutFiles(rootDir, limit) {
    const results = [];
    const stack = [rootDir];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const ent of entries) {
            const full = node_path_1.default.join(dir, ent.name);
            if (ent.isDirectory()) {
                stack.push(full);
            }
            else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
                try {
                    const st = node_fs_1.default.statSync(full);
                    results.push({ file: full, mtimeMs: st.mtimeMs });
                }
                catch {
                    // Ignore vanished files.
                }
            }
        }
    }
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return results.slice(0, limit).map((r) => r.file);
}
