"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsStore = void 0;
exports.getAppDataDir = getAppDataDir;
exports.createDefaultSettings = createDefaultSettings;
exports.atomicWriteFileSync = atomicWriteFileSync;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const constants_1 = require("../../shared/constants");
function getAppDataDir(customDir) {
    if (customDir)
        return customDir;
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || node_path_1.default.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
        return node_path_1.default.join(appData, constants_1.APP_NAME);
    }
    const home = process.env.HOME || '.';
    if (process.platform === 'darwin') {
        return node_path_1.default.join(home, 'Library', 'Application Support', constants_1.APP_NAME);
    }
    return node_path_1.default.join(process.env.XDG_CONFIG_HOME || node_path_1.default.join(home, '.config'), constants_1.APP_NAME);
}
function createDefaultSettings() {
    return {
        theme: 'system',
        overlay: {
            monitorId: null,
            offsetTop: 0,
            expandOnTurnFinishedMs: constants_1.DEFAULT_TURN_EXPAND_MS,
            autoCollapseOnClickAway: true,
            hideOnFullscreen: false,
            paused: false,
        },
        hotkeys: {
            allow: 'Control+Y',
            alwaysAllow: 'Control+Shift+Y',
            deny: 'Control+N',
        },
        permissions: {
            timeoutSeconds: constants_1.DEFAULT_PERMISSION_TIMEOUT_SECONDS,
        },
        sessions: {
            idleTimeoutMinutes: constants_1.DEFAULT_IDLE_TIMEOUT_MINUTES,
        },
        summaries: {
            askAgents: true,
            llmSummarizerEnabled: false,
        },
        usage: {
            enableClaudeStatusLineBridge: false,
            manualClaudeFiveHourTokens: null,
            manualClaudeWeeklyTokens: null,
            manualCodexFiveHourTokens: null,
            manualCodexWeeklyTokens: null,
        },
        mascot: {
            enabled: true,
            reduceMotion: 'system',
        },
        lifecycle: {
            launchAtLogin: false,
            startMinimizedToTray: true,
            firstRunCompleted: false,
        },
        data: {
            retentionDays: constants_1.DEFAULT_RETENTION_DAYS,
            logLevel: 'info',
        },
        wsl: {
            enabled: false,
            distro: '',
        },
        featureFlags: {
            showCost: constants_1.FEATURE_FLAGS.showCost,
        },
    };
}
function atomicWriteFileSync(filePath, data) {
    const dir = node_path_1.default.dirname(filePath);
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    node_fs_1.default.writeFileSync(tmpPath, data);
    node_fs_1.default.renameSync(tmpPath, filePath);
}
class SettingsStore {
    filePath;
    settings;
    constructor(dataDir) {
        this.filePath = node_path_1.default.join(dataDir, 'settings.json');
        this.settings = this.load();
    }
    get() {
        return structuredClone(this.settings);
    }
    update(patch) {
        this.settings = mergeSettings(this.settings, patch);
        // Keep deferred monetization flag locked false in v1 unless explicitly overridden in tests.
        this.settings.featureFlags.showCost = constants_1.FEATURE_FLAGS.showCost;
        this.save();
        return this.get();
    }
    setLogLevel(level) {
        return this.update({ data: { logLevel: level } });
    }
    load() {
        const defaults = createDefaultSettings();
        try {
            if (!node_fs_1.default.existsSync(this.filePath)) {
                return defaults;
            }
            const raw = JSON.parse(node_fs_1.default.readFileSync(this.filePath, 'utf8'));
            const merged = mergeSettings(defaults, raw);
            merged.featureFlags.showCost = constants_1.FEATURE_FLAGS.showCost;
            return merged;
        }
        catch {
            return defaults;
        }
    }
    save() {
        atomicWriteFileSync(this.filePath, JSON.stringify(this.settings, null, 2) + '\n');
    }
}
exports.SettingsStore = SettingsStore;
function mergeSettings(base, patch) {
    return {
        theme: patch.theme ?? base.theme,
        overlay: { ...base.overlay, ...(patch.overlay ?? {}) },
        hotkeys: { ...base.hotkeys, ...(patch.hotkeys ?? {}) },
        permissions: { ...base.permissions, ...(patch.permissions ?? {}) },
        sessions: { ...base.sessions, ...(patch.sessions ?? {}) },
        summaries: { ...base.summaries, ...(patch.summaries ?? {}) },
        usage: { ...base.usage, ...(patch.usage ?? {}) },
        mascot: { ...base.mascot, ...(patch.mascot ?? {}) },
        lifecycle: { ...base.lifecycle, ...(patch.lifecycle ?? {}) },
        data: { ...base.data, ...(patch.data ?? {}) },
        wsl: { ...base.wsl, ...(patch.wsl ?? {}) },
        featureFlags: { ...base.featureFlags, ...(patch.featureFlags ?? {}) },
    };
}
