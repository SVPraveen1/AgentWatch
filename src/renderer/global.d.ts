import type { AgentWatchAPI } from '../shared/ipc';

declare global {
  interface Window {
    agentwatch?: AgentWatchAPI;
  }
}

export {};
