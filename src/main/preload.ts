import { contextBridge, ipcRenderer } from 'electron';
import type { AgentWatchAPI } from '../shared/ipc';

const api: AgentWatchAPI = {
  getSnapshot: () => ipcRenderer.invoke('agentwatch:get-snapshot'),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => {
      listener(snapshot);
    };
    ipcRenderer.on('agentwatch:snapshot', handler);
    return () => ipcRenderer.removeListener('agentwatch:snapshot', handler);
  },
  setOverlayHover: (interactive) => ipcRenderer.send('agentwatch:overlay-hover', interactive),
  setOverlayExpanded: (expanded) => ipcRenderer.invoke('agentwatch:overlay-expanded', expanded),
  resizeOverlay: (width, height) => ipcRenderer.send('agentwatch:overlay-resize', { width, height }),
  openDashboard: (tab) => ipcRenderer.invoke('agentwatch:open-dashboard', tab),
  updateSettings: (patch) => ipcRenderer.invoke('agentwatch:update-settings', patch),
  connectAgent: (agent) => ipcRenderer.invoke('agentwatch:connect-agent', agent),
  disconnectAgent: (agent) => ipcRenderer.invoke('agentwatch:disconnect-agent', agent),
  recheckAgent: (agent) => ipcRenderer.invoke('agentwatch:recheck-agent', agent),
  resolvePermission: (requestId, decision, alwaysAllow) =>
    ipcRenderer.invoke('agentwatch:resolve-permission', { requestId, decision, alwaysAllow }),
  revokeRule: (ruleId) => ipcRenderer.invoke('agentwatch:revoke-rule', ruleId),
  clearRules: () => ipcRenderer.invoke('agentwatch:clear-rules'),
  dismissSession: (sessionId) => ipcRenderer.invoke('agentwatch:dismiss-session', sessionId),
  openTerminal: (sessionId) => ipcRenderer.invoke('agentwatch:open-terminal', sessionId),
  stopDevServer: (pid, trackedChild) =>
    ipcRenderer.invoke('agentwatch:stop-dev-server', { pid, trackedChild }),
  openExternalLocalhost: (url) => ipcRenderer.invoke('agentwatch:open-localhost', url),
  setAnalyticsRange: (range) => ipcRenderer.invoke('agentwatch:set-analytics-range', range),
  refreshUsageAndAnalytics: () => ipcRenderer.invoke('agentwatch:refresh-analytics'),
  clearHistory: () => ipcRenderer.invoke('agentwatch:clear-history'),
  openLogsFolder: () => ipcRenderer.invoke('agentwatch:open-logs-folder'),
  runDiagnostics: () => ipcRenderer.invoke('agentwatch:run-diagnostics'),
  getDisplays: () => ipcRenderer.invoke('agentwatch:get-displays'),
  getCursorPosition: () => ipcRenderer.invoke('agentwatch:get-cursor'),
  triggerSimEvent: (kind) => ipcRenderer.invoke('agentwatch:trigger-sim', kind),
  checkForUpdatesStub: () => ipcRenderer.invoke('agentwatch:check-updates-stub'),
};

contextBridge.exposeInMainWorld('agentwatch', api);
