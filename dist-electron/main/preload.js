"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const api = {
    getSnapshot: () => electron_1.ipcRenderer.invoke('agentwatch:get-snapshot'),
    onSnapshot: (listener) => {
        const handler = (_event, snapshot) => {
            listener(snapshot);
        };
        electron_1.ipcRenderer.on('agentwatch:snapshot', handler);
        return () => electron_1.ipcRenderer.removeListener('agentwatch:snapshot', handler);
    },
    setOverlayHover: (interactive) => electron_1.ipcRenderer.send('agentwatch:overlay-hover', interactive),
    setOverlayExpanded: (expanded) => electron_1.ipcRenderer.invoke('agentwatch:overlay-expanded', expanded),
    resizeOverlay: (width, height) => electron_1.ipcRenderer.send('agentwatch:overlay-resize', { width, height }),
    openDashboard: (tab) => electron_1.ipcRenderer.invoke('agentwatch:open-dashboard', tab),
    updateSettings: (patch) => electron_1.ipcRenderer.invoke('agentwatch:update-settings', patch),
    connectAgent: (agent) => electron_1.ipcRenderer.invoke('agentwatch:connect-agent', agent),
    disconnectAgent: (agent) => electron_1.ipcRenderer.invoke('agentwatch:disconnect-agent', agent),
    recheckAgent: (agent) => electron_1.ipcRenderer.invoke('agentwatch:recheck-agent', agent),
    resolvePermission: (requestId, decision, alwaysAllow) => electron_1.ipcRenderer.invoke('agentwatch:resolve-permission', { requestId, decision, alwaysAllow }),
    revokeRule: (ruleId) => electron_1.ipcRenderer.invoke('agentwatch:revoke-rule', ruleId),
    clearRules: () => electron_1.ipcRenderer.invoke('agentwatch:clear-rules'),
    openTerminal: (sessionId) => electron_1.ipcRenderer.invoke('agentwatch:open-terminal', sessionId),
    stopDevServer: (pid, trackedChild) => electron_1.ipcRenderer.invoke('agentwatch:stop-dev-server', { pid, trackedChild }),
    openExternalLocalhost: (url) => electron_1.ipcRenderer.invoke('agentwatch:open-localhost', url),
    setAnalyticsRange: (range) => electron_1.ipcRenderer.invoke('agentwatch:set-analytics-range', range),
    refreshUsageAndAnalytics: () => electron_1.ipcRenderer.invoke('agentwatch:refresh-analytics'),
    clearHistory: () => electron_1.ipcRenderer.invoke('agentwatch:clear-history'),
    openLogsFolder: () => electron_1.ipcRenderer.invoke('agentwatch:open-logs-folder'),
    getDisplays: () => electron_1.ipcRenderer.invoke('agentwatch:get-displays'),
    getCursorPosition: () => electron_1.ipcRenderer.invoke('agentwatch:get-cursor'),
    triggerSimEvent: (kind) => electron_1.ipcRenderer.invoke('agentwatch:trigger-sim', kind),
    checkForUpdatesStub: () => electron_1.ipcRenderer.invoke('agentwatch:check-updates-stub'),
};
electron_1.contextBridge.exposeInMainWorld('agentwatch', api);
