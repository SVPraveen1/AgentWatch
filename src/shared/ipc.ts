import type { AgentId, AppSettings, AppSnapshot, TokenAnalyticsReport } from './types';

export interface CursorPoint {
  x: number;
  y: number;
  screenX: number;
  screenY: number;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface AgentWatchAPI {
  getSnapshot: () => Promise<AppSnapshot>;
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => () => void;
  setOverlayHover: (interactive: boolean) => void;
  setOverlayExpanded: (expanded: boolean) => Promise<void>;
  resizeOverlay: (width: number, height: number) => void;
  openDashboard: (tab?: string) => Promise<void>;
  updateSettings: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>;
  connectAgent: (agent: AgentId) => Promise<void>;
  disconnectAgent: (agent: AgentId) => Promise<void>;
  recheckAgent: (agent: AgentId) => Promise<void>;
  resolvePermission: (
    requestId: string,
    decision: 'allow' | 'deny',
    alwaysAllow?: boolean,
  ) => Promise<void>;
  revokeRule: (ruleId: string) => Promise<void>;
  clearRules: () => Promise<void>;
  openTerminal: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
  stopDevServer: (pid: number, trackedChild: boolean) => Promise<{ ok: boolean; message?: string }>;
  openExternalLocalhost: (url: string) => Promise<void>;
  setAnalyticsRange: (range: TokenAnalyticsReport['range']) => Promise<void>;
  refreshUsageAndAnalytics: () => Promise<void>;
  clearHistory: () => Promise<void>;
  openLogsFolder: () => Promise<void>;
  getDisplays: () => Promise<
    Array<{
      id: number;
      label: string;
      primary: boolean;
      bounds: { x: number; y: number; width: number; height: number };
    }>
  >;
  getCursorPosition: () => Promise<CursorPoint>;
  triggerSimEvent: (kind: 'working' | 'permission' | 'finished' | 'error') => Promise<void>;
  checkForUpdatesStub: () => Promise<{ available: false; message: string }>;
}
