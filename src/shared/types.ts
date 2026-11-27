export type AgentId = 'claude_code' | 'codex';

export type NormalizedEventType =
  | 'session_started'
  | 'prompt_submitted'
  | 'working'
  | 'permission_requested'
  | 'permission_resolved'
  | 'turn_finished'
  | 'needs_input'
  | 'error'
  | 'session_ended';

export type SessionState = 'working' | 'needs_you' | 'done' | 'error' | 'ended';

export type ThemeMode = 'dark' | 'light' | 'system';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type AgentConnectionState = 'not_connected' | 'connected' | 'error' | 'not_installed';

export interface TerminalWindowRef {
  hwnd?: string;
  pid?: number;
  processName?: string;
  title?: string;
}

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  agent: AgentId;
  toolName: string;
  commandOrAction: string;
  rawInput: Record<string, unknown>;
  cwd: string;
  folderName: string;
  requestedAt: number;
  expiresAt: number;
  /** True when the agent cannot be intercepted via blocking hook (e.g. Codex fallback). */
  readOnlyInTerminal: boolean;
  reason?: string;
}

export interface SessionRecord {
  id: string;
  agent: AgentId;
  cwd: string;
  folderName: string;
  title: string;
  state: SessionState;
  startedAt: number;
  lastEventAt: number;
  summary: string;
  pendingPermission?: PendingPermission;
  pendingPermissions?: PendingPermission[];
  pid?: number;
  terminalWindowRef?: TerminalWindowRef;
  transcriptPath?: string;
  lastTool?: string;
  source?: string;
  endedReason?: string;
}

export interface NormalizedEvent {
  id: string;
  type: NormalizedEventType;
  agent: AgentId;
  sessionId: string;
  timestamp: number;
  cwd: string;
  folderName: string;
  title?: string;
  summary?: string;
  toolName?: string;
  commandOrAction?: string;
  rawInput?: Record<string, unknown>;
  requestId?: string;
  pid?: number;
  transcriptPath?: string;
  lastAssistantMessage?: string;
  errorMessage?: string;
  readOnlyInTerminal?: boolean;
  decision?: 'allow' | 'deny' | 'ask';
  decisionReason?: string;
  rawPayload?: Record<string, unknown>;
}

export interface AlwaysAllowRule {
  id: string;
  agent: AgentId;
  tool: string;
  matcher: string;
  scope: 'global' | 'folder';
  cwd?: string;
  description: string;
  createdAt: number;
}

export interface PermissionDecisionResponse {
  requestId: string;
  decision: 'allow' | 'deny' | 'ask';
  alwaysAllow?: boolean;
  reason?: string;
  ruleCreated?: AlwaysAllowRule;
}

export interface UsageWindowMetric {
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: number | null;
  tokensUsed?: number;
  tokenLimit?: number | null;
  windowMinutes: number;
  estimated: boolean;
}

export interface UsageProviderResult {
  agent: AgentId;
  fiveHour?: UsageWindowMetric;
  weekly?: UsageWindowMetric;
  source: string;
  confidence: 'authoritative' | 'estimated' | 'unavailable';
  note?: string;
}

export interface DailyTokenBucket {
  date: string; // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  byAgent: Record<AgentId, number>;
  byModel: Record<string, number>;
}

export interface TokenAnalyticsReport {
  range: 'this_month' | 'last_month' | 'last_30_days';
  rangeStart: string;
  rangeEnd: string;
  totalTokens: number;
  activeDays: number;
  totalDaysInRange: number;
  byAgent: Record<AgentId, {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
  }>;
  byModel: Array<{
    model: string;
    agent: AgentId;
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
  }>;
  dailyBuckets: DailyTokenBucket[];
  forecastEndOfMonthTokens: number | null;
  forecastLabel: string;
  lastUpdatedAt: number;
}

export interface DevServerEntry {
  id: string;
  pid: number;
  ppid?: number;
  port: number;
  host: string;
  url: string;
  command: string;
  commandShort: string;
  sessionId?: string;
  agent?: AgentId;
  folderName: string;
  cwd?: string;
  trackedChild: boolean;
  detectedAt: number;
}

export interface AgentConnectionStatus {
  agent: AgentId;
  displayName: string;
  installed: boolean;
  installDetails: string;
  state: AgentConnectionState;
  configPath: string;
  hookPresent: boolean;
  supportsBlockingPermissions: boolean;
  limitationNote?: string;
  lastCheckedAt: number;
  error?: string;
}

export interface AppSettings {
  theme: ThemeMode;
  overlay: {
    monitorId: number | null;
    offsetTop: number;
    expandOnTurnFinishedMs: number;
    autoCollapseOnClickAway: boolean;
    hideOnFullscreen: boolean;
    paused: boolean;
  };
  hotkeys: {
    allow: string;
    alwaysAllow: string;
    deny: string;
  };
  permissions: {
    timeoutSeconds: number;
  };
  sessions: {
    idleTimeoutMinutes: number;
  };
  summaries: {
    askAgents: boolean;
    llmSummarizerEnabled: boolean;
  };
  usage: {
    enableClaudeStatusLineBridge: boolean;
    manualClaudeFiveHourTokens: number | null;
    manualClaudeWeeklyTokens: number | null;
    manualCodexFiveHourTokens: number | null;
    manualCodexWeeklyTokens: number | null;
  };
  mascot: {
    enabled: boolean;
    reduceMotion: 'system' | 'always' | 'never';
  };
  lifecycle: {
    launchAtLogin: boolean;
    startMinimizedToTray: boolean;
    firstRunCompleted: boolean;
  };
  data: {
    retentionDays: number;
    logLevel: LogLevel;
  };
  wsl: {
    enabled: boolean;
    distro: string;
  };
  featureFlags: {
    showCost: boolean;
  };
}

export interface AppSnapshot {
  appName: string;
  version: string;
  platform: string;
  resolvedTheme: 'dark' | 'light';
  systemReducedMotion: boolean;
  settings: AppSettings;
  sessions: SessionRecord[];
  history: NormalizedEvent[];
  pendingPermissions: PendingPermission[];
  permissionNotice?: string | null;
  rules: AlwaysAllowRule[];
  connections: Record<AgentId, AgentConnectionStatus>;
  usage: Record<AgentId, UsageProviderResult>;
  analytics: TokenAnalyticsReport;
  devServers: DevServerEntry[];
  hotkeyConflicts: string[];
  overlayExpanded: boolean;
  overlayVisible: boolean;
}
