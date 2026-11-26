"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const constants_1 = require("../shared/constants");
const claudeCodeAdapter_1 = require("./adapters/claudeCodeAdapter");
const codexAdapter_1 = require("./adapters/codexAdapter");
const codexWatcher_1 = require("./adapters/codexWatcher");
const pathResolver_1 = require("./adapters/pathResolver");
const registry_1 = require("./adapters/registry");
const tokenAnalytics_1 = require("./analytics/tokenAnalytics");
const usageProviders_1 = require("./analytics/usageProviders");
const eventBus_1 = require("./core/eventBus");
const localServer_1 = require("./core/localServer");
const logger_1 = require("./core/logger");
const secureStore_1 = require("./core/secureStore");
const sessionStore_1 = require("./core/sessionStore");
const settingsStore_1 = require("./core/settingsStore");
const devServerTracker_1 = require("./devservers/devServerTracker");
const hotkeyManager_1 = require("./permissions/hotkeyManager");
const permissionManager_1 = require("./permissions/permissionManager");
const ruleMatcher_1 = require("./permissions/ruleMatcher");
const platformDriver_1 = require("./platform/platformDriver");
const summaryPipeline_1 = require("./summaries/summaryPipeline");
const windowManager_1 = require("./windows/windowManager");
// Handle headless uninstall hook cleanup before single-instance lock / GUI init.
if (process.argv.includes('--disconnect-hooks')) {
    void electron_1.app.whenReady().then(async () => {
        try {
            const settings = new settingsStore_1.SettingsStore((0, settingsStore_1.getAppDataDir)()).get();
            const paths = (0, pathResolver_1.resolveAgentPaths)({
                wsl: { enabled: settings.wsl.enabled, distro: settings.wsl.distro },
            });
            await new claudeCodeAdapter_1.ClaudeCodeAdapter().disconnect(paths);
            await new codexAdapter_1.CodexAdapter().disconnect(paths);
        }
        catch {
            // Never block uninstaller on missing/invalid configs.
        }
        electron_1.app.exit(0);
    });
}
else {
    const gotLock = electron_1.app.requestSingleInstanceLock();
    if (!gotLock) {
        electron_1.app.quit();
        process.exit(0);
    }
}
let dataDir = '';
let settingsStore;
let logger;
let secretStore;
let sessionStore;
let ruleStore;
let permissionManager;
let hotkeyManager;
let eventBus;
let registry;
let codexWatcher;
let summaryPipeline;
let analyticsEngine;
let claudeUsageProvider;
let codexUsageProvider;
let platformDriver;
let devServerTracker;
let analyticsRange = 'this_month';
let analyticsCache;
let usageCache;
let localServer;
let windowManager;
let connectionsCache;
let overlayExpanded = false;
let autoCollapseTimer = null;
let noticeTimer = null;
let reaperTimer = null;
let codexWatchTimer = null;
let analyticsTimer = null;
let devServerTimer = null;
let fullscreenTimer = null;
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        const code = err?.code;
        return code === 'EPERM';
    }
}
function getAgentPathsForSettings(settings) {
    return (0, pathResolver_1.resolveAgentPaths)({
        wsl: {
            enabled: settings.wsl.enabled,
            distro: settings.wsl.distro,
        },
    });
}
async function refreshConnections() {
    const settings = settingsStore.get();
    connectionsCache = await registry.getAllStatuses(getAgentPathsForSettings(settings));
    broadcast();
}
function syncHotkeys() {
    const settings = settingsStore.get();
    const hasInteractivePending = permissionManager
        .getPending()
        .some((p) => !p.readOnlyInTerminal);
    hotkeyManager.sync(hasInteractivePending, settings.hotkeys, {
        onAllow: () => {
            permissionManager.resolveTop('allow', false);
        },
        onAlwaysAllow: () => {
            permissionManager.resolveTop('allow', true);
        },
        onDeny: () => {
            permissionManager.resolveTop('deny', false);
        },
    });
}
function refreshAnalyticsAndUsage(shouldBroadcast = true) {
    const settings = settingsStore.get();
    const paths = getAgentPathsForSettings(settings);
    analyticsCache = analyticsEngine.buildReport(paths, analyticsRange);
    usageCache = {
        claude_code: claudeUsageProvider.getUsage(paths, settings),
        codex: codexUsageProvider.getUsage(paths, settings),
    };
    if (shouldBroadcast)
        broadcast();
}
function buildSnapshot() {
    const settings = settingsStore.get();
    const sessions = sessionStore.getSessions();
    const interactivePending = permissionManager.getPending();
    const readOnlyPending = sessions
        .map((s) => s.pendingPermission)
        .filter((p) => Boolean(p && p.readOnlyInTerminal));
    return {
        appName: constants_1.APP_NAME,
        version: electron_1.app.getVersion(),
        platform: process.platform,
        resolvedTheme: windowManager.getResolvedTheme(),
        systemReducedMotion: windowManager.getSystemReducedMotion(),
        settings,
        sessions,
        history: sessionStore.getHistory(),
        pendingPermissions: [...interactivePending, ...readOnlyPending],
        permissionNotice: permissionManager.getLastNotice(),
        rules: ruleStore.list(),
        connections: connectionsCache,
        usage: usageCache,
        analytics: analyticsCache,
        devServers: devServerTracker.getEntries(),
        hotkeyConflicts: (0, hotkeyManager_1.detectHotkeyConflicts)(settings.hotkeys),
        overlayExpanded,
        overlayVisible: windowManager.isOverlayVisible(),
    };
}
function broadcast() {
    if (!windowManager)
        return;
    windowManager.broadcastSnapshot(buildSnapshot());
}
function expandOverlay(autoCollapseMs) {
    if (autoCollapseTimer) {
        clearTimeout(autoCollapseTimer);
        autoCollapseTimer = null;
    }
    overlayExpanded = true;
    windowManager.ensureOverlayVisibleForEvent(settingsStore.get());
    windowManager.setOverlayExpanded(true);
    broadcast();
    if (autoCollapseMs && autoCollapseMs > 0) {
        autoCollapseTimer = setTimeout(() => {
            if (permissionManager.getPending().length === 0) {
                overlayExpanded = false;
                windowManager.setOverlayExpanded(false);
                broadcast();
            }
        }, autoCollapseMs);
    }
}
async function handleNormalizedEvent(event, registerDisconnect) {
    const settings = settingsStore.get();
    if (event.type === 'turn_finished' ||
        event.type === 'permission_requested' ||
        event.type === 'needs_input' ||
        event.type === 'error') {
        event.summary = await summaryPipeline.generateSummary(event, {
            askAgents: settings.summaries.askAgents,
            llmSummarizerEnabled: settings.summaries.llmSummarizerEnabled,
        });
    }
    sessionStore.applyEvent(event, settings.data.retentionDays);
    eventBus.emitNormalizedEvent(event);
    if (event.pid && !sessionStore.getSession(event.sessionId)?.terminalWindowRef) {
        void platformDriver.resolveTerminalRef(event.pid).then((ref) => {
            if (ref)
                sessionStore.setTerminalWindowRef(event.sessionId, ref);
        });
    }
    if (event.type === 'prompt_submitted' && settings.summaries.askAgents) {
        broadcast();
        return {
            ok: true,
            stdoutJson: {
                hookSpecificOutput: {
                    hookEventName: 'UserPromptSubmit',
                    additionalContext: summaryPipeline_1.SUMMARY_CONTEXT_INSTRUCTION,
                },
            },
        };
    }
    if (event.type === 'permission_requested') {
        const requestId = event.requestId || event.id;
        if (event.readOnlyInTerminal) {
            sessionStore.attachPendingPermission(event.sessionId, {
                requestId,
                sessionId: event.sessionId,
                agent: event.agent,
                toolName: event.toolName || 'Codex Approval',
                commandOrAction: event.commandOrAction || 'Approval requested in Codex terminal',
                rawInput: event.rawInput ?? {},
                cwd: event.cwd,
                folderName: event.folderName,
                requestedAt: event.timestamp,
                expiresAt: event.timestamp + settings.permissions.timeoutSeconds * 1000,
                readOnlyInTerminal: true,
            });
            if (!settings.overlay.paused) {
                expandOverlay(0);
            }
            else {
                broadcast();
            }
            return { ok: true };
        }
        const { autoMatchedRule, promise, cancelOnDisconnect } = permissionManager.enqueue({
            requestId,
            sessionId: event.sessionId,
            agent: event.agent,
            toolName: event.toolName || 'Tool',
            commandOrAction: event.commandOrAction || event.toolName || 'Action',
            rawInput: event.rawInput ?? {},
            cwd: event.cwd,
            folderName: event.folderName,
            timeoutSeconds: settings.permissions.timeoutSeconds,
            readOnlyInTerminal: event.readOnlyInTerminal,
        });
        if (!autoMatchedRule) {
            const top = permissionManager.getPending().find((p) => p.requestId === requestId);
            if (top) {
                sessionStore.attachPendingPermission(event.sessionId, top);
            }
            registerDisconnect?.(cancelOnDisconnect);
            if (!settings.overlay.paused) {
                expandOverlay(0); // Never auto-collapse while permission is pending.
            }
            else {
                broadcast();
            }
        }
        return promise;
    }
    if (event.type === 'turn_finished') {
        refreshAnalyticsAndUsage(false);
        if (!settings.overlay.paused) {
            expandOverlay(settings.overlay.expandOnTurnFinishedMs);
        }
        else {
            broadcast();
        }
    }
    else {
        broadcast();
    }
    return { ok: true };
}
async function connectAgent(agent) {
    const settings = settingsStore.get();
    const hookExe = (0, claudeCodeAdapter_1.resolveHookBinaryPath)(electron_1.app.isPackaged ? process.resourcesPath : undefined);
    const status = await registry.connect(agent, getAgentPathsForSettings(settings), {
        hookExecutablePath: hookExe,
        askAgentsForSummaries: settings.summaries.askAgents,
        permissionTimeoutSeconds: settings.permissions.timeoutSeconds,
        enableClaudeStatusLineBridge: settings.usage.enableClaudeStatusLineBridge,
        statusLineCacheFile: node_path_1.default.join(dataDir, 'claude-ratelimits.json'),
    });
    connectionsCache = { ...connectionsCache, [agent]: status };
    broadcast();
}
async function disconnectAgent(agent) {
    const settings = settingsStore.get();
    const status = await registry.disconnect(agent, getAgentPathsForSettings(settings));
    connectionsCache = { ...connectionsCache, [agent]: status };
    broadcast();
}
function registerIpc() {
    electron_1.ipcMain.handle('agentwatch:get-snapshot', () => buildSnapshot());
    electron_1.ipcMain.on('agentwatch:overlay-hover', (_e, interactive) => {
        windowManager.setOverlayInteractive(interactive);
    });
    electron_1.ipcMain.handle('agentwatch:overlay-expanded', (_e, expanded) => {
        if (!expanded && permissionManager.getPending().length > 0) {
            // Never auto-collapse while a permission request is pending (allow explicit collapse only if empty).
            return;
        }
        if (autoCollapseTimer)
            clearTimeout(autoCollapseTimer);
        overlayExpanded = expanded;
        windowManager.setOverlayExpanded(expanded);
        broadcast();
    });
    electron_1.ipcMain.on('agentwatch:overlay-resize', (_e, size) => {
        windowManager.resizeOverlay(size.width, size.height);
    });
    electron_1.ipcMain.handle('agentwatch:open-dashboard', (_e, tab) => {
        windowManager.showDashboard(undefined, undefined, tab);
    });
    electron_1.ipcMain.handle('agentwatch:update-settings', (_e, patch) => {
        const updated = settingsStore.update(patch);
        logger.setLevel(updated.data.logLevel);
        windowManager.applyThemeMode(updated.theme);
        windowManager.positionOverlay(updated);
        windowManager.syncOverlayVisibility(updated);
        if (patch.lifecycle?.launchAtLogin !== undefined && (process.platform === 'win32' || process.platform === 'darwin')) {
            try {
                electron_1.app.setLoginItemSettings({
                    openAtLogin: updated.lifecycle.launchAtLogin,
                    args: updated.lifecycle.startMinimizedToTray ? ['--minimized'] : [],
                });
            }
            catch (err) {
                logger.warn('lifecycle', 'Could not update launchAtLogin', String(err));
            }
        }
        if (patch.summaries?.askAgents !== undefined && connectionsCache.codex?.state === 'connected') {
            (0, codexAdapter_1.syncCodexManagedInstructions)(getAgentPathsForSettings(updated).codexManagedInstructionsFile, updated.summaries.askAgents);
        }
        syncHotkeys();
        refreshAnalyticsAndUsage(false);
        broadcast();
        return updated;
    });
    electron_1.ipcMain.handle('agentwatch:set-analytics-range', (_e, range) => {
        analyticsRange = range;
        refreshAnalyticsAndUsage(true);
    });
    electron_1.ipcMain.handle('agentwatch:refresh-analytics', () => {
        refreshAnalyticsAndUsage(true);
    });
    electron_1.ipcMain.handle('agentwatch:open-terminal', async (_e, sessionId) => {
        const session = sessionStore.getSession(sessionId);
        if (!session) {
            return { ok: false, message: 'Session not found.' };
        }
        const res = await platformDriver.focusTerminal(session.pid, session.terminalWindowRef);
        return {
            ok: res.ok,
            message: res.ok
                ? `Focused ${res.title || res.processName || 'terminal'}`
                : res.error || 'Could not locate a terminal window for this session.',
        };
    });
    electron_1.ipcMain.handle('agentwatch:stop-dev-server', async (_e, body) => {
        if (!body.trackedChild) {
            const confirm = await electron_1.dialog.showMessageBox({
                type: 'warning',
                buttons: ['Cancel', 'Stop Process'],
                defaultId: 0,
                cancelId: 0,
                title: 'Confirm Stop Dev Server',
                message: `Process ${body.pid} is not clearly a child of a tracked session. Stop its process tree anyway?`,
            });
            if (confirm.response !== 1) {
                return { ok: false, message: 'Cancelled by user.' };
            }
        }
        const res = await devServerTracker.stopServer(body.pid);
        broadcast();
        return res;
    });
    electron_1.ipcMain.handle('agentwatch:open-localhost', async (_e, url) => {
        // Strictly restrict external link opens to loopback localhost URLs (zero outbound traffic).
        if (/^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}(?:\/.*)?$/i.test(url)) {
            await electron_1.shell.openExternal(url);
        }
    });
    electron_1.ipcMain.handle('agentwatch:connect-agent', (_e, agent) => connectAgent(agent));
    electron_1.ipcMain.handle('agentwatch:disconnect-agent', (_e, agent) => disconnectAgent(agent));
    electron_1.ipcMain.handle('agentwatch:recheck-agent', async (_e, agent) => {
        const adapter = registry.get(agent);
        if (!adapter)
            return;
        const status = await adapter.getStatus(getAgentPathsForSettings(settingsStore.get()));
        connectionsCache = { ...connectionsCache, [agent]: status };
        broadcast();
    });
    electron_1.ipcMain.handle('agentwatch:resolve-permission', (_e, body) => {
        permissionManager.resolve(body.requestId, body.decision, Boolean(body.alwaysAllow));
    });
    electron_1.ipcMain.handle('agentwatch:revoke-rule', (_e, ruleId) => {
        ruleStore.revoke(ruleId);
        broadcast();
    });
    electron_1.ipcMain.handle('agentwatch:clear-rules', () => {
        ruleStore.clearAll();
        broadcast();
    });
    electron_1.ipcMain.handle('agentwatch:clear-history', () => {
        sessionStore.clearHistory();
        broadcast();
    });
    electron_1.ipcMain.handle('agentwatch:trigger-sim', async (_e, kind) => {
        const sessionId = `sim-ui-${Date.now()}`;
        const cwd = process.cwd();
        const base = {
            id: `${sessionId}-${kind}`,
            agent: 'claude_code',
            sessionId,
            timestamp: Date.now(),
            cwd,
            folderName: node_path_1.default.basename(cwd) || 'workspace',
            title: 'Simulated session',
        };
        if (kind === 'working') {
            await handleNormalizedEvent({ ...base, type: 'working', toolName: 'Bash', commandOrAction: 'pnpm test' });
        }
        else if (kind === 'permission') {
            void handleNormalizedEvent({
                ...base,
                type: 'permission_requested',
                requestId: `perm-sim-${Date.now()}`,
                toolName: 'Bash',
                commandOrAction: 'pnpm prisma migrate deploy',
                rawInput: { command: 'pnpm prisma migrate deploy' },
            });
        }
        else if (kind === 'finished') {
            await handleNormalizedEvent({ ...base, type: 'turn_finished', summary: 'All simulated checks passed.' });
        }
        else if (kind === 'error') {
            await handleNormalizedEvent({ ...base, type: 'error', errorMessage: 'Simulated error event' });
        }
    });
    electron_1.ipcMain.handle('agentwatch:get-displays', () => {
        const primaryId = electron_1.screen.getPrimaryDisplay().id;
        return electron_1.screen.getAllDisplays().map((d, idx) => ({
            id: d.id,
            label: d.label || `Display ${idx + 1}${d.id === primaryId ? ' (Primary)' : ''}`,
            primary: d.id === primaryId,
            bounds: d.bounds,
        }));
    });
    electron_1.ipcMain.handle('agentwatch:get-cursor', () => {
        const pt = electron_1.screen.getCursorScreenPoint();
        const center = windowManager.getOverlayCenterScreenPoint();
        return {
            x: pt.x - center.x,
            y: pt.y - center.y,
            screenX: pt.x,
            screenY: pt.y,
        };
    });
    electron_1.ipcMain.handle('agentwatch:open-logs-folder', async () => {
        await electron_1.shell.openPath(logger.logsDir);
    });
    electron_1.ipcMain.handle('agentwatch:check-updates-stub', () => ({
        available: false,
        message: 'Auto-updates over the network are disabled in v1.',
    }));
}
electron_1.app.on('second-instance', () => {
    windowManager?.showDashboard();
});
electron_1.app.on('before-quit', () => {
    if (reaperTimer)
        clearInterval(reaperTimer);
    if (codexWatchTimer)
        clearInterval(codexWatchTimer);
    if (analyticsTimer)
        clearInterval(analyticsTimer);
    if (devServerTimer)
        clearTimeout(devServerTimer);
    if (fullscreenTimer)
        clearInterval(fullscreenTimer);
    if (noticeTimer)
        clearTimeout(noticeTimer);
    hotkeyManager?.unregisterAll();
    permissionManager?.cancelAllForShutdown();
    windowManager?.markQuitting();
    void localServer?.stop();
});
electron_1.app.on('window-all-closed', () => {
    // Keep tray service alive.
});
void electron_1.app.whenReady().then(async () => {
    if (process.argv.includes('--disconnect-hooks'))
        return;
    dataDir = (0, settingsStore_1.getAppDataDir)();
    settingsStore = new settingsStore_1.SettingsStore(dataDir);
    logger = new logger_1.AppLogger(dataDir, settingsStore.get().data.logLevel);
    secretStore = new secureStore_1.SecureSecretStore(dataDir);
    sessionStore = new sessionStore_1.SessionStore(dataDir);
    ruleStore = new ruleMatcher_1.RuleStore(dataDir);
    hotkeyManager = new hotkeyManager_1.PermissionHotkeyManager(logger);
    eventBus = new eventBus_1.CoreEventBus();
    permissionManager = new permissionManager_1.PermissionManager(ruleStore, logger, {
        onQueueChanged: () => {
            syncHotkeys();
            broadcast();
        },
        onRuleNotice: () => {
            if (noticeTimer)
                clearTimeout(noticeTimer);
            noticeTimer = setTimeout(() => {
                permissionManager.clearNotice();
                broadcast();
            }, 6500);
        },
        onResolved: (pending, response) => {
            sessionStore.clearPendingPermission(pending.sessionId, pending.requestId, response.decision === 'deny' ? 'needs_you' : 'working');
            sessionStore.applyEvent({
                id: `${pending.requestId}-resolved`,
                type: 'permission_resolved',
                agent: pending.agent,
                sessionId: pending.sessionId,
                timestamp: Date.now(),
                cwd: pending.cwd,
                folderName: pending.folderName,
                requestId: pending.requestId,
                toolName: pending.toolName,
                commandOrAction: pending.commandOrAction,
                decision: response.decision,
                decisionReason: response.reason,
            }, settingsStore.get().data.retentionDays);
            broadcast();
        },
    });
    registry = new registry_1.AdapterRegistry();
    registry.register(new claudeCodeAdapter_1.ClaudeCodeAdapter());
    registry.register(new codexAdapter_1.CodexAdapter());
    codexWatcher = new codexWatcher_1.CodexRolloutWatcher();
    summaryPipeline = new summaryPipeline_1.SummaryPipeline();
    analyticsEngine = new tokenAnalytics_1.TokenAnalyticsEngine(dataDir);
    claudeUsageProvider = new usageProviders_1.ClaudeUsageProvider(dataDir, analyticsEngine);
    codexUsageProvider = new usageProviders_1.CodexUsageProvider(analyticsEngine);
    platformDriver = (0, platformDriver_1.createPlatformDriver)(electron_1.app.isPackaged ? process.resourcesPath : undefined);
    devServerTracker = new devServerTracker_1.DevServerTracker(platformDriver);
    refreshAnalyticsAndUsage(false);
    const now = Date.now();
    connectionsCache = {
        claude_code: {
            agent: 'claude_code',
            displayName: 'Claude Code',
            installed: false,
            installDetails: 'Checking...',
            state: 'not_connected',
            configPath: '',
            hookPresent: false,
            supportsBlockingPermissions: true,
            lastCheckedAt: now,
        },
        codex: {
            agent: 'codex',
            displayName: 'Codex',
            installed: false,
            installDetails: 'Codex adapter queued for M3',
            state: 'not_connected',
            configPath: '',
            hookPresent: false,
            supportsBlockingPermissions: false,
            lastCheckedAt: now,
        },
    };
    localServer = new localServer_1.LocalServer({
        dataDir,
        logger,
        secretStore,
        normalizeHookEnvelope: (env) => registry.normalize(env),
        onNormalizedEvent: (event, _env, registerDisconnect) => handleNormalizedEvent(event, registerDisconnect),
    });
    await localServer.start();
    windowManager = new windowManager_1.WindowManager(logger, {
        onExpandChange: (expanded) => {
            overlayExpanded = expanded;
            broadcast();
        },
        onTogglePause: () => {
            const curr = settingsStore.get();
            const updated = settingsStore.update({ overlay: { paused: !curr.overlay.paused } });
            windowManager.syncOverlayVisibility(updated);
            broadcast();
        },
        onConnectAgent: (agent) => void connectAgent(agent),
        onDisconnectAgent: (agent) => void disconnectAgent(agent),
        onQuit: () => {
            hotkeyManager.unregisterAll();
            permissionManager.cancelAllForShutdown();
            void localServer.stop();
        },
        getSnapshot: buildSnapshot,
    });
    registerIpc();
    electron_1.nativeTheme.on('updated', () => broadcast());
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    windowManager.init(settingsStore.get(), Boolean(devUrl), devUrl);
    await refreshConnections();
    reaperTimer = setInterval(() => {
        const s = settingsStore.get();
        if (sessionStore.expireStaleSessions(s.sessions.idleTimeoutMinutes, isPidAlive)) {
            broadcast();
        }
    }, 15_000);
    codexWatchTimer = setInterval(() => {
        if (connectionsCache.codex?.state !== 'connected')
            return;
        const paths = getAgentPathsForSettings(settingsStore.get());
        codexWatcher.poll(paths.codexSessionsDir, (ev) => {
            void handleNormalizedEvent(ev);
        });
    }, 3_000);
    analyticsTimer = setInterval(() => {
        if (windowManager.isOverlayVisible() || windowManager.isDashboardVisible()) {
            refreshAnalyticsAndUsage(true);
        }
    }, 30_000);
    const scheduleDevServerPoll = () => {
        const visible = windowManager.isOverlayVisible() || windowManager.isDashboardVisible();
        const intervalMs = visible ? 2000 : 10_000;
        devServerTimer = setTimeout(async () => {
            try {
                const before = JSON.stringify(devServerTracker.getEntries());
                await devServerTracker.poll(sessionStore.getSessions(), localServer.getAddressInfo().port);
                const after = JSON.stringify(devServerTracker.getEntries());
                if (before !== after)
                    broadcast();
            }
            finally {
                scheduleDevServerPoll();
            }
        }, intervalMs);
    };
    scheduleDevServerPoll();
    fullscreenTimer = setInterval(async () => {
        const s = settingsStore.get();
        if (!s.overlay.hideOnFullscreen) {
            windowManager.setHiddenByFullscreen(false, s);
            return;
        }
        const isFs = await platformDriver.isForegroundFullscreen();
        windowManager.setHiddenByFullscreen(isFs, s);
    }, 1500);
});
