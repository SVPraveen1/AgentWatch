"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowManager = void 0;
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const constants_1 = require("../../shared/constants");
const overlayGeometry_1 = require("./overlayGeometry");
const COLLAPSED_WIDTH = 220;
const COLLAPSED_HEIGHT = 48;
const EXPANDED_WIDTH = 440;
const EXPANDED_HEIGHT = 460;
class WindowManager {
    logger;
    callbacks;
    overlayWin = null;
    dashboardWin = null;
    tray = null;
    overlayExpanded = false;
    overlayHiddenByFullscreen = false;
    overlayManuallyHidden = false;
    trayStatus = 'idle';
    overlayDimensions = { width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT };
    constructor(logger, callbacks) {
        this.logger = logger;
        this.callbacks = callbacks;
    }
    init(settings, isDev, devServerUrl) {
        this.applyThemeMode(settings.theme);
        this.createOverlayWindow(settings, isDev, devServerUrl);
        this.createTray(settings);
        if (!settings.lifecycle.startMinimizedToTray || !settings.lifecycle.firstRunCompleted) {
            this.showDashboard(isDev, devServerUrl);
        }
        electron_1.screen.on('display-metrics-changed', () => {
            this.positionOverlay(this.callbacks.getSnapshot().settings);
        });
        electron_1.screen.on('display-added', () => {
            this.positionOverlay(this.callbacks.getSnapshot().settings);
        });
        electron_1.screen.on('display-removed', () => {
            this.positionOverlay(this.callbacks.getSnapshot().settings);
        });
    }
    applyThemeMode(theme) {
        electron_1.nativeTheme.themeSource = theme;
    }
    getResolvedTheme() {
        return electron_1.nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    }
    getSystemReducedMotion() {
        // Electron exposes prefersReducedMotion on nativeTheme in newer versions; fallback false if absent.
        const nt = electron_1.nativeTheme;
        return Boolean(nt.prefersReducedMotion);
    }
    isOverlayVisible() {
        return Boolean(this.overlayWin && !this.overlayWin.isDestroyed() && this.overlayWin.isVisible());
    }
    getOverlayCenterScreenPoint() {
        if (!this.overlayWin || this.overlayWin.isDestroyed()) {
            const primary = electron_1.screen.getPrimaryDisplay();
            return { x: primary.bounds.x + primary.bounds.width / 2, y: primary.bounds.y + 20 };
        }
        const b = this.overlayWin.getBounds();
        return { x: b.x + b.width / 2, y: b.y + 18 };
    }
    isDashboardVisible() {
        return Boolean(this.dashboardWin && !this.dashboardWin.isDestroyed() && this.dashboardWin.isVisible());
    }
    createOverlayWindow(settings, isDev, devServerUrl) {
        const preloadPath = node_path_1.default.join(__dirname, '..', 'preload.js');
        this.overlayWin = new electron_1.BrowserWindow({
            width: COLLAPSED_WIDTH,
            height: COLLAPSED_HEIGHT,
            frame: false,
            transparent: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            closable: false,
            skipTaskbar: true,
            hasShadow: false,
            show: false,
            // Critical on Windows: sets WS_EX_NOACTIVATE so clicking/showing never steals keyboard focus
            focusable: false,
            alwaysOnTop: true,
            webPreferences: {
                preload: preloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
            },
        });
        this.overlayWin.setAlwaysOnTop(true, 'screen-saver');
        this.overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
        this.overlayWin.setIgnoreMouseEvents(true, { forward: true });
        if (isDev && devServerUrl) {
            void this.overlayWin.loadURL(`${devServerUrl}/overlay.html`);
        }
        else {
            const htmlPath = node_path_1.default.join(__dirname, '..', '..', 'dist-renderer', 'overlay.html');
            void this.overlayWin.loadFile(htmlPath);
        }
        this.overlayWin.once('ready-to-show', () => {
            this.positionOverlay(settings);
            if (!settings.overlay.paused && !this.overlayManuallyHidden) {
                this.overlayWin?.showInactive();
            }
        });
        this.overlayWin.on('blur', () => {
            const current = this.callbacks.getSnapshot();
            if (this.overlayExpanded &&
                current.settings.overlay.autoCollapseOnClickAway &&
                current.pendingPermissions.length === 0) {
                this.setOverlayExpanded(false);
            }
        });
    }
    showDashboard(isDev, devServerUrl, initialTab) {
        if (this.dashboardWin && !this.dashboardWin.isDestroyed()) {
            if (this.dashboardWin.isMinimized())
                this.dashboardWin.restore();
            this.dashboardWin.show();
            this.dashboardWin.focus();
            if (initialTab) {
                this.dashboardWin.webContents.send('agentwatch:navigate-tab', initialTab);
            }
            return;
        }
        const preloadPath = node_path_1.default.join(__dirname, '..', 'preload.js');
        this.dashboardWin = new electron_1.BrowserWindow({
            width: 1080,
            height: 740,
            minWidth: 860,
            minHeight: 600,
            title: constants_1.APP_NAME,
            autoHideMenuBar: true,
            show: false,
            webPreferences: {
                preload: preloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
            },
        });
        const hash = initialTab ? `#${initialTab}` : '';
        const resolvedDevUrl = devServerUrl || process.env.VITE_DEV_SERVER_URL;
        const resolvedIsDev = isDev ?? Boolean(resolvedDevUrl);
        if (resolvedIsDev && resolvedDevUrl) {
            void this.dashboardWin.loadURL(`${resolvedDevUrl}/dashboard.html${hash}`);
        }
        else {
            const htmlPath = node_path_1.default.join(__dirname, '..', '..', 'dist-renderer', 'dashboard.html');
            void this.dashboardWin.loadFile(htmlPath, initialTab ? { hash: initialTab } : undefined);
        }
        this.dashboardWin.once('ready-to-show', () => {
            this.dashboardWin?.show();
        });
        this.dashboardWin.on('close', (event) => {
            // Close minimizes to tray unless app is quitting.
            if (!this.isQuitting) {
                event.preventDefault();
                this.dashboardWin?.hide();
            }
        });
    }
    isQuitting = false;
    markQuitting() {
        this.isQuitting = true;
    }
    setOverlayInteractive(interactive) {
        if (!this.overlayWin || this.overlayWin.isDestroyed())
            return;
        if (interactive) {
            this.overlayWin.setIgnoreMouseEvents(false);
        }
        else {
            this.overlayWin.setIgnoreMouseEvents(true, { forward: true });
        }
    }
    setOverlayExpanded(expanded) {
        if (this.overlayExpanded === expanded)
            return;
        this.overlayExpanded = expanded;
        this.overlayDimensions = expanded
            ? { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT }
            : { width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT };
        const snap = this.callbacks.getSnapshot();
        this.positionOverlay(snap.settings);
        this.callbacks.onExpandChange(expanded);
    }
    resizeOverlay(width, height) {
        const safeW = Math.max(COLLAPSED_WIDTH, Math.min(560, Math.round(width)));
        const safeH = Math.max(COLLAPSED_HEIGHT, Math.min(640, Math.round(height)));
        this.overlayDimensions = { width: safeW, height: safeH };
        this.positionOverlay(this.callbacks.getSnapshot().settings);
    }
    positionOverlay(settings) {
        if (!this.overlayWin || this.overlayWin.isDestroyed())
            return;
        const displays = electron_1.screen.getAllDisplays();
        const primary = electron_1.screen.getPrimaryDisplay();
        const bounds = (0, overlayGeometry_1.computeOverlayBounds)({
            displays,
            primaryDisplay: primary,
            monitorId: settings.overlay.monitorId,
            offsetTop: settings.overlay.offsetTop,
            width: this.overlayDimensions.width,
            height: this.overlayDimensions.height,
        });
        this.overlayWin.setBounds(bounds, false);
    }
    setHiddenByFullscreen(hidden, settings) {
        if (this.overlayHiddenByFullscreen === hidden)
            return;
        this.overlayHiddenByFullscreen = hidden;
        this.syncOverlayVisibility(settings);
    }
    toggleOverlayVisibility(settings) {
        this.overlayManuallyHidden = !this.overlayManuallyHidden;
        this.syncOverlayVisibility(settings);
        this.refreshTrayMenu();
    }
    syncOverlayVisibility(settings) {
        if (!this.overlayWin || this.overlayWin.isDestroyed())
            return;
        const shouldHide = settings.overlay.paused || this.overlayHiddenByFullscreen || this.overlayManuallyHidden;
        if (shouldHide) {
            this.overlayWin.hide();
        }
        else {
            this.positionOverlay(settings);
            this.overlayWin.showInactive();
        }
    }
    ensureOverlayVisibleForEvent(settings) {
        if (!this.overlayWin || this.overlayWin.isDestroyed())
            return;
        if (settings.overlay.paused || this.overlayHiddenByFullscreen || this.overlayManuallyHidden)
            return;
        if (!this.overlayWin.isVisible()) {
            this.positionOverlay(settings);
            this.overlayWin.showInactive();
        }
    }
    broadcastSnapshot(snapshot) {
        if (this.overlayWin && !this.overlayWin.isDestroyed()) {
            this.overlayWin.webContents.send('agentwatch:snapshot', snapshot);
        }
        if (this.dashboardWin && !this.dashboardWin.isDestroyed()) {
            this.dashboardWin.webContents.send('agentwatch:snapshot', snapshot);
        }
        this.updateTrayFromSnapshot(snapshot);
    }
    createTray(settings) {
        try {
            const icon = this.buildTrayIcon('idle');
            this.tray = new electron_1.Tray(icon);
            this.tray.setToolTip(`${constants_1.APP_NAME} — Idle`);
            this.tray.on('click', () => {
                this.showDashboard();
            });
            this.refreshTrayMenu(settings);
        }
        catch (err) {
            this.logger.warn('tray', 'Failed to initialize tray icon', String(err));
        }
    }
    updateTrayFromSnapshot(snapshot) {
        const nextStatus = snapshot.pendingPermissions.length > 0 ||
            snapshot.sessions.some((s) => s.state === 'needs_you' || s.state === 'error')
            ? 'needs_you'
            : snapshot.sessions.some((s) => s.state === 'working')
                ? 'working'
                : 'idle';
        if (nextStatus !== this.trayStatus && this.tray) {
            this.trayStatus = nextStatus;
            this.tray.setImage(this.buildTrayIcon(nextStatus));
            const label = nextStatus === 'needs_you'
                ? 'Needs attention'
                : nextStatus === 'working'
                    ? 'Agents working'
                    : 'Idle';
            this.tray.setToolTip(`${constants_1.APP_NAME} — ${label}`);
        }
        this.refreshTrayMenu(snapshot.settings);
    }
    refreshTrayMenu(settingsOverride) {
        if (!this.tray)
            return;
        const snap = this.callbacks.getSnapshot();
        const settings = settingsOverride ?? snap.settings;
        const claudeConnected = snap.connections.claude_code.state === 'connected';
        const codexConnected = snap.connections.codex.state === 'connected';
        const menu = electron_1.Menu.buildFromTemplate([
            { label: `Open ${constants_1.APP_NAME} Dashboard`, click: () => this.showDashboard() },
            {
                label: this.overlayManuallyHidden ? 'Show Overlay' : 'Hide Overlay',
                click: () => this.toggleOverlayVisibility(settings),
            },
            {
                label: settings.overlay.paused ? 'Resume Notifications' : 'Pause Notifications',
                type: 'checkbox',
                checked: settings.overlay.paused,
                click: () => this.callbacks.onTogglePause(),
            },
            { type: 'separator' },
            {
                label: claudeConnected ? 'Disconnect Claude Code' : 'Connect Claude Code',
                click: () => claudeConnected
                    ? this.callbacks.onDisconnectAgent('claude_code')
                    : this.callbacks.onConnectAgent('claude_code'),
            },
            {
                label: codexConnected ? 'Disconnect Codex' : 'Connect Codex',
                click: () => codexConnected
                    ? this.callbacks.onDisconnectAgent('codex')
                    : this.callbacks.onConnectAgent('codex'),
            },
            { type: 'separator' },
            {
                label: `Quit ${constants_1.APP_NAME}`,
                click: () => {
                    this.markQuitting();
                    this.callbacks.onQuit();
                    electron_1.app.quit();
                },
            },
        ]);
        this.tray.setContextMenu(menu);
    }
    buildTrayIcon(status) {
        // 16x16 crisp programmatic PNG data URL via raw RGBA buffer so no external bitmap asset is required.
        const size = 16;
        const buf = Buffer.alloc(size * size * 4, 0);
        const [r, g, b] = status === 'needs_you'
            ? [245, 158, 11]
            : status === 'working'
                ? [76, 141, 255]
                : [148, 163, 184];
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = x - 7.5;
                const dy = y - 7.5;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const idx = (y * size + x) * 4;
                if (dist <= 6.2) {
                    buf[idx] = r;
                    buf[idx + 1] = g;
                    buf[idx + 2] = b;
                    buf[idx + 3] = 255;
                }
                // Inner dark eye/notch silhouette for distinct tray icon clarity
                if (dist <= 2.4) {
                    buf[idx] = 15;
                    buf[idx + 1] = 17;
                    buf[idx + 2] = 22;
                    buf[idx + 3] = 255;
                }
            }
        }
        return electron_1.nativeImage.createFromBuffer(buf, { width: size, height: size });
    }
}
exports.WindowManager = WindowManager;
