"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdapterRegistry = void 0;
class AdapterRegistry {
    adapters = new Map();
    register(adapter) {
        this.adapters.set(adapter.id, adapter);
    }
    get(agent) {
        return this.adapters.get(agent);
    }
    all() {
        return Array.from(this.adapters.values());
    }
    async getAllStatuses(paths) {
        const entries = await Promise.all(this.all().map(async (adapter) => [adapter.id, await adapter.getStatus(paths)]));
        return Object.fromEntries(entries);
    }
    async connect(agent, paths, options) {
        const adapter = this.adapters.get(agent);
        if (!adapter)
            throw new Error(`Unknown agent adapter: ${agent}`);
        return adapter.connect(paths, options);
    }
    async disconnect(agent, paths) {
        const adapter = this.adapters.get(agent);
        if (!adapter)
            throw new Error(`Unknown agent adapter: ${agent}`);
        return adapter.disconnect(paths);
    }
    normalize(envelope) {
        const adapter = this.adapters.get(envelope.agent);
        if (!adapter)
            return null;
        return adapter.normalizeHookEvent(envelope);
    }
}
exports.AdapterRegistry = AdapterRegistry;
