import type { AgentConnectionStatus, AgentId, NormalizedEvent } from '../../shared/types';
import type { AgentPaths } from './pathResolver';
import type { AgentAdapter, ConnectOptions, RawHookEnvelope } from './types';

export class AdapterRegistry {
  private readonly adapters = new Map<AgentId, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(agent: AgentId): AgentAdapter | undefined {
    return this.adapters.get(agent);
  }

  all(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  async getAllStatuses(paths: AgentPaths): Promise<Record<AgentId, AgentConnectionStatus>> {
    const entries = await Promise.all(
      this.all().map(async (adapter) => [adapter.id, await adapter.getStatus(paths)] as const),
    );
    return Object.fromEntries(entries) as Record<AgentId, AgentConnectionStatus>;
  }

  async connect(agent: AgentId, paths: AgentPaths, options: ConnectOptions): Promise<AgentConnectionStatus> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new Error(`Unknown agent adapter: ${agent}`);
    return adapter.connect(paths, options);
  }

  async disconnect(agent: AgentId, paths: AgentPaths): Promise<AgentConnectionStatus> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new Error(`Unknown agent adapter: ${agent}`);
    return adapter.disconnect(paths);
  }

  normalize(envelope: RawHookEnvelope): NormalizedEvent | null {
    const adapter = this.adapters.get(envelope.agent);
    if (!adapter) return null;
    return adapter.normalizeHookEvent(envelope);
  }
}
