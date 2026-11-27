import fs from 'node:fs';
import path from 'node:path';
import {
  APP_NAME,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_PERMISSION_TIMEOUT_SECONDS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TURN_EXPAND_MS,
  FEATURE_FLAGS,
} from '../../shared/constants';
import type { AppSettings, LogLevel, ThemeMode } from '../../shared/types';
import type { DeepPartial } from '../../shared/ipc';
export type { DeepPartial };

export function getAppDataDir(customDir?: string): string {
  if (customDir) return customDir;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
    return path.join(appData, APP_NAME);
  }
  const home = process.env.HOME || '.';
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
}

export function createDefaultSettings(): AppSettings {
  return {
    theme: 'system',
    overlay: {
      monitorId: null,
      offsetTop: 0,
      expandOnTurnFinishedMs: DEFAULT_TURN_EXPAND_MS,
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
      timeoutSeconds: DEFAULT_PERMISSION_TIMEOUT_SECONDS,
    },
    sessions: {
      idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
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
      retentionDays: DEFAULT_RETENTION_DAYS,
      logLevel: 'info',
    },
    wsl: {
      enabled: false,
      distro: '',
    },
    featureFlags: {
      showCost: FEATURE_FLAGS.showCost,
    },
  };
}

export function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

export class SettingsStore {
  private readonly filePath: string;
  private settings: AppSettings;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'settings.json');
    this.settings = this.load();
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  update(patch: DeepPartial<AppSettings>): AppSettings {
    this.settings = mergeSettings(this.settings, patch);
    // Keep deferred monetization flag locked false in v1 unless explicitly overridden in tests.
    this.settings.featureFlags.showCost = FEATURE_FLAGS.showCost;
    this.save();
    return this.get();
  }

  setLogLevel(level: LogLevel): AppSettings {
    return this.update({ data: { logLevel: level } });
  }

  private load(): AppSettings {
    const defaults = createDefaultSettings();
    try {
      if (!fs.existsSync(this.filePath)) {
        return defaults;
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as DeepPartial<AppSettings>;
      const merged = mergeSettings(defaults, raw);
      merged.featureFlags.showCost = FEATURE_FLAGS.showCost;
      return merged;
    } catch {
      return defaults;
    }
  }

  private save(): void {
    atomicWriteFileSync(this.filePath, JSON.stringify(this.settings, null, 2) + '\n');
  }
}

function clamp(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, Math.round(val)));
}

function mergeSettings(base: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  const allowedThemes: ThemeMode[] = ['system', 'dark', 'light'];
  const theme = patch.theme && allowedThemes.includes(patch.theme) ? patch.theme : base.theme;

  const allowedLogLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const logLevel =
    patch.data?.logLevel && allowedLogLevels.includes(patch.data.logLevel)
      ? patch.data.logLevel
      : base.data.logLevel;

  return {
    theme,
    overlay: {
      ...base.overlay,
      ...(patch.overlay ?? {}),
      offsetTop: clamp(patch.overlay?.offsetTop, 0, 500, base.overlay.offsetTop),
      expandOnTurnFinishedMs: clamp(
        patch.overlay?.expandOnTurnFinishedMs,
        0,
        30000,
        base.overlay.expandOnTurnFinishedMs,
      ),
    },
    hotkeys: { ...base.hotkeys, ...(patch.hotkeys ?? {}) },
    permissions: {
      ...base.permissions,
      timeoutSeconds: clamp(patch.permissions?.timeoutSeconds, 5, 3600, base.permissions.timeoutSeconds),
    },
    sessions: {
      ...base.sessions,
      idleTimeoutMinutes: clamp(patch.sessions?.idleTimeoutMinutes, 1, 1440, base.sessions.idleTimeoutMinutes),
    },
    summaries: { ...base.summaries, ...(patch.summaries ?? {}) },
    usage: { ...base.usage, ...(patch.usage ?? {}) },
    mascot: { ...base.mascot, ...(patch.mascot ?? {}) },
    lifecycle: { ...base.lifecycle, ...(patch.lifecycle ?? {}) },
    data: {
      ...base.data,
      logLevel,
      retentionDays: clamp(patch.data?.retentionDays, 1, 365, base.data.retentionDays),
    },
    wsl: {
      enabled: Boolean(patch.wsl?.enabled ?? base.wsl.enabled),
      distro: typeof patch.wsl?.distro === 'string'
        ? patch.wsl.distro.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
        : base.wsl.distro,
    },
    featureFlags: { ...base.featureFlags, ...(patch.featureFlags ?? {}) },
  };
}
