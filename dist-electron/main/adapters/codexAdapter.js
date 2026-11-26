"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexAdapter = void 0;
exports.syncCodexManagedInstructions = syncCodexManagedInstructions;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_util_1 = require("node:util");
const settingsStore_1 = require("../core/settingsStore");
const summaryPipeline_1 = require("../summaries/summaryPipeline");
const claudeCodeAdapter_1 = require("./claudeCodeAdapter");
const pathResolver_1 = require("./pathResolver");
const tomlPatcher_1 = require("./tomlPatcher");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const CODEX_HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PermissionRequest',
    'Stop',
];
function backupIfMissing(filePath) {
    if (!node_fs_1.default.existsSync(filePath))
        return;
    const bak = `${filePath}.agentwatch.bak`;
    if (!node_fs_1.default.existsSync(bak)) {
        node_fs_1.default.copyFileSync(filePath, bak);
    }
}
class CodexAdapter {
    id = 'codex';
    displayName = 'Codex';
    supportsBlockingPermissions = false;
    limitationNote = 'Codex CLI permissions on Windows fall back to read-only "Needs you in terminal" alerts unless interactive hooks are enabled & trusted in Codex.';
    async detectInstalled(paths) {
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        try {
            const { stdout } = await execFileAsync(whichCmd, ['codex'], { timeout: 1500 });
            const bin = stdout.split(/\r?\n/)[0]?.trim();
            if (bin) {
                return { installed: true, details: `Found at ${bin}` };
            }
        }
        catch {
            // Fallback to checking ~/.codex or CODEX_HOME
        }
        if (node_fs_1.default.existsSync(paths.codexHomeDir)) {
            return { installed: true, details: `Codex home present at ${paths.codexHomeDir}` };
        }
        return {
            installed: false,
            details: 'Codex CLI not found on PATH and ~/.codex / CODEX_HOME does not exist yet.',
        };
    }
    async getStatus(paths) {
        const install = await this.detectInstalled(paths);
        const now = Date.now();
        try {
            const configRaw = node_fs_1.default.existsSync(paths.codexConfigFile)
                ? node_fs_1.default.readFileSync(paths.codexConfigFile, 'utf8')
                : '';
            const hasNotify = (0, tomlPatcher_1.hasCodexConfigHook)(configRaw);
            const hasHooksJson = this.hasHooksJsonEntry(paths.codexHooksFile);
            const hookPresent = hasNotify || hasHooksJson;
            return {
                agent: this.id,
                displayName: this.displayName,
                installed: install.installed,
                installDetails: install.details,
                state: hookPresent ? 'connected' : install.installed ? 'not_connected' : 'not_installed',
                configPath: paths.codexConfigFile,
                hookPresent,
                supportsBlockingPermissions: false,
                limitationNote: this.limitationNote,
                lastCheckedAt: now,
            };
        }
        catch (err) {
            return {
                agent: this.id,
                displayName: this.displayName,
                installed: install.installed,
                installDetails: install.details,
                state: 'error',
                configPath: paths.codexConfigFile,
                hookPresent: false,
                supportsBlockingPermissions: false,
                limitationNote: this.limitationNote,
                lastCheckedAt: now,
                error: `Failed to inspect Codex config: ${String(err)}`,
            };
        }
    }
    async connect(paths, options) {
        node_fs_1.default.mkdirSync(paths.codexHomeDir, { recursive: true });
        backupIfMissing(paths.codexConfigFile);
        backupIfMissing(paths.codexHooksFile);
        const existingToml = node_fs_1.default.existsSync(paths.codexConfigFile)
            ? node_fs_1.default.readFileSync(paths.codexConfigFile, 'utf8')
            : '';
        const patchedToml = (0, tomlPatcher_1.patchCodexConfigToml)(existingToml, [options.hookExecutablePath, '--agent', 'codex', '--event', 'notify'], true);
        (0, settingsStore_1.atomicWriteFileSync)(paths.codexConfigFile, patchedToml);
        this.connectHooksJson(paths.codexHooksFile, options);
        syncCodexManagedInstructions(paths.codexManagedInstructionsFile, options.askAgentsForSummaries);
        return this.getStatus(paths);
    }
    async disconnect(paths) {
        if (node_fs_1.default.existsSync(paths.codexConfigFile)) {
            backupIfMissing(paths.codexConfigFile);
            const existingToml = node_fs_1.default.readFileSync(paths.codexConfigFile, 'utf8');
            const restored = (0, tomlPatcher_1.unpatchCodexConfigToml)(existingToml);
            (0, settingsStore_1.atomicWriteFileSync)(paths.codexConfigFile, restored);
        }
        this.disconnectHooksJson(paths.codexHooksFile);
        syncCodexManagedInstructions(paths.codexManagedInstructionsFile, false);
        return this.getStatus(paths);
    }
    hasHooksJsonEntry(hooksPath) {
        if (!node_fs_1.default.existsSync(hooksPath))
            return false;
        const raw = node_fs_1.default.readFileSync(hooksPath, 'utf8').trim();
        if (!raw)
            return false;
        const parsed = JSON.parse(raw);
        const hooksObj = (parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : parsed);
        for (const val of Object.values(hooksObj)) {
            if (!Array.isArray(val))
                continue;
            for (const grp of val) {
                if (grp?.hooks?.some((h) => (0, claudeCodeAdapter_1.isAgentWatchHookCommand)(h?.command) || (0, claudeCodeAdapter_1.isAgentWatchHookCommand)(h?.commandWindows))) {
                    return true;
                }
            }
        }
        return false;
    }
    connectHooksJson(hooksPath, options) {
        let root = {};
        let hadHooksFile = false;
        if (node_fs_1.default.existsSync(hooksPath)) {
            hadHooksFile = true;
            const raw = node_fs_1.default.readFileSync(hooksPath, 'utf8').trim();
            if (raw) {
                root = JSON.parse(raw);
            }
        }
        this.stripHooksJson(root);
        const hooksObj = root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
            ? root.hooks
            : {};
        for (const eventName of CODEX_HOOK_EVENTS) {
            const existing = Array.isArray(hooksObj[eventName]) ? hooksObj[eventName] : [];
            const isBlocking = eventName === 'PermissionRequest';
            const args = ['--agent', 'codex', '--event', eventName];
            if (isBlocking) {
                args.push('--wait', '--wait-seconds', String(options.permissionTimeoutSeconds + 30));
            }
            const cmd = (0, pathResolver_1.formatHookCommand)(options.hookExecutablePath, args);
            const entry = {
                matcher: eventName === 'PreToolUse' || eventName === 'PostToolUse' ? '.*' : undefined,
                hooks: [
                    {
                        type: 'command',
                        command: cmd,
                        timeout: isBlocking ? options.permissionTimeoutSeconds + 35 : 5,
                    },
                ],
            };
            if (entry.matcher === undefined) {
                delete entry.matcher;
            }
            hooksObj[eventName] = [...existing, entry];
        }
        if (!hadHooksFile || Object.keys(root).length === 0 || root.hooks !== undefined) {
            root.hooks = hooksObj;
        }
        (0, settingsStore_1.atomicWriteFileSync)(hooksPath, JSON.stringify(root, null, 2) + '\n');
    }
    disconnectHooksJson(hooksPath) {
        if (!node_fs_1.default.existsSync(hooksPath))
            return;
        const raw = node_fs_1.default.readFileSync(hooksPath, 'utf8').trim();
        if (!raw)
            return;
        const root = JSON.parse(raw);
        this.stripHooksJson(root);
        if (Object.keys(root).length === 0 && !node_fs_1.default.existsSync(`${hooksPath}.agentwatch.bak`)) {
            node_fs_1.default.unlinkSync(hooksPath);
        }
        else {
            (0, settingsStore_1.atomicWriteFileSync)(hooksPath, JSON.stringify(root, null, 2) + '\n');
        }
    }
    stripHooksJson(root) {
        const hooksObj = root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
            ? root.hooks
            : root;
        for (const [key, val] of Object.entries(hooksObj)) {
            if (!Array.isArray(val))
                continue;
            const kept = [];
            for (const grp of val) {
                if (!grp || !Array.isArray(grp.hooks)) {
                    kept.push(grp);
                    continue;
                }
                const rem = grp.hooks.filter((h) => !(0, claudeCodeAdapter_1.isAgentWatchHookCommand)(h?.command) && !(0, claudeCodeAdapter_1.isAgentWatchHookCommand)(h?.commandWindows));
                if (rem.length > 0) {
                    kept.push({ ...grp, hooks: rem });
                }
            }
            if (kept.length > 0) {
                hooksObj[key] = kept;
            }
            else {
                delete hooksObj[key];
            }
        }
        if (root.hooks && typeof root.hooks === 'object' && Object.keys(root.hooks).length === 0) {
            delete root.hooks;
        }
    }
    normalizeHookEvent(envelope) {
        const p = envelope.payload ?? {};
        const eventType = String(p.hook_event_name || p.type || envelope.hookEvent || '');
        const sessionId = String(p.session_id || p['thread-id'] || p.thread_id || 'codex-unknown');
        const cwd = String(p.cwd || '');
        const folderName = (0, pathResolver_1.getFolderNameFromCwd)(cwd);
        const timestamp = envelope.sentAt || Date.now();
        const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : undefined;
        const base = {
            id: node_crypto_1.default.randomUUID(),
            agent: this.id,
            sessionId,
            timestamp,
            cwd,
            folderName,
            pid: envelope.ppid,
            transcriptPath,
            rawPayload: p,
        };
        // Handle `notify` payloads from config.toml
        if (eventType === 'agent-turn-complete' || (eventType === 'notify' && p.type === 'agent-turn-complete')) {
            const lastMsg = typeof p['last-assistant-message'] === 'string'
                ? p['last-assistant-message']
                : typeof p.last_assistant_message === 'string'
                    ? p.last_assistant_message
                    : undefined;
            const inputMsgs = Array.isArray(p['input-messages']) ? p['input-messages'] : [];
            const firstPrompt = typeof inputMsgs[0] === 'string' ? inputMsgs[0].slice(0, 64) : undefined;
            return {
                ...base,
                type: 'turn_finished',
                title: firstPrompt,
                lastAssistantMessage: lastMsg,
            };
        }
        if (eventType === 'approval-requested' || (eventType === 'notify' && p.type === 'approval-requested')) {
            return {
                ...base,
                type: 'permission_requested',
                requestId: node_crypto_1.default.randomUUID(),
                toolName: String(p.tool_name || 'Codex Approval'),
                commandOrAction: String(p.command || p.reason || 'Approval requested in Codex terminal'),
                rawInput: p,
                readOnlyInTerminal: true,
            };
        }
        const toolName = typeof p.tool_name === 'string' ? p.tool_name : undefined;
        const rawInput = p.tool_input && typeof p.tool_input === 'object' && !Array.isArray(p.tool_input)
            ? p.tool_input
            : {};
        const commandOrAction = toolName ? (0, claudeCodeAdapter_1.extractToolCommandOrAction)(toolName, rawInput) : undefined;
        switch (eventType) {
            case 'SessionStart':
                return { ...base, type: 'session_started', title: folderName };
            case 'UserPromptSubmit': {
                const prompt = typeof p.prompt === 'string' ? p.prompt.trim() : '';
                return {
                    ...base,
                    type: 'prompt_submitted',
                    title: prompt ? prompt.split(/\r?\n/)[0].slice(0, 64) : undefined,
                };
            }
            case 'PreToolUse':
            case 'PostToolUse':
                return {
                    ...base,
                    type: 'working',
                    toolName: toolName || 'Codex Tool',
                    commandOrAction,
                    rawInput,
                };
            case 'PermissionRequest':
                return {
                    ...base,
                    type: 'permission_requested',
                    requestId: node_crypto_1.default.randomUUID(),
                    toolName: toolName || 'Codex Tool',
                    commandOrAction: commandOrAction || toolName || 'Action',
                    rawInput,
                    readOnlyInTerminal: false,
                };
            case 'Stop':
                return {
                    ...base,
                    type: 'turn_finished',
                    lastAssistantMessage: typeof p.last_assistant_message === 'string' ? p.last_assistant_message : undefined,
                };
            case 'SessionEnd':
                return { ...base, type: 'session_ended' };
            default:
                return null;
        }
    }
}
exports.CodexAdapter = CodexAdapter;
const AGENTS_START_MARKER = '<!-- AGENTWATCH_SUMMARY_START -->';
const AGENTS_END_MARKER = '<!-- AGENTWATCH_SUMMARY_END -->';
function syncCodexManagedInstructions(filePath, enabled) {
    const existing = node_fs_1.default.existsSync(filePath) ? node_fs_1.default.readFileSync(filePath, 'utf8') : '';
    const blockRegex = new RegExp(`\\r?\\n?${AGENTS_START_MARKER}[\\s\\S]*?${AGENTS_END_MARKER}\\r?\\n?`, 'g');
    const stripped = existing.replace(blockRegex, '').trim();
    if (!enabled) {
        if (!node_fs_1.default.existsSync(filePath))
            return;
        if (!stripped && !node_fs_1.default.existsSync(`${filePath}.agentwatch.bak`)) {
            node_fs_1.default.unlinkSync(filePath);
        }
        else {
            (0, settingsStore_1.atomicWriteFileSync)(filePath, stripped ? stripped + '\n' : '');
        }
        return;
    }
    if (existing)
        backupIfMissing(filePath);
    const block = [
        AGENTS_START_MARKER,
        summaryPipeline_1.SUMMARY_CONTEXT_INSTRUCTION,
        AGENTS_END_MARKER,
    ].join('\n');
    const next = stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
    (0, settingsStore_1.atomicWriteFileSync)(filePath, next);
}
