"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionManager = void 0;
const ruleMatcher_1 = require("./ruleMatcher");
class PermissionManager {
    ruleStore;
    logger;
    callbacks;
    queue = [];
    lastNotice = null;
    constructor(ruleStore, logger, callbacks) {
        this.ruleStore = ruleStore;
        this.logger = logger;
        this.callbacks = callbacks;
    }
    getPending() {
        return this.queue.map((q) => q.pending);
    }
    getTop() {
        return this.queue[0]?.pending;
    }
    getLastNotice() {
        return this.lastNotice;
    }
    clearNotice() {
        this.lastNotice = null;
    }
    /**
     * Checks always-allow rules first; if none matches, enqueues in FIFO order and waits up to
     * timeoutSeconds. On timeout or cancel, resolves cleanly with no decision so the agent
     * falls back to its own native terminal prompt (never silently approves).
     */
    enqueue(params) {
        const matchedRule = this.ruleStore.findMatchingRule({
            agent: params.agent,
            toolName: params.toolName,
            commandOrAction: params.commandOrAction,
            cwd: params.cwd,
        });
        if (matchedRule) {
            this.logger.info('permissions', 'Auto-approved via Always-Allow rule', {
                ruleId: matchedRule.id,
                tool: params.toolName,
            });
            const pending = {
                requestId: params.requestId,
                sessionId: params.sessionId,
                agent: params.agent,
                toolName: params.toolName,
                commandOrAction: params.commandOrAction,
                rawInput: params.rawInput,
                cwd: params.cwd,
                folderName: params.folderName,
                requestedAt: Date.now(),
                expiresAt: Date.now(),
                readOnlyInTerminal: Boolean(params.readOnlyInTerminal),
            };
            this.callbacks.onResolved(pending, {
                requestId: params.requestId,
                decision: 'allow',
                reason: `Auto-allowed by rule: ${matchedRule.description}`,
            });
            return {
                autoMatchedRule: matchedRule,
                promise: Promise.resolve(this.formatHookResult(params.agent, 'allow')),
                cancelOnDisconnect: () => { },
            };
        }
        const now = Date.now();
        const timeoutMs = Math.max(5, params.timeoutSeconds) * 1000;
        const pending = {
            requestId: params.requestId,
            sessionId: params.sessionId,
            agent: params.agent,
            toolName: params.toolName,
            commandOrAction: params.commandOrAction,
            rawInput: params.rawInput,
            cwd: params.cwd,
            folderName: params.folderName,
            requestedAt: now,
            expiresAt: now + timeoutMs,
            readOnlyInTerminal: Boolean(params.readOnlyInTerminal),
        };
        let entryRef;
        const promise = new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.finishEntry(entryRef, 'ask', 'Timed out waiting for user decision');
            }, timeoutMs);
            entryRef = {
                pending,
                resolveHook: resolve,
                timer,
                settled: false,
            };
            this.queue.push(entryRef);
            this.callbacks.onQueueChanged();
        });
        const cancelOnDisconnect = () => {
            if (entryRef && !entryRef.settled) {
                this.finishEntry(entryRef, 'ask', 'Client disconnected before decision');
            }
        };
        return { promise, cancelOnDisconnect };
    }
    resolve(requestId, decision, alwaysAllow = false) {
        const entry = this.queue.find((q) => q.pending.requestId === requestId);
        if (!entry || entry.settled)
            return null;
        let ruleCreated;
        let notice;
        if (decision === 'allow' && alwaysAllow) {
            const built = (0, ruleMatcher_1.buildAlwaysAllowRule)({
                agent: entry.pending.agent,
                toolName: entry.pending.toolName,
                commandOrAction: entry.pending.commandOrAction,
                cwd: entry.pending.cwd,
            });
            if (built.rule) {
                ruleCreated = this.ruleStore.add(built.rule);
            }
            else if (built.blockedReason) {
                notice = built.blockedReason;
                this.lastNotice = built.blockedReason;
                this.callbacks.onRuleNotice?.(built.blockedReason);
            }
        }
        const response = {
            requestId,
            decision,
            alwaysAllow: Boolean(ruleCreated),
            reason: notice,
            ruleCreated,
        };
        this.finishEntry(entry, decision, notice, response);
        return response;
    }
    resolveTop(decision, alwaysAllow = false) {
        const top = this.getTop();
        if (!top)
            return null;
        return this.resolve(top.requestId, decision, alwaysAllow);
    }
    cancelAllForShutdown() {
        for (const entry of [...this.queue]) {
            this.finishEntry(entry, 'ask', 'App shutting down');
        }
    }
    finishEntry(entry, decision, reason, explicitResponse) {
        if (entry.settled)
            return;
        entry.settled = true;
        clearTimeout(entry.timer);
        this.queue = this.queue.filter((q) => q !== entry);
        const hookResult = this.formatHookResult(entry.pending.agent, decision, reason);
        entry.resolveHook(hookResult);
        this.callbacks.onResolved(entry.pending, explicitResponse ?? {
            requestId: entry.pending.requestId,
            decision,
            reason,
        });
        this.callbacks.onQueueChanged();
    }
    formatHookResult(agent, decision, reason) {
        // On timeout / shutdown / ask fallback, return empty stdout so the agent shows its own prompt.
        if (decision === 'ask') {
            return { ok: true, permissionStatus: 'ask' };
        }
        if (agent === 'claude_code' || agent === 'codex') {
            return {
                ok: true,
                permissionStatus: decision,
                stdoutJson: {
                    hookSpecificOutput: {
                        hookEventName: 'PermissionRequest',
                        decision: decision === 'allow'
                            ? { behavior: 'allow' }
                            : {
                                behavior: 'deny',
                                message: reason || 'Denied by user via AgentWatch.',
                                interrupt: false,
                            },
                    },
                },
            };
        }
        return { ok: true, permissionStatus: decision };
    }
}
exports.PermissionManager = PermissionManager;
