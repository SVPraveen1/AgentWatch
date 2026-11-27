import React, { useEffect, useMemo, useState } from 'react';
import { APP_NAME } from '../../shared/constants';
import type { DiagnosticBundle } from '../../shared/ipc';
import type { AgentId, AppSnapshot, LogLevel, SessionState, ThemeMode } from '../../shared/types';
import { Mascot } from '../components/Mascot';
import { UsagePanel } from './UsagePanel';

type TabId = 'overview' | 'board' | 'usage' | 'servers' | 'appearance' | 'settings';

export const DashboardApp: React.FC = () => {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(() => (typeof window !== 'undefined' ? (window as any).__INITIAL_SNAPSHOT__ ?? null : null));
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (typeof window !== 'undefined') {
      const param = new URLSearchParams(window.location.search).get('tab');
      if (param && ['overview', 'board', 'usage', 'servers', 'appearance', 'settings'].includes(param)) {
        return param as TabId;
      }
    }
    return 'overview';
  });
  const [firstRunStep, setFirstRunStep] = useState<1 | 2 | 3>(1);
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState<'all' | AgentId>('all');
  const [stateFilter, setStateFilter] = useState<'all' | SessionState>('all');
  const [folderFilter, setFolderFilter] = useState<string>('all');
  const [displays, setDisplays] = useState<Array<{ id: number; label: string; primary: boolean }>>([]);
  const [terminalFeedback, setTerminalFeedback] = useState<string | null>(null);
  const [updateStubMsg, setUpdateStubMsg] = useState<string | null>(null);
  const [diagnosticsBundle, setDiagnosticsBundle] = useState<DiagnosticBundle | null>(null);
  const [isRunningDiag, setIsRunningDiag] = useState(false);
  const [diagCopied, setDiagCopied] = useState(false);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [confirmClearRules, setConfirmClearRules] = useState(false);

  useEffect(() => {
    void window.agentwatch?.getSnapshot().then(setSnapshot);
    void window.agentwatch?.getDisplays().then(setDisplays);
    const unsub = window.agentwatch?.onSnapshot(setSnapshot);
    return () => unsub?.();
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    document.documentElement.setAttribute('data-theme', snapshot.resolvedTheme);
    const rm =
      snapshot.settings.mascot.reduceMotion === 'always'
        ? 'true'
        : snapshot.settings.mascot.reduceMotion === 'never'
          ? 'false'
          : snapshot.systemReducedMotion
            ? 'true'
            : 'false';
    document.documentElement.setAttribute('data-reduce-motion', rm);
  }, [snapshot]);

  const folderOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of snapshot?.sessions ?? []) {
      if (s.folderName) set.add(s.folderName);
    }
    return Array.from(set).sort();
  }, [snapshot?.sessions]);

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (snapshot?.sessions ?? []).filter((s) => {
      if (agentFilter !== 'all' && s.agent !== agentFilter) return false;
      if (stateFilter !== 'all' && s.state !== stateFilter) return false;
      if (folderFilter !== 'all' && s.folderName !== folderFilter) return false;
      if (q) {
        const hay = `${s.folderName} ${s.title} ${s.summary} ${s.cwd}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [snapshot?.sessions, search, agentFilter, stateFilter, folderFilter]);

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'board', label: 'Board' },
    { id: 'usage', label: 'Usage' },
    { id: 'servers', label: 'Servers' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'settings', label: 'Settings' },
  ];

  const rules = snapshot?.rules ?? [];
  const activeSessions = (snapshot?.sessions ?? []).filter((s) => s.state !== 'ended');
  const needsYouCount = activeSessions.filter((s) => s.state === 'needs_you' || s.state === 'error').length;
  const workingCount = activeSessions.filter((s) => s.state === 'working').length;
  const reduceMotion =
    snapshot?.settings.mascot.reduceMotion === 'always'
      ? true
      : snapshot?.settings.mascot.reduceMotion === 'never'
        ? false
        : Boolean(snapshot?.systemReducedMotion);

  const handleOpenTerminal = async (sessionId: string) => {
    const res = await window.agentwatch?.openTerminal(sessionId);
    if (res && !res.ok && res.message) {
      setTerminalFeedback(res.message);
      setTimeout(() => setTerminalFeedback(null), 4500);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-canvas)',
        color: 'var(--text-primary)',
        display: 'grid',
        gridTemplateColumns: '216px 1fr',
      }}
    >
      <aside
        style={{
          background: 'var(--bg-surface)',
          borderRight: '1px solid var(--border-subtle)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
            {(snapshot?.settings.mascot.enabled ?? true) && (
              <Mascot mood="working" visible={true} reduceMotion={reduceMotion} size={26} />
            )}
            <span style={{ fontWeight: 700, fontSize: 16 }}>{snapshot?.appName ?? APP_NAME}</span>
          </div>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  cursor: 'pointer',
                  background: activeTab === tab.id ? 'var(--accent-soft)' : 'transparent',
                  color: activeTab === tab.id ? 'var(--accent-primary)' : 'var(--text-secondary)',
                  fontWeight: activeTab === tab.id ? 600 : 500,
                }}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          100% Local · Zero outbound traffic
        </div>
      </aside>

      <main style={{ padding: 24, overflowY: 'auto' }}>
        {activeTab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* First-run 3-step onboarding card */}
            {snapshot && !snapshot.settings.lifecycle.firstRunCompleted && (
              <section
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--accent-primary)',
                  borderRadius: 'var(--radius-md)',
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>Welcome to {snapshot.appName} — Step {firstRunStep} of 3</strong>
                  <button
                    onClick={() =>
                      void window.agentwatch?.updateSettings({ lifecycle: { firstRunCompleted: true } })
                    }
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    Dismiss
                  </button>
                </div>

                {firstRunStep === 1 && (
                  <>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      {snapshot.appName} watches Claude Code and Codex locally from a non-intrusive top-center notch overlay so you know immediately when an agent finishes, needs input, or requests permission.
                    </div>
                    <div>
                      <button
                        onClick={() => setFirstRunStep(2)}
                        style={{
                          padding: '7px 14px',
                          borderRadius: 'var(--radius-sm)',
                          border: 'none',
                          background: 'var(--accent-primary)',
                          color: 'var(--text-on-accent)',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Next: Connect agents
                      </button>
                    </div>
                  </>
                )}

                {firstRunStep === 2 && (
                  <>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      Connect each agent in one click (existing settings and comments are backed up and preserved):
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {(['claude_code', 'codex'] as AgentId[]).map((ag) => {
                        const conn = snapshot.connections[ag];
                        const isConn = conn?.state === 'connected';
                        return (
                          <button
                            key={ag}
                            onClick={() =>
                              void (isConn
                                ? window.agentwatch?.disconnectAgent(ag)
                                : window.agentwatch?.connectAgent(ag))
                            }
                            style={{
                              padding: '7px 12px',
                              borderRadius: 'var(--radius-sm)',
                              border: '1px solid var(--border-strong)',
                              background: isConn ? 'var(--status-done-bg)' : 'var(--accent-primary)',
                              color: isConn ? 'var(--status-done)' : 'var(--text-on-accent)',
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            {isConn
                              ? `Connected: ${conn.displayName}`
                              : `Connect ${conn?.displayName ?? ag}`}
                          </button>
                        );
                      })}
                      <button
                        onClick={() => setFirstRunStep(3)}
                        style={{
                          padding: '7px 14px',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border-strong)',
                          background: 'var(--bg-surface-elevated)',
                          color: 'var(--text-primary)',
                          cursor: 'pointer',
                        }}
                      >
                        Next
                      </button>
                    </div>
                  </>
                )}

                {firstRunStep === 3 && (
                  <>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      You&apos;re all set! Start a new Claude Code or Codex session in your terminal and it will appear here and in the top-center notch.
                    </div>
                    <div>
                      <button
                        onClick={() =>
                          void window.agentwatch?.updateSettings({ lifecycle: { firstRunCompleted: true } })
                        }
                        style={{
                          padding: '7px 14px',
                          borderRadius: 'var(--radius-sm)',
                          border: 'none',
                          background: 'var(--status-done)',
                          color: '#ffffff',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Done
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}

            <div>
              <h1 style={{ margin: 0, fontSize: 22 }}>Overview</h1>
              <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', fontSize: 13 }}>
                Connect your local coding agents below. Sessions started <strong>after</strong> connecting report in automatically.
              </p>
            </div>

            {/* Summary of what's happening now */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Needs You</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: needsYouCount > 0 ? 'var(--status-needs-you)' : 'var(--text-primary)' }}>
                  {needsYouCount}
                </div>
              </div>
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Working</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--status-working)' }}>{workingCount}</div>
              </div>
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Dev Servers</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{snapshot?.devServers.length ?? 0}</div>
              </div>
            </div>

            {/* Connection cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
              {(['claude_code', 'codex'] as AgentId[]).map((agentId) => {
                const conn = snapshot?.connections[agentId];
                const isConnected = conn?.state === 'connected';
                return (
                  <div
                    key={agentId}
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      padding: 16,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontSize: 15 }}>{conn?.displayName ?? agentId}</strong>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: 'var(--radius-pill)',
                          background: isConnected
                            ? 'var(--status-done-bg)'
                            : conn?.state === 'error'
                              ? 'var(--status-error-bg)'
                              : 'var(--bg-surface-elevated)',
                          color: isConnected
                            ? 'var(--status-done)'
                            : conn?.state === 'error'
                              ? 'var(--status-error)'
                              : 'var(--text-secondary)',
                        }}
                      >
                        {conn?.state === 'connected'
                          ? 'Connected'
                          : conn?.state === 'error'
                            ? 'Error'
                            : conn?.installed
                              ? 'Not connected'
                              : 'Not installed'}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {conn?.installDetails}
                    </div>
                    {conn?.error && (
                      <div style={{ fontSize: 12, color: 'var(--status-error)' }}>{conn.error}</div>
                    )}
                    {conn?.limitationNote && (
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--text-secondary)',
                          background: 'var(--bg-surface-elevated)',
                          padding: '6px 8px',
                          borderRadius: 'var(--radius-sm)',
                        }}
                      >
                        Note: {conn.limitationNote}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {isConnected ? (
                        <>
                          <button
                            onClick={() => void window.agentwatch?.recheckAgent(agentId)}
                            style={{
                              padding: '6px 12px',
                              borderRadius: 'var(--radius-sm)',
                              border: '1px solid var(--border-strong)',
                              background: 'var(--bg-surface-elevated)',
                              color: 'var(--text-primary)',
                              fontSize: 12,
                              cursor: 'pointer',
                            }}
                          >
                            Re-check status
                          </button>
                          <button
                            onClick={() => void window.agentwatch?.disconnectAgent(agentId)}
                            style={{
                              padding: '4px 8px',
                              borderRadius: 'var(--radius-sm)',
                              border: 'none',
                              background: 'transparent',
                              color: 'var(--text-muted)',
                              fontSize: 12,
                              cursor: 'pointer',
                              textDecoration: 'underline',
                              marginLeft: 'auto',
                            }}
                          >
                            Disconnect
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => void window.agentwatch?.connectAgent(agentId)}
                            style={{
                              padding: '7px 14px',
                              borderRadius: 'var(--radius-sm)',
                              border: 'none',
                              background: 'var(--accent-primary)',
                              color: 'var(--text-on-accent)',
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            Connect {conn?.displayName ?? agentId}
                          </button>
                          <button
                            onClick={() => void window.agentwatch?.recheckAgent(agentId)}
                            style={{
                              padding: '7px 10px',
                              borderRadius: 'var(--radius-sm)',
                              border: '1px solid var(--border-strong)',
                              background: 'transparent',
                              color: 'var(--text-secondary)',
                              cursor: 'pointer',
                            }}
                          >
                            Re-check
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Recent Sessions Bridge */}
            <div
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 15 }}>Recent Sessions</strong>
                <button
                  onClick={() => setActiveTab('board')}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--accent-primary)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  View all in Board →
                </button>
              </div>

              {(snapshot?.sessions ?? []).length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', padding: '8px 0' }}>
                  No active or past sessions yet. Start a session in your terminal with <code>claude</code> or <code>codex</code> to see it appear here live.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(snapshot?.sessions ?? []).slice(0, 3).map((s) => (
                    <div
                      key={s.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 12px',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--bg-canvas)',
                        border: '1px solid var(--border-subtle)',
                        gap: 12,
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>
                            {s.agent === 'claude_code' ? 'Claude Code' : 'Codex'} · {s.folderName}
                          </span>
                          <span
                            style={{
                              fontSize: 10.5,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              padding: '2px 6px',
                              borderRadius: 'var(--radius-pill)',
                              background:
                                s.state === 'needs_you'
                                  ? 'var(--status-needs-you-bg)'
                                  : s.state === 'working'
                                    ? 'var(--status-working-bg)'
                                    : 'var(--status-done-bg)',
                              color:
                                s.state === 'needs_you'
                                  ? 'var(--status-needs-you)'
                                  : s.state === 'working'
                                    ? 'var(--status-working)'
                                    : 'var(--status-done)',
                            }}
                          >
                            {s.state.replace('_', ' ')}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--text-secondary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {s.summary || s.title}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        {s.pendingPermission && !s.pendingPermission.readOnlyInTerminal && (
                          <>
                            <button
                              onClick={() =>
                                void window.agentwatch?.resolvePermission(s.pendingPermission!.requestId, 'deny', false)
                              }
                              style={{
                                padding: '4px 8px',
                                fontSize: 11,
                                borderRadius: 'var(--radius-sm)',
                                border: '1px solid var(--border-strong)',
                                background: 'var(--status-error-bg)',
                                color: 'var(--status-error)',
                                cursor: 'pointer',
                              }}
                            >
                              Deny
                            </button>
                            <button
                              onClick={() =>
                                void window.agentwatch?.resolvePermission(s.pendingPermission!.requestId, 'allow', false)
                              }
                              style={{
                                padding: '4px 8px',
                                fontSize: 11,
                                borderRadius: 'var(--radius-sm)',
                                border: 'none',
                                background: 'var(--accent-primary)',
                                color: 'var(--text-on-accent)',
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                            >
                              Allow
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => void handleOpenTerminal(s.id)}
                          style={{
                            padding: '4px 8px',
                            fontSize: 11,
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-strong)',
                            background: 'var(--bg-surface-elevated)',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                          }}
                        >
                          Terminal
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* How it works */}
            <div
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: 16,
                fontSize: 12.5,
                color: 'var(--text-secondary)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <strong style={{ color: 'var(--text-primary)', fontSize: 14 }}>How it works</strong>
              <div>1. Connect adds lightweight tagged hooks to your Claude Code and Codex user configs (after creating backups).</div>
              <div>2. Events stream over a token-authenticated localhost loopback channel (`127.0.0.1` only, zero outbound network traffic).</div>
              <div>3. Permission prompts pause cleanly in the overlay until you approve, deny, or fall back to the agent&apos;s own terminal prompt.</div>
            </div>
          </div>
        )}

        {activeTab === 'board' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h1 style={{ margin: 0, fontSize: 22 }}>Sessions Board</h1>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search folder, title, summary..."
                style={{
                  flex: '1 1 200px',
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                }}
              />
              <select
                value={agentFilter}
                onChange={(e) => setAgentFilter(e.target.value as 'all' | AgentId)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value="all">All Agents</option>
                <option value="claude_code">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
              <select
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value as 'all' | SessionState)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value="all">All States</option>
                <option value="needs_you">Needs you</option>
                <option value="working">Working</option>
                <option value="done">Done</option>
                <option value="error">Error</option>
                <option value="ended">Ended</option>
              </select>
              <select
                value={folderFilter}
                onChange={(e) => setFolderFilter(e.target.value)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value="all">All Folders</option>
                {folderOptions.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>

            {terminalFeedback && (
              <div style={{ fontSize: 12, color: 'var(--status-needs-you)' }}>{terminalFeedback}</div>
            )}

            {filteredSessions.length === 0 ? (
              <div
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: 20,
                  color: 'var(--text-secondary)',
                }}
              >
                No sessions match the current filters.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filteredSessions.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      padding: 14,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <strong>
                        {s.agent === 'claude_code' ? 'Claude Code' : 'Codex'} · {s.folderName}
                      </strong>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{s.state}</span>
                        <button
                          onClick={() => void handleOpenTerminal(s.id)}
                          style={{
                            padding: '4px 9px',
                            fontSize: 11,
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-strong)',
                            background: 'var(--bg-surface-elevated)',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                          }}
                        >
                          Open Terminal
                        </button>
                        {(s.state === 'done' || s.state === 'ended') && (
                          <button
                            onClick={() => void window.agentwatch?.dismissSession(s.id)}
                            style={{
                              padding: '4px 9px',
                              fontSize: 11,
                              borderRadius: 'var(--radius-sm)',
                              border: '1px solid var(--border-subtle)',
                              background: 'transparent',
                              color: 'var(--text-muted)',
                              cursor: 'pointer',
                            }}
                          >
                            Dismiss
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                      {s.summary || s.title}
                    </div>
                    {s.pendingPermission && !s.pendingPermission.readOnlyInTerminal && (
                      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                        <button
                          onClick={() =>
                            void window.agentwatch?.resolvePermission(s.pendingPermission!.requestId, 'deny', false)
                          }
                          style={{
                            padding: '5px 10px',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-strong)',
                            background: 'var(--status-error-bg)',
                            color: 'var(--status-error)',
                            cursor: 'pointer',
                          }}
                        >
                          Deny
                        </button>
                        <button
                          onClick={() =>
                            void window.agentwatch?.resolvePermission(s.pendingPermission!.requestId, 'allow', false)
                          }
                          style={{
                            padding: '5px 10px',
                            borderRadius: 'var(--radius-sm)',
                            border: 'none',
                            background: 'var(--accent-primary)',
                            color: 'var(--text-on-accent)',
                            cursor: 'pointer',
                          }}
                        >
                          Allow
                        </button>
                        <button
                          onClick={() =>
                            void window.agentwatch?.resolvePermission(s.pendingPermission!.requestId, 'allow', true)
                          }
                          style={{
                            padding: '5px 10px',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-strong)',
                            background: 'var(--bg-surface-elevated)',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                          }}
                        >
                          Always allow
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'usage' && <UsagePanel snapshot={snapshot} />}

        {activeTab === 'servers' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 22 }}>Dev Servers</h1>
              <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', fontSize: 13 }}>
                Listening TCP dev servers started as child processes of active agent sessions.
              </p>
            </div>
            {(snapshot?.devServers.length ?? 0) === 0 ? (
              <div
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: 20,
                  color: 'var(--text-secondary)',
                }}
              >
                No active dev servers detected from tracked sessions.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {snapshot!.devServers.map((ds) => (
                  <div
                    key={ds.id}
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      padding: 14,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {ds.folderName} · <code>{ds.commandShort}</code>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                        PID {ds.pid} ·{' '}
                        <a
                          href={ds.url}
                          onClick={(e) => {
                            e.preventDefault();
                            void window.agentwatch?.openExternalLocalhost(ds.url);
                          }}
                          style={{ color: 'var(--accent-primary)' }}
                        >
                          {ds.url}
                        </a>
                      </div>
                    </div>
                    <button
                      onClick={() => void window.agentwatch?.stopDevServer(ds.pid, ds.trackedChild)}
                      style={{
                        padding: '7px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-strong)',
                        background: 'var(--status-error-bg)',
                        color: 'var(--status-error)',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Stop
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'appearance' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h1 style={{ margin: 0, fontSize: 22 }}>Appearance</h1>

            <section style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 16 }}>
              <strong style={{ fontSize: 14 }}>Theme</strong>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {(['dark', 'light', 'system'] as ThemeMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => void window.agentwatch?.updateSettings({ theme: mode })}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background:
                        snapshot?.settings.theme === mode
                          ? 'var(--accent-primary)'
                          : 'var(--bg-surface-elevated)',
                      color:
                        snapshot?.settings.theme === mode
                          ? 'var(--text-on-accent)'
                          : 'var(--text-primary)',
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                    }}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </section>

            <section style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong style={{ fontSize: 14 }}>Overlay Position & Behavior</strong>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Target monitor
                  <select
                    value={snapshot?.settings.overlay.monitorId ?? ''}
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({
                        overlay: { monitorId: e.target.value ? Number(e.target.value) : null },
                      })
                    }
                    style={{
                      padding: 8,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <option value="">Primary display (Default)</option>
                    {displays.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                </label>
                <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Top offset (px)
                  <input
                    type="number"
                    min={0}
                    max={120}
                    value={snapshot?.settings.overlay.offsetTop ?? 0}
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({
                        overlay: { offsetTop: Math.max(0, Number(e.target.value) || 0) },
                      })
                    }
                    style={{
                      padding: 8,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>
                <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Turn-finished expand duration (seconds)
                  <input
                    type="number"
                    min={0}
                    max={60}
                    value={Math.round((snapshot?.settings.overlay.expandOnTurnFinishedMs ?? 6000) / 1000)}
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({
                        overlay: { expandOnTurnFinishedMs: Math.max(0, Number(e.target.value) || 0) * 1000 },
                      })
                    }
                    style={{
                      padding: 8,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>
              </div>
              <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={snapshot?.settings.overlay.hideOnFullscreen ?? false}
                  onChange={(e) =>
                    void window.agentwatch?.updateSettings({
                      overlay: { hideOnFullscreen: e.target.checked },
                    })
                  }
                />
                Hide overlay while a fullscreen app is focused
              </label>
              <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={snapshot?.settings.overlay.paused ?? false}
                  onChange={(e) =>
                    void window.agentwatch?.updateSettings({
                      overlay: { paused: e.target.checked },
                    })
                  }
                />
                Pause overlay popups (still records sessions & events)
              </label>
            </section>

            <section style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong style={{ fontSize: 14 }}>Mascot</strong>
              <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={snapshot?.settings.mascot.enabled ?? true}
                  onChange={(e) =>
                    void window.agentwatch?.updateSettings({
                      mascot: { enabled: e.target.checked },
                    })
                  }
                />
                Show animated mascot in overlay
              </label>
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                Motion preference:
                <select
                  value={snapshot?.settings.mascot.reduceMotion ?? 'system'}
                  onChange={(e) =>
                    void window.agentwatch?.updateSettings({
                      mascot: { reduceMotion: e.target.value as 'system' | 'always' | 'never' },
                    })
                  }
                  style={{
                    padding: 6,
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-strong)',
                    background: 'var(--bg-input)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="system">Follow Windows Reduce Motion</option>
                  <option value="always">Always Reduce Motion</option>
                  <option value="never">Full Motion</option>
                </select>
              </label>
            </section>
          </div>
        )}

        {activeTab === 'settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h1 style={{ margin: 0, fontSize: 22 }}>Settings</h1>

            <section
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <strong style={{ fontSize: 15 }}>Permission Hotkeys (active only while pending)</strong>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Allow
                  <input
                    value={snapshot?.settings.hotkeys.allow ?? 'Control+Y'}
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({ hotkeys: { allow: e.target.value } })
                    }
                    style={{
                      padding: 8,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>
                <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Always allow
                  <input
                    value={snapshot?.settings.hotkeys.alwaysAllow ?? 'Control+Shift+Y'}
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({
                        hotkeys: { alwaysAllow: e.target.value },
                      })
                    }
                    style={{
                      padding: 8,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>
                <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Deny
                  <input
                    value={snapshot?.settings.hotkeys.deny ?? 'Control+N'}
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({ hotkeys: { deny: e.target.value } })
                    }
                    style={{
                      padding: 8,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>
              </div>
              {(snapshot?.hotkeyConflicts.length ?? 0) > 0 && (
                <div
                  style={{
                    fontSize: 12,
                    padding: 10,
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--status-needs-you-bg)',
                    color: 'var(--status-needs-you)',
                  }}
                >
                  {snapshot?.hotkeyConflicts.map((w) => <div key={w}>{w}</div>)}
                </div>
              )}
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                Permission fallback timeout (seconds):
                <input
                  type="number"
                  min={15}
                  max={1800}
                  value={snapshot?.settings.permissions.timeoutSeconds ?? 300}
                  onChange={(e) =>
                    void window.agentwatch?.updateSettings({
                      permissions: { timeoutSeconds: Math.max(15, Number(e.target.value) || 300) },
                    })
                  }
                  style={{
                    width: 90,
                    padding: 6,
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-strong)',
                    background: 'var(--bg-input)',
                    color: 'var(--text-primary)',
                  }}
                />
              </label>
            </section>

            <section
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <strong style={{ fontSize: 15 }}>Summaries</strong>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={snapshot?.settings.summaries.askAgents ?? true}
                  onChange={(e) =>
                    void window.agentwatch?.updateSettings({
                      summaries: { askAgents: e.target.checked },
                    })
                  }
                />
                Ask agents for summaries (Tier 1 AGENTWATCH_SUMMARY via hooks; fallback local watcher always active)
              </label>
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  disabled
                  checked={snapshot?.settings.summaries.llmSummarizerEnabled ?? false}
                />
                Optional LLM summarizer (stub in v1 — consumes your agent CLI quota if enabled in future builds)
              </label>
            </section>

            <section
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 15 }}>Always-Allow Rules ({rules.length})</strong>
                {rules.length > 0 &&
                  (confirmClearRules ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: 'var(--status-error)' }}>Clear all {rules.length} rules?</span>
                      <button
                        onClick={() => {
                          void window.agentwatch?.clearRules();
                          setConfirmClearRules(false);
                        }}
                        style={{
                          padding: '4px 8px',
                          fontSize: 11,
                          borderRadius: 'var(--radius-sm)',
                          border: 'none',
                          background: 'var(--status-error)',
                          color: '#ffffff',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Yes, clear all
                      </button>
                      <button
                        onClick={() => setConfirmClearRules(false)}
                        style={{
                          padding: '4px 8px',
                          fontSize: 11,
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border-strong)',
                          background: 'transparent',
                          color: 'var(--text-secondary)',
                          cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmClearRules(true)}
                      style={{
                        padding: '5px 10px',
                        fontSize: 11,
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-strong)',
                        background: 'transparent',
                        color: 'var(--status-error)',
                        cursor: 'pointer',
                      }}
                    >
                      Clear all rules
                    </button>
                  ))}
              </div>
              {rules.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  No always-allow rules created yet.
                </div>
              ) : (
                rules.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-surface-elevated)',
                      fontSize: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600 }}>{r.description}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        Tool: {r.tool} · Matcher: <code>{r.matcher}</code> · Scope: {r.scope}
                      </div>
                    </div>
                    <button
                      onClick={() => void window.agentwatch?.revokeRule(r.id)}
                      style={{
                        padding: '5px 10px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-strong)',
                        background: 'transparent',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                      }}
                    >
                      Revoke
                    </button>
                  </div>
                ))
              )}
            </section>

            <section
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <strong style={{ fontSize: 15 }}>Startup, WSL &amp; Privacy Controls</strong>
              <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={snapshot?.settings.lifecycle.launchAtLogin ?? false}
                  onChange={(e) =>
                    void window.agentwatch?.updateSettings({
                      lifecycle: { launchAtLogin: e.target.checked },
                    })
                  }
                />
                Launch at login
              </label>
              <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={snapshot?.settings.lifecycle.startMinimizedToTray ?? true}
                  onChange={(e) =>
                    void window.agentwatch?.updateSettings({
                      lifecycle: { startMinimizedToTray: e.target.checked },
                    })
                  }
                />
                Start minimized to tray (after onboarding)
              </label>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  History retention (days):
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={snapshot?.settings.data.retentionDays ?? 90}
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({
                        data: { retentionDays: Math.max(1, Number(e.target.value) || 90) },
                      })
                    }
                    style={{
                      width: 72,
                      padding: 6,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Idle timeout (min):
                  <input
                    type="number"
                    min={1}
                    max={240}
                    value={snapshot?.settings.sessions.idleTimeoutMinutes ?? 30}
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({
                        sessions: { idleTimeoutMinutes: Math.max(1, Number(e.target.value) || 30) },
                      })
                    }
                    style={{
                      width: 72,
                      padding: 6,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Log level:
                  <select
                    value={snapshot?.settings.data.logLevel ?? 'info'}
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({
                        data: { logLevel: e.target.value as LogLevel },
                      })
                    }
                    style={{
                      padding: 6,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <option value="debug">debug</option>
                    <option value="info">info</option>
                    <option value="warn">warn</option>
                    <option value="error">error</option>
                  </select>
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={snapshot?.settings.wsl.enabled ?? false}
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({
                        wsl: { enabled: e.target.checked },
                      })
                    }
                  />
                  Resolve agent configs/logs inside WSL distro (\\wsl$\...)
                </label>
                {snapshot?.settings.wsl.enabled && (
                  <input
                    value={snapshot?.settings.wsl.distro ?? ''}
                    placeholder="Distro name (e.g. Ubuntu)"
                    onChange={(e) =>
                      void window.agentwatch?.updateSettings({
                        wsl: { distro: e.target.value },
                      })
                    }
                    style={{
                      padding: 6,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  />
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  onClick={() => void window.agentwatch?.openLogsFolder()}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-strong)',
                    background: 'var(--bg-surface-elevated)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                  }}
                >
                  Open logs folder
                </button>
                <button
                  onClick={() => {
                    void window.agentwatch?.checkForUpdatesStub().then((res) => setUpdateStubMsg(res.message));
                  }}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-strong)',
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Check for updates
                </button>
              </div>
              {updateStubMsg && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{updateStubMsg}</div>
              )}
            </section>

            <section
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ fontSize: 14 }}>System Self-Test & Diagnostics</strong>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Verify local loopback health, adapter hooks, Win32 helper, and display scaling.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    disabled={isRunningDiag}
                    onClick={() => {
                      setIsRunningDiag(true);
                      void window.agentwatch?.runDiagnostics().then((bundle) => {
                        setDiagnosticsBundle(bundle);
                        setIsRunningDiag(false);
                      });
                    }}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 'var(--radius-sm)',
                      border: 'none',
                      background: 'var(--accent-primary)',
                      color: 'var(--text-on-accent)',
                      fontWeight: 600,
                      cursor: isRunningDiag ? 'wait' : 'pointer',
                    }}
                  >
                    {isRunningDiag ? 'Running...' : 'Run Diagnostics'}
                  </button>
                  {diagnosticsBundle && (
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(diagnosticsBundle.markdown).then(() => {
                          setDiagCopied(true);
                          setTimeout(() => setDiagCopied(false), 3000);
                        });
                      }}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-strong)',
                        background: 'var(--bg-surface-elevated)',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                      }}
                    >
                      {diagCopied ? 'Copied!' : 'Copy Support Bundle'}
                    </button>
                  )}
                </div>
              </div>

              {diagnosticsBundle && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  {diagnosticsBundle.checks.map((chk, idx) => {
                    const statusColor =
                      chk.status === 'pass'
                        ? 'var(--status-done)'
                        : chk.status === 'warn'
                          ? 'var(--status-needs-you)'
                          : 'var(--status-error)';
                    const statusBg =
                      chk.status === 'pass'
                        ? 'var(--status-done-bg)'
                        : chk.status === 'warn'
                          ? 'var(--status-needs-you-bg)'
                          : 'var(--status-error-bg)';
                    return (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '8px 10px',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--bg-canvas)',
                          border: '1px solid var(--border-subtle)',
                          fontSize: 12,
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontWeight: 600 }}>{chk.name}</span>
                          <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{chk.details}</span>
                        </div>
                        <span
                          style={{
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-pill)',
                            background: statusBg,
                            color: statusColor,
                            fontWeight: 700,
                            fontSize: 10.5,
                            textTransform: 'uppercase',
                          }}
                        >
                          {chk.status}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--status-error)',
                borderRadius: 'var(--radius-md)',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div>
                <strong style={{ fontSize: 15, color: 'var(--status-error)' }}>Danger Zone</strong>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                  Irreversible actions that purge local session histories or permission rules.
                </p>
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-canvas)',
                  border: '1px solid var(--border-subtle)',
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Purge Session History</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 2 }}>
                    Permanently wipe all locally stored session transcripts, events, and turn records ({snapshot?.settings.data.retentionDays ?? 90}-day retention cache).
                  </div>
                </div>
                {confirmClearHistory ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: 'var(--status-error)', fontWeight: 600 }}>Are you sure?</span>
                    <button
                      onClick={() => {
                        void window.agentwatch?.clearHistory();
                        setConfirmClearHistory(false);
                      }}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: 'none',
                        background: 'var(--status-error)',
                        color: '#ffffff',
                        fontWeight: 600,
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      Yes, wipe history
                    </button>
                    <button
                      onClick={() => setConfirmClearHistory(false)}
                      style={{
                        padding: '6px 10px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-strong)',
                        background: 'transparent',
                        color: 'var(--text-secondary)',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmClearHistory(true)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--status-error)',
                      background: 'var(--status-error-bg)',
                      color: 'var(--status-error)',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    Clear history
                  </button>
                )}
              </div>
            </section>

            <section
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: 16,
                fontSize: 12.5,
                color: 'var(--text-secondary)',
              }}
            >
              <strong style={{ color: 'var(--text-primary)' }}>
                About {snapshot?.appName ?? APP_NAME}
              </strong>
              <div style={{ marginTop: 4 }}>
                Version {snapshot?.version ?? '0.1.0'} · Platform {snapshot?.platform ?? 'win32'} · Fully local, zero accounts, zero telemetry, zero outbound network requests.
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
};
