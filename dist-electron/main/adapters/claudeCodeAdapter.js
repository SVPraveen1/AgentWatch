"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudeCodeAdapter = void 0;
exports.isAgentWatchHookCommand = isAgentWatchHookCommand;
exports.extractToolCommandOrAction = extractToolCommandOrAction;
exports.resolveHookBinaryPath = resolveHookBinaryPath;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_util_1 = require("node:util");
const constants_1 = require("../../shared/constants");
const settingsStore_1 = require("../core/settingsStore");
const pathResolver_1 = require("./pathResolver");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const CLAUDE_HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'Notification',
    'Stop',
    'StopFailure',
    'SessionEnd',
];
function isAgentWatchHookCommand(cmd) {
    return typeof cmd === 'string' && cmd.toLowerCase().includes(constants_1.HOOK_BINARY_NAME);
}
function createBackupIfMissing(filePath) {
    if (!node_fs_1.default.existsSync(filePath))
        return;
    const bakPath = `${filePath}.agentwatch.bak`;
    if (!node_fs_1.default.existsSync(bakPath)) {
        node_fs_1.default.copyFileSync(filePath, bakPath);
    }
}
function extractToolCommandOrAction(toolName, toolInput) {
    if (typeof toolInput.command === 'string' && toolInput.command.trim()) {
        return toolInput.command.trim();
    }
    if (typeof toolInput.file_path === 'string' && toolInput.file_path.trim()) {
        return `${toolName} ${toolInput.file_path.trim()}`;
    }
    if (typeof toolInput.path === 'string' && toolInput.path.trim()) {
        return `${toolName} ${toolInput.path.trim()}`;
    }
    if (typeof toolInput.pattern === 'string' && toolInput.pattern.trim()) {
        return `${toolName} ${toolInput.pattern.trim()}`;
    }
    if (typeof toolInput.url === 'string' && toolInput.url.trim()) {
        return toolInput.url.trim();
    }
    return toolName;
}
class ClaudeCodeAdapter {
    id = 'claude_code';
    displayName = 'Claude Code';
    supportsBlockingPermissions = true;
    async detectInstalled(paths) {
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        try {
            const { stdout } = await execFileAsync(whichCmd, ['claude'], { timeout: 1500 });
            const bin = stdout.split(/\r?\n/)[0]?.trim();
            if (bin) {
                return { installed: true, details: `Found at ${bin}` };
            }
        }
        catch {
            // Fallback to checking ~/.claude directory
        }
        if (node_fs_1.default.existsSync(paths.claudeDir)) {
            return { installed: true, details: `Config folder present at ${paths.claudeDir}` };
        }
        return {
            installed: false,
            details: 'Claude Code CLI not found on PATH and ~/.claude does not exist yet.',
        };
    }
    async getStatus(paths) {
        const install = await this.detectInstalled(paths);
        const now = Date.now();
        try {
            if (!node_fs_1.default.existsSync(paths.claudeSettingsFile)) {
                return {
                    agent: this.id,
                    displayName: this.displayName,
                    installed: install.installed,
                    installDetails: install.details,
                    state: install.installed ? 'not_connected' : 'not_installed',
                    configPath: paths.claudeSettingsFile,
                    hookPresent: false,
                    supportsBlockingPermissions: true,
                    lastCheckedAt: now,
                };
            }
            const parsed = JSON.parse(node_fs_1.default.readFileSync(paths.claudeSettingsFile, 'utf8'));
            const hookPresent = this.hasOurHooks(parsed);
            return {
                agent: this.id,
                displayName: this.displayName,
                installed: install.installed,
                installDetails: install.details,
                state: hookPresent ? 'connected' : install.installed ? 'not_connected' : 'not_installed',
                configPath: paths.claudeSettingsFile,
                hookPresent,
                supportsBlockingPermissions: true,
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
                configPath: paths.claudeSettingsFile,
                hookPresent: false,
                supportsBlockingPermissions: true,
                lastCheckedAt: now,
                error: `Could not read ${paths.claudeSettingsFile}: ${String(err)}`,
            };
        }
    }
    async connect(paths, options) {
        node_fs_1.default.mkdirSync(paths.claudeDir, { recursive: true });
        createBackupIfMissing(paths.claudeSettingsFile);
        let root = {};
        if (node_fs_1.default.existsSync(paths.claudeSettingsFile)) {
            const raw = node_fs_1.default.readFileSync(paths.claudeSettingsFile, 'utf8').trim();
            if (raw) {
                root = JSON.parse(raw);
            }
        }
        // Remove stale AgentWatch hooks first so re-connecting is idempotent and updates paths/timeouts.
        this.stripOurHooks(root);
        const hooksObj = root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
            ? root.hooks
            : {};
        for (const eventName of CLAUDE_HOOK_EVENTS) {
            const existingList = Array.isArray(hooksObj[eventName])
                ? hooksObj[eventName]
                : [];
            const isBlocking = eventName === 'PermissionRequest';
            const args = ['--agent', 'claude_code', '--event', eventName];
            if (isBlocking) {
                args.push('--wait', '--wait-seconds', String(options.permissionTimeoutSeconds + 30));
            }
            const command = (0, pathResolver_1.formatHookCommand)(options.hookExecutablePath, args);
            const entry = {
                matcher: '',
                hooks: [
                    {
                        type: 'command',
                        command,
                        timeout: isBlocking ? options.permissionTimeoutSeconds + 35 : 5,
                    },
                ],
            };
            hooksObj[eventName] = [...existingList, entry];
        }
        root.hooks = hooksObj;
        // Optional opt-in StatusLine bridge (never clobber existing user statusLine unless wrapped)
        if (options.enableClaudeStatusLineBridge && options.statusLineCacheFile) {
            this.attachStatusLineBridge(root, options.hookExecutablePath, options.statusLineCacheFile);
        }
        (0, settingsStore_1.atomicWriteFileSync)(paths.claudeSettingsFile, JSON.stringify(root, null, 2) + '\n');
        return this.getStatus(paths);
    }
    async disconnect(paths) {
        if (!node_fs_1.default.existsSync(paths.claudeSettingsFile)) {
            return this.getStatus(paths);
        }
        createBackupIfMissing(paths.claudeSettingsFile);
        const raw = node_fs_1.default.readFileSync(paths.claudeSettingsFile, 'utf8').trim();
        if (!raw)
            return this.getStatus(paths);
        const root = JSON.parse(raw);
        this.stripOurHooks(root);
        this.detachStatusLineBridge(root);
        (0, settingsStore_1.atomicWriteFileSync)(paths.claudeSettingsFile, JSON.stringify(root, null, 2) + '\n');
        return this.getStatus(paths);
    }
    attachStatusLineBridge(root, hookExecutablePath, cacheFile) {
        const existing = root.statusLine;
        const args = ['--agent', 'claude_code', '--event', 'StatusLine', '--cache-file', cacheFile];
        if (existing && typeof existing.command === 'string' && !isAgentWatchHookCommand(existing.command)) {
            args.push('--chain-statusline', existing.command);
        }
        root.statusLine = {
            type: 'command',
            command: (0, pathResolver_1.formatHookCommand)(hookExecutablePath, args),
        };
    }
    detachStatusLineBridge(root) {
        const existing = root.statusLine;
        if (!existing || !isAgentWatchHookCommand(existing.command))
            return;
        const cmd = String(existing.command);
        const chainIdx = cmd.indexOf('--chain-statusline ');
        if (chainIdx !== -1) {
            const original = cmd.slice(chainIdx + '--chain-statusline '.length).replace(/^"(.*)"$/, '$1');
            root.statusLine = { type: 'command', command: original };
        }
        else {
            delete root.statusLine;
        }
    }
    hasOurHooks(root) {
        const hooks = root.hooks;
        if (!hooks || typeof hooks !== 'object')
            return false;
        for (const val of Object.values(hooks)) {
            if (!Array.isArray(val))
                continue;
            for (const group of val) {
                if (!group || !Array.isArray(group.hooks))
                    continue;
                if (group.hooks.some((h) => isAgentWatchHookCommand(h?.command))) {
                    return true;
                }
            }
        }
        return false;
    }
    stripOurHooks(root) {
        const hooks = root.hooks;
        if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
            return;
        const hooksMap = hooks;
        for (const [eventName, groups] of Object.entries(hooksMap)) {
            if (!Array.isArray(groups))
                continue;
            const filteredGroups = [];
            for (const group of groups) {
                if (!group || !Array.isArray(group.hooks)) {
                    filteredGroups.push(group);
                    continue;
                }
                const remainingHooks = group.hooks.filter((h) => !isAgentWatchHookCommand(h?.command));
                if (remainingHooks.length > 0) {
                    filteredGroups.push({ ...group, hooks: remainingHooks });
                }
            }
            if (filteredGroups.length > 0) {
                hooksMap[eventName] = filteredGroups;
            }
            else {
                delete hooksMap[eventName];
            }
        }
        if (Object.keys(hooksMap).length === 0) {
            delete root.hooks;
        }
    }
    normalizeHookEvent(envelope) {
        const p = envelope.payload ?? {};
        const hookEvent = String(p.hook_event_name || envelope.hookEvent || '');
        const sessionId = String(p.session_id || 'claude-unknown');
        const cwd = String(p.cwd || '');
        const folderName = (0, pathResolver_1.getFolderNameFromCwd)(cwd);
        const timestamp = envelope.sentAt || Date.now();
        const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : undefined;
        const toolName = typeof p.tool_name === 'string' ? p.tool_name : undefined;
        const rawInput = p.tool_input && typeof p.tool_input === 'object' && !Array.isArray(p.tool_input)
            ? p.tool_input
            : {};
        const commandOrAction = toolName ? extractToolCommandOrAction(toolName, rawInput) : undefined;
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
        switch (hookEvent) {
            case 'SessionStart':
                return {
                    ...base,
                    type: 'session_started',
                    title: folderName,
                };
            case 'UserPromptSubmit': {
                const prompt = typeof p.prompt === 'string' ? p.prompt.trim() : '';
                const title = prompt ? prompt.split(/\r?\n/)[0].slice(0, 64) : undefined;
                return {
                    ...base,
                    type: 'prompt_submitted',
                    title,
                };
            }
            case 'PreToolUse':
                return {
                    ...base,
                    type: 'working',
                    toolName: toolName || 'Tool',
                    commandOrAction,
                    rawInput,
                };
            case 'PermissionRequest':
                return {
                    ...base,
                    type: 'permission_requested',
                    requestId: node_crypto_1.default.randomUUID(),
                    toolName: toolName || 'Tool',
                    commandOrAction: commandOrAction || toolName || 'Action',
                    rawInput,
                    readOnlyInTerminal: false,
                };
            case 'Notification': {
                const nType = String(p.notification_type || '');
                const msg = typeof p.message === 'string' ? p.message : undefined;
                if (nType === 'auth_success')
                    return null;
                if (nType === 'permission_prompt') {
                    // PermissionRequest hook handles interactive approval; ignore duplicate notification unless needed.
                    return null;
                }
                return {
                    ...base,
                    type: 'needs_input',
                    summary: msg,
                };
            }
            case 'Stop':
                return {
                    ...base,
                    type: 'turn_finished',
                    lastAssistantMessage: typeof p.last_assistant_message === 'string' ? p.last_assistant_message : undefined,
                };
            case 'StopFailure':
                return {
                    ...base,
                    type: 'error',
                    errorMessage: String(p.error_message || p.error || p.error_type || 'Turn failed with API error'),
                };
            case 'SessionEnd':
                return {
                    ...base,
                    type: 'session_ended',
                };
            default:
                return null;
        }
    }
}
exports.ClaudeCodeAdapter = ClaudeCodeAdapter;
function resolveHookBinaryPath(appResourcesPath) {
    const isWin = process.platform === 'win32';
    const archFolder = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
    const binName = isWin ? `${constants_1.HOOK_BINARY_NAME}.exe` : constants_1.HOOK_BINARY_NAME;
    const candidates = [
        appResourcesPath ? node_path_1.default.join(appResourcesPath, 'bin', isWin ? archFolder : '', binName) : '',
        node_path_1.default.resolve(process.cwd(), 'resources', 'bin', isWin ? archFolder : '', binName),
        node_path_1.default.resolve(__dirname, '..', '..', '..', 'resources', 'bin', isWin ? archFolder : '', binName),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (node_fs_1.default.existsSync(candidate)) {
            return candidate;
        }
    }
    return candidates[0];
}
