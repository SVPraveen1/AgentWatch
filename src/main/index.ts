import { app, dialog, ipcMain, nativeTheme, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME } from '../shared/constants';
import type { DiagnosticBundle, DiagnosticCheckResult } from '../shared/ipc';
import type {
  AgentConnectionStatus,
  AgentId,
  AppSettings,
  AppSnapshot,
  NormalizedEvent,
  TokenAnalyticsReport,
} from '../shared/types';
import { ClaudeCodeAdapter, resolveHookBinaryPath } from './adapters/claudeCodeAdapter';
import { CodexAdapter, syncCodexManagedInstructions } from './adapters/codexAdapter';
import { CodexRolloutWatcher } from './adapters/codexWatcher';
import { resolveAgentPaths } from './adapters/pathResolver';
import { AdapterRegistry } from './adapters/registry';
import { TokenAnalyticsEngine } from './analytics/tokenAnalytics';
import { ClaudeUsageProvider, CodexUsageProvider } from './analytics/usageProviders';
import { CoreEventBus } from './core/eventBus';
import { LocalServer, type HookHandlingResult } from './core/localServer';
import { AppLogger } from './core/logger';
import { SecureSecretStore } from './core/secureStore';
import { SessionStore } from './core/sessionStore';
import { getAppDataDir, SettingsStore, type DeepPartial } from './core/settingsStore';
import { DevServerTracker } from './devservers/devServerTracker';
import { detectHotkeyConflicts, PermissionHotkeyManager } from './permissions/hotkeyManager';
import { PermissionManager } from './permissions/permissionManager';
import { RuleStore } from './permissions/ruleMatcher';
import { createPlatformDriver, type PlatformDriver } from './platform/platformDriver';
import { SUMMARY_CONTEXT_INSTRUCTION, SummaryPipeline } from './summaries/summaryPipeline';
import { WindowManager } from './windows/windowManager';

// Handle headless uninstall hook cleanup before single-instance lock / GUI init.
if (process.argv.includes('--disconnect-hooks')) {
  setTimeout(() => process.exit(0), 4000);
  void app.whenReady().then(async () => {
    try {
      const settings = new SettingsStore(getAppDataDir()).get();
      const paths = resolveAgentPaths({
        wsl: { enabled: settings.wsl.enabled, distro: settings.wsl.distro },
      });
      await new ClaudeCodeAdapter().disconnect(paths);
      await new CodexAdapter().disconnect(paths);
    } catch {
      // Never block uninstaller on missing/invalid configs.
    }
    app.exit(0);
  });
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    process.exit(0);
  }
}

// Enforce strict local-only isolation at Chromium engine level
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');

let dataDir = '';
let settingsStore: SettingsStore;
let logger: AppLogger;
let secretStore: SecureSecretStore;
let sessionStore: SessionStore;
let ruleStore: RuleStore;
let permissionManager: PermissionManager;
let hotkeyManager: PermissionHotkeyManager;
let eventBus: CoreEventBus;
let registry: AdapterRegistry;
let codexWatcher: CodexRolloutWatcher;
let summaryPipeline: SummaryPipeline;
let analyticsEngine: TokenAnalyticsEngine;
let claudeUsageProvider: ClaudeUsageProvider;
let codexUsageProvider: CodexUsageProvider;
let platformDriver: PlatformDriver;
let devServerTracker: DevServerTracker;
let analyticsRange: TokenAnalyticsReport['range'] = 'this_month';
let analyticsCache: TokenAnalyticsReport;
let usageCache: Record<AgentId, AppSnapshot['usage'][AgentId]>;
let localServer: LocalServer;
let windowManager: WindowManager;
let connectionsCache: Record<AgentId, AgentConnectionStatus>;
let overlayExpanded = false;
let autoCollapseTimer: NodeJS.Timeout | null = null;
let noticeTimer: NodeJS.Timeout | null = null;
let reaperTimer: NodeJS.Timeout | null = null;
let codexWatchTimer: NodeJS.Timeout | null = null;
let analyticsTimer: NodeJS.Timeout | null = null;
let devServerTimer: NodeJS.Timeout | null = null;
let fullscreenTimer: NodeJS.Timeout | null = null;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

function getAgentPathsForSettings(settings: AppSettings) {
  return resolveAgentPaths({
    wsl: {
      enabled: settings.wsl.enabled,
      distro: settings.wsl.distro,
    },
  });
}

async function refreshConnections(): Promise<void> {
  const settings = settingsStore.get();
  connectionsCache = await registry.getAllStatuses(getAgentPathsForSettings(settings));
  broadcast();
}

function syncHotkeys(): void {
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

function refreshAnalyticsAndUsage(shouldBroadcast = true): void {
  const settings = settingsStore.get();
  const paths = getAgentPathsForSettings(settings);
  analyticsCache = analyticsEngine.buildReport(paths, analyticsRange);
  usageCache = {
    claude_code: claudeUsageProvider.getUsage(paths, settings),
    codex: codexUsageProvider.getUsage(paths, settings),
  };
  if (shouldBroadcast) broadcast();
}

function buildSnapshot(): AppSnapshot {
  const settings = settingsStore.get();
  const sessions = sessionStore.getSessions();
  const interactivePending = permissionManager.getPending();
  const readOnlyPending = sessions
    .map((s) => s.pendingPermission)
    .filter((p): p is NonNullable<typeof p> => Boolean(p && p.readOnlyInTerminal));

  return {
    appName: APP_NAME,
    version: app.getVersion(),
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
    hotkeyConflicts: detectHotkeyConflicts(settings.hotkeys),
    overlayExpanded,
    overlayVisible: windowManager.isOverlayVisible(),
  };
}

let broadcastPending = false;
function broadcast(immediate = false): void {
  if (!windowManager) return;
  if (immediate) {
    broadcastPending = false;
    windowManager.broadcastSnapshot(buildSnapshot());
    return;
  }
  if (broadcastPending) return;
  broadcastPending = true;
  queueMicrotask(() => {
    if (broadcastPending && windowManager) {
      broadcastPending = false;
      windowManager.broadcastSnapshot(buildSnapshot());
    }
  });
}

function expandOverlay(autoCollapseMs?: number): void {
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

async function handleNormalizedEvent(
  event: NormalizedEvent,
  registerDisconnect?: (cb: () => void) => void,
): Promise<HookHandlingResult> {
  const settings = settingsStore.get();
  if (
    event.type === 'turn_finished' ||
    event.type === 'permission_requested' ||
    event.type === 'needs_input' ||
    event.type === 'error'
  ) {
    event.summary = await summaryPipeline.generateSummary(event, {
      askAgents: settings.summaries.askAgents,
      llmSummarizerEnabled: settings.summaries.llmSummarizerEnabled,
    });
  }

  sessionStore.applyEvent(event, settings.data.retentionDays);
  eventBus.emitNormalizedEvent(event);

  if (event.pid && !sessionStore.getSession(event.sessionId)?.terminalWindowRef) {
    void platformDriver.resolveTerminalRef(event.pid).then((ref) => {
      if (ref) sessionStore.setTerminalWindowRef(event.sessionId, ref);
    });
  }

  if (event.type === 'prompt_submitted' && settings.summaries.askAgents) {
    broadcast();
    return {
      ok: true,
      stdoutJson: {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: SUMMARY_CONTEXT_INSTRUCTION,
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
      } else {
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
      } else {
        broadcast();
      }
    }
    return promise;
  }

  if (event.type === 'turn_finished') {
    refreshAnalyticsAndUsage(false);
    if (!settings.overlay.paused) {
      expandOverlay(settings.overlay.expandOnTurnFinishedMs);
    } else {
      broadcast();
    }
  } else {
    broadcast();
  }
  return { ok: true };
}

async function connectAgent(agent: AgentId): Promise<void> {
  const settings = settingsStore.get();
  const hookExe = resolveHookBinaryPath(app.isPackaged ? process.resourcesPath : undefined);
  const status = await registry.connect(agent, getAgentPathsForSettings(settings), {
    hookExecutablePath: hookExe,
    askAgentsForSummaries: settings.summaries.askAgents,
    permissionTimeoutSeconds: settings.permissions.timeoutSeconds,
    enableClaudeStatusLineBridge: settings.usage.enableClaudeStatusLineBridge,
    statusLineCacheFile: path.join(dataDir, 'claude-ratelimits.json'),
  });
  connectionsCache = { ...connectionsCache, [agent]: status };
  broadcast();
}

async function disconnectAgent(agent: AgentId): Promise<void> {
  const settings = settingsStore.get();
  const status = await registry.disconnect(agent, getAgentPathsForSettings(settings));
  connectionsCache = { ...connectionsCache, [agent]: status };
  broadcast();
}

function registerIpc(): void {
  ipcMain.handle('agentwatch:get-snapshot', () => buildSnapshot());
  ipcMain.on('agentwatch:overlay-hover', (_e, interactive: boolean) => {
    windowManager.setOverlayInteractive(interactive);
  });
  ipcMain.handle('agentwatch:overlay-expanded', (_e, expanded: boolean) => {
    if (!expanded && permissionManager.getPending().length > 0) {
      // Never auto-collapse while a permission request is pending (allow explicit collapse only if empty).
      return;
    }
    if (autoCollapseTimer) clearTimeout(autoCollapseTimer);
    overlayExpanded = expanded;
    windowManager.setOverlayExpanded(expanded);
    broadcast();
  });
  ipcMain.on('agentwatch:overlay-resize', (_e, size: { width: number; height: number }) => {
    windowManager.resizeOverlay(size.width, size.height);
  });
  ipcMain.handle('agentwatch:open-dashboard', (_e, tab?: string) => {
    windowManager.showDashboard(undefined, undefined, tab);
  });
  ipcMain.handle('agentwatch:update-settings', (_e, patch: DeepPartial<AppSettings>) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return settingsStore.get();
    }
    const updated = settingsStore.update(patch);
    logger.setLevel(updated.data.logLevel);
    windowManager.applyThemeMode(updated.theme);
    windowManager.positionOverlay(updated);
    windowManager.syncOverlayVisibility(updated);
    if (patch.lifecycle?.launchAtLogin !== undefined && (process.platform === 'win32' || process.platform === 'darwin')) {
      try {
        app.setLoginItemSettings({
          openAtLogin: updated.lifecycle.launchAtLogin,
          args: updated.lifecycle.startMinimizedToTray ? ['--minimized'] : [],
        });
      } catch (err) {
        logger.warn('lifecycle', 'Could not update launchAtLogin', String(err));
      }
    }
    if (patch.summaries?.askAgents !== undefined && connectionsCache.codex?.state === 'connected') {
      syncCodexManagedInstructions(
        getAgentPathsForSettings(updated).codexManagedInstructionsFile,
        updated.summaries.askAgents,
      );
    }
    syncHotkeys();
    refreshAnalyticsAndUsage(false);
    broadcast();
    return updated;
  });
  ipcMain.handle('agentwatch:set-analytics-range', (_e, range: TokenAnalyticsReport['range']) => {
    analyticsRange = range;
    refreshAnalyticsAndUsage(true);
  });
  ipcMain.handle('agentwatch:refresh-analytics', () => {
    refreshAnalyticsAndUsage(true);
  });
  ipcMain.handle('agentwatch:open-terminal', async (_e, sessionId: string) => {
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
  ipcMain.handle(
    'agentwatch:stop-dev-server',
    async (_e, body: { pid: number; trackedChild?: boolean }) => {
      const pid = typeof body?.pid === 'number' ? Math.floor(body.pid) : 0;
      if (pid <= 4) {
        return { ok: false, message: 'Invalid or protected process ID.' };
      }
      if (pid === process.pid || pid === process.ppid) {
        return { ok: false, message: 'Cannot terminate application process.' };
      }

      // Security validation: verify this PID actually belongs to an active tracked dev server
      const recognized = devServerTracker.getEntries().find((entry) => entry.pid === pid);
      if (!recognized) {
        return { ok: false, message: 'Process is not an active dev server tracked by AgentWatch.' };
      }

      // Use the verified trackedChild status from the tracker, not unverified renderer payload
      if (!recognized.trackedChild) {
        const confirm = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Stop Process'],
          defaultId: 0,
          cancelId: 0,
          title: 'Confirm Stop Dev Server',
          message: `Process ${pid} (${recognized.commandShort || recognized.command}) is not clearly a child of a tracked session. Stop its process tree anyway?`,
        });
        if (confirm.response !== 1) {
          return { ok: false, message: 'Cancelled by user.' };
        }
      }
      const res = await devServerTracker.stopServer(pid);
      broadcast();
      return res;
    },
  );
  ipcMain.handle('agentwatch:open-localhost', async (_e, url: string) => {
    // Strictly restrict external link opens to loopback localhost URLs (zero outbound traffic).
    if (typeof url !== 'string' || !url.trim()) return;
    try {
      const parsed = new URL(url);
      const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      const isHttp = parsed.protocol === 'http:';
      const port = Number(parsed.port);
      const hasValidPort = Number.isInteger(port) && port >= 1 && port <= 65535;
      const noUserPass = !parsed.username && !parsed.password;
      if (isHttp && isLoopback && hasValidPort && noUserPass) {
        await shell.openExternal(parsed.href);
      }
    } catch {
      // Discard invalid URLs
    }
  });
  ipcMain.handle('agentwatch:connect-agent', (_e, agent: AgentId) => connectAgent(agent));
  ipcMain.handle('agentwatch:disconnect-agent', (_e, agent: AgentId) => disconnectAgent(agent));
  ipcMain.handle('agentwatch:recheck-agent', async (_e, agent: AgentId) => {
    const adapter = registry.get(agent);
    if (!adapter) return;
    const status = await adapter.getStatus(getAgentPathsForSettings(settingsStore.get()));
    connectionsCache = { ...connectionsCache, [agent]: status };
    broadcast();
  });
  ipcMain.handle(
    'agentwatch:resolve-permission',
    (_e, body: { requestId: string; decision: 'allow' | 'deny'; alwaysAllow?: boolean }) => {
      permissionManager.resolve(body.requestId, body.decision, Boolean(body.alwaysAllow));
    },
  );
  ipcMain.handle('agentwatch:revoke-rule', (_e, ruleId: string) => {
    ruleStore.revoke(ruleId);
    broadcast();
  });
  ipcMain.handle('agentwatch:clear-rules', () => {
    ruleStore.clearAll();
    broadcast();
  });
  ipcMain.handle('agentwatch:clear-history', () => {
    sessionStore.clearHistory();
    broadcast();
  });
  ipcMain.handle('agentwatch:dismiss-session', (_e, sessionId: string) => {
    if (typeof sessionId !== 'string') return false;
    const ok = sessionStore.dismissSession(sessionId);
    if (ok) broadcast();
    return ok;
  });
  ipcMain.handle('agentwatch:run-diagnostics', async (): Promise<DiagnosticBundle> => {
    const checks: DiagnosticCheckResult[] = [];
    const settings = settingsStore.get();
    const paths = getAgentPathsForSettings(settings);

    // 1. Local loopback server
    try {
      const addr = localServer.getAddressInfo();
      checks.push({
        name: 'Local Loopback Server',
        status: addr.port > 0 ? 'pass' : 'fail',
        details: `Bound to 127.0.0.1:${addr.port} with SHA-256 constant-time token verification`,
      });
    } catch (err) {
      checks.push({
        name: 'Local Loopback Server',
        status: 'fail',
        details: String(err),
      });
    }

    // 2. Claude Code Adapter
    try {
      const claudeStatus = connectionsCache?.claude_code;
      const hookPath = resolveHookBinaryPath();
      const hookExists = fs.existsSync(hookPath);
      checks.push({
        name: 'Claude Code Integration',
        status: claudeStatus?.installed && hookExists ? 'pass' : claudeStatus?.installed ? 'warn' : 'warn',
        details: `Installed: ${claudeStatus?.installed ?? false}, State: ${claudeStatus?.state ?? 'unknown'}, Hook Binary: ${hookExists ? 'Found' : 'Missing'} (${hookPath})`,
      });
    } catch (err) {
      checks.push({
        name: 'Claude Code Integration',
        status: 'fail',
        details: String(err),
      });
    }

    // 3. Codex Adapter
    try {
      const codexStatus = connectionsCache?.codex;
      const sessionsDirExists = fs.existsSync(paths.codexSessionsDir);
      checks.push({
        name: 'Codex Integration',
        status: codexStatus?.installed ? 'pass' : 'warn',
        details: `Installed: ${codexStatus?.installed ?? false}, State: ${codexStatus?.state ?? 'unknown'}, Sessions Dir: ${sessionsDirExists ? 'Accessible' : 'Not yet created'} (${paths.codexSessionsDir})`,
      });
    } catch (err) {
      checks.push({
        name: 'Codex Integration',
        status: 'fail',
        details: String(err),
      });
    }

    // 4. Platform Driver
    try {
      const listeners = await platformDriver.listTcpListeners();
      checks.push({
        name: 'Platform Subsystem (Win32/Darwin Driver)',
        status: 'pass',
        details: `Active TCP listeners discovered: ${listeners.length}. Native helper operational.`,
      });
    } catch (err) {
      checks.push({
        name: 'Platform Subsystem (Win32/Darwin Driver)',
        status: 'warn',
        details: `Driver query notice: ${String(err)}`,
      });
    }

    // 5. Screen & Display Setup
    try {
      const displays = screen.getAllDisplays();
      const primary = screen.getPrimaryDisplay();
      checks.push({
        name: 'Multi-Monitor & DPI Metrics',
        status: displays.length > 0 ? 'pass' : 'fail',
        details: `${displays.length} display(s) detected. Primary: ${primary.size.width}x${primary.size.height} (scale: ${primary.scaleFactor}x).`,
      });
    } catch (err) {
      checks.push({
        name: 'Multi-Monitor & DPI Metrics',
        status: 'fail',
        details: String(err),
      });
    }

    // 6. Logs & Storage
    try {
      const logFile = path.join(logger.logsDir, 'agentwatch.log');
      const sizeBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
      checks.push({
        name: 'Local Storage & Bounded Logs',
        status: 'pass',
        details: `Data dir: ${dataDir}, Log size: ${(sizeBytes / 1024).toFixed(1)} KB (10 MB max rotation)`,
      });
    } catch (err) {
      checks.push({
        name: 'Local Storage & Bounded Logs',
        status: 'warn',
        details: String(err),
      });
    }

    const mdLines = [
      `# ${APP_NAME} Self-Test Diagnostics`,
      `**Generated:** ${new Date().toISOString()}`,
      `**Version:** ${app.getVersion()}`,
      `**Platform:** ${process.platform} (${process.arch})`,
      `**Zero Outbound / Telemetry:** Strictly Enforced (Local Loopback Only)`,
      '',
      '## Subsystem Checks',
      ...checks.map((c) => `- **[${c.status.toUpperCase()}] ${c.name}**: ${c.details}`),
      '',
      '## Active Sessions & Dev Servers',
      `- Active Sessions: ${sessionStore.getSessions().length}`,
      `- Tracked Dev Servers: ${devServerTracker.getEntries().length}`,
    ];

    return {
      generatedAt: new Date().toISOString(),
      version: app.getVersion(),
      platform: process.platform,
      checks,
      markdown: mdLines.join('\n'),
    };
  });
  ipcMain.handle('agentwatch:trigger-sim', async (_e, kind: 'working' | 'permission' | 'finished' | 'error') => {
    const sessionId = `sim-ui-${Date.now()}`;
    const cwd = process.cwd();
    const base = {
      id: `${sessionId}-${kind}`,
      agent: 'claude_code' as const,
      sessionId,
      timestamp: Date.now(),
      cwd,
      folderName: path.basename(cwd) || 'workspace',
      title: 'Simulated session',
    };
    if (kind === 'working') {
      await handleNormalizedEvent({ ...base, type: 'working', toolName: 'Bash', commandOrAction: 'pnpm test' });
    } else if (kind === 'permission') {
      void handleNormalizedEvent({
        ...base,
        type: 'permission_requested',
        requestId: `perm-sim-${Date.now()}`,
        toolName: 'Bash',
        commandOrAction: 'pnpm prisma migrate deploy',
        rawInput: { command: 'pnpm prisma migrate deploy' },
      });
    } else if (kind === 'finished') {
      await handleNormalizedEvent({ ...base, type: 'turn_finished', summary: 'All simulated checks passed.' });
    } else if (kind === 'error') {
      await handleNormalizedEvent({ ...base, type: 'error', errorMessage: 'Simulated error event' });
    }
  });
  ipcMain.handle('agentwatch:get-displays', () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, idx) => ({
      id: d.id,
      label: d.label || `Display ${idx + 1}${d.id === primaryId ? ' (Primary)' : ''}`,
      primary: d.id === primaryId,
      bounds: d.bounds,
    }));
  });
  ipcMain.handle('agentwatch:get-cursor', () => {
    const pt = screen.getCursorScreenPoint();
    const center = windowManager.getOverlayCenterScreenPoint();
    return {
      x: pt.x - center.x,
      y: pt.y - center.y,
      screenX: pt.x,
      screenY: pt.y,
    };
  });
  ipcMain.handle('agentwatch:open-logs-folder', async () => {
    await shell.openPath(logger.logsDir);
  });
  ipcMain.handle('agentwatch:check-updates-stub', () => ({
    available: false as const,
    message: 'Auto-updates over the network are disabled in v1.',
  }));
}

app.on('second-instance', () => {
  windowManager?.showDashboard();
});

app.on('before-quit', () => {
  if (reaperTimer) clearInterval(reaperTimer);
  if (codexWatchTimer) clearInterval(codexWatchTimer);
  if (analyticsTimer) clearInterval(analyticsTimer);
  if (devServerTimer) clearTimeout(devServerTimer);
  if (fullscreenTimer) clearInterval(fullscreenTimer);
  if (noticeTimer) clearTimeout(noticeTimer);
  hotkeyManager?.unregisterAll();
  permissionManager?.cancelAllForShutdown();
  windowManager?.markQuitting();
  void localServer?.stop();
});

app.on('window-all-closed', () => {
  // Keep tray service alive.
});

void app.whenReady().then(async () => {
  if (process.argv.includes('--disconnect-hooks')) return;
  dataDir = getAppDataDir();
  settingsStore = new SettingsStore(dataDir);
  logger = new AppLogger(dataDir, settingsStore.get().data.logLevel);
  secretStore = new SecureSecretStore(dataDir);
  sessionStore = new SessionStore(dataDir);
  ruleStore = new RuleStore(dataDir);
  hotkeyManager = new PermissionHotkeyManager(logger);
  eventBus = new CoreEventBus();

  permissionManager = new PermissionManager(ruleStore, logger, {
    onQueueChanged: () => {
      syncHotkeys();
      broadcast();
    },
    onRuleNotice: () => {
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        permissionManager.clearNotice();
        broadcast();
      }, 6500);
    },
    onResolved: (pending, response) => {
      sessionStore.clearPendingPermission(
        pending.sessionId,
        pending.requestId,
        response.decision === 'deny' ? 'needs_you' : 'working',
      );
      sessionStore.applyEvent(
        {
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
        },
        settingsStore.get().data.retentionDays,
      );
      broadcast();
    },
  });

  registry = new AdapterRegistry();
  registry.register(new ClaudeCodeAdapter());
  registry.register(new CodexAdapter());
  codexWatcher = new CodexRolloutWatcher();
  summaryPipeline = new SummaryPipeline();
  analyticsEngine = new TokenAnalyticsEngine(dataDir);
  claudeUsageProvider = new ClaudeUsageProvider(dataDir, analyticsEngine);
  codexUsageProvider = new CodexUsageProvider(analyticsEngine);
  platformDriver = createPlatformDriver(app.isPackaged ? process.resourcesPath : undefined);
  devServerTracker = new DevServerTracker(platformDriver);
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

  localServer = new LocalServer({
    dataDir,
    logger,
    secretStore,
    normalizeHookEnvelope: (env) => registry.normalize(env),
    onNormalizedEvent: (event, _env, registerDisconnect) =>
      handleNormalizedEvent(event, registerDisconnect),
  });
  await localServer.start();

  windowManager = new WindowManager(logger, {
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
  nativeTheme.on('updated', () => broadcast());

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
    if (connectionsCache.codex?.state !== 'connected') return;
    const paths = getAgentPathsForSettings(settingsStore.get());
    void codexWatcher.poll(paths.codexSessionsDir, (ev) => {
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
        if (before !== after) broadcast();
      } finally {
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
