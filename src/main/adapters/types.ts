import type { AgentConnectionStatus, AgentId, NormalizedEvent } from '../../shared/types';
import type { AgentPaths } from './pathResolver';

export interface ConnectOptions {
  hookExecutablePath: string;
  askAgentsForSummaries: boolean;
  permissionTimeoutSeconds: number;
  enableClaudeStatusLineBridge?: boolean;
  statusLineCacheFile?: string;
}

export interface RawHookEnvelope {
  agent: AgentId;
  hookEvent?: string;
  payload: Record<string, unknown>;
  argPayload?: string;
  ppid?: number;
  pid?: number;
  sentAt?: number;
}

export interface AdapterHookMetadata {
  containsAgentWatchTag: boolean;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly supportsBlockingPermissions: boolean;
  readonly limitationNote?: string;

  getStatus(paths: AgentPaths, hookExecutablePath?: string): Promise<AgentConnectionStatus>;
  connect(paths: AgentPaths, options: ConnectOptions): Promise<AgentConnectionStatus>;
  disconnect(paths: AgentPaths): Promise<AgentConnectionStatus>;
  normalizeHookEvent(envelope: RawHookEnvelope): NormalizedEvent | null;
}
