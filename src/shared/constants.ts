/** Single constant for application branding so the app can be renamed cleanly. */
export const APP_NAME = 'AgentWatch';
export const APP_ID = 'com.agentwatch.desktop';
export const HOOK_BINARY_NAME = 'agentwatch-hook';
export const WIN32_HELPER_NAME = 'agentwatch-win32';
export const FEATURE_FLAGS = {
  /** Dollar cost calculation and monetization UI are deferred for v1. */
  showCost: false,
} as const;
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
export const DEFAULT_PERMISSION_TIMEOUT_SECONDS = 300;
export const DEFAULT_TURN_EXPAND_MS = 6000;
export const SUMMARY_MARKER_PREFIX = 'AGENTWATCH_SUMMARY:';
export const SUMMARY_MAX_CHARS = 140;
