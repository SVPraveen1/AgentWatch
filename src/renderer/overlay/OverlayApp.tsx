import React, { useEffect, useRef, useState } from 'react';
import { APP_NAME } from '../../shared/constants';
import type { AppSnapshot, SessionRecord } from '../../shared/types';
import { deriveMascotMood, Mascot } from '../components/Mascot';

export function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function formatHotkeyLabel(accel: string): string {
  return accel.replace(/CommandOrControl/gi, 'Ctrl').replace(/Control/gi, 'Ctrl');
}

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatWindowChip(res: AppSnapshot['usage']['claude_code'] | undefined): string {
  if (!res || !res.fiveHour) return '—';
  const w = res.fiveHour;
  if (w.remainingPercent !== null) {
    return `${Math.round(w.remainingPercent)}% left${w.estimated ? ' (est)' : ''}`;
  }
  if (typeof w.tokensUsed === 'number' && w.tokensUsed > 0) {
    return `${formatCompactTokens(w.tokensUsed)} tok (est)`;
  }
  return '—';
}

const STATE_LABEL: Record<SessionRecord['state'], string> = {
  needs_you: 'Needs you',
  error: 'Error',
  working: 'Working',
  done: 'Done',
  ended: 'Ended',
};

const STATE_COLOR: Record<SessionRecord['state'], string> = {
  needs_you: 'var(--status-needs-you)',
  error: 'var(--status-error)',
  working: 'var(--status-working)',
  done: 'var(--status-done)',
  ended: 'var(--status-ended)',
};

export const OverlayApp: React.FC = () => {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);

  useEffect(() => {
    void window.agentwatch?.getSnapshot().then(setSnapshot);
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && snapshot?.overlayExpanded && snapshot.pendingPermissions.length === 0) {
        void window.agentwatch?.setOverlayExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [snapshot?.overlayExpanded, snapshot?.pendingPermissions.length]);

  const expanded = snapshot?.overlayExpanded ?? false;
  const pendingList = snapshot?.pendingPermissions ?? [];
  const topPerm = pendingList[0];
  const sessions = snapshot?.sessions.filter((s) => s.state !== 'ended').slice(0, 6) ?? [];
  const devServers = snapshot?.devServers ?? [];
  const workingCount = sessions.filter((s) => s.state === 'working').length;
  const needsCount =
    pendingList.length +
    sessions.filter((s) => !s.pendingPermission && (s.state === 'needs_you' || s.state === 'error')).length;

  const [terminalMsg, setTerminalMsg] = useState<string | null>(null);
  const [lastTurnFinishedAt, setLastTurnFinishedAt] = useState<number>(0);
  const seenTurnIdRef = useRef<string>('');

  useEffect(() => {
    const latestTurn = snapshot?.history.find((h) => h.type === 'turn_finished');
    if (latestTurn && latestTurn.id !== seenTurnIdRef.current) {
      const wasEmpty = seenTurnIdRef.current === '';
      seenTurnIdRef.current = latestTurn.id;
      if (!wasEmpty) {
        setLastTurnFinishedAt(Date.now());
      }
    }
  }, [snapshot?.history]);

  const reduceMotion =
    snapshot?.settings.mascot.reduceMotion === 'always'
      ? true
      : snapshot?.settings.mascot.reduceMotion === 'never'
        ? false
        : Boolean(snapshot?.systemReducedMotion);
  const mascotMood = deriveMascotMood({
    sessions: snapshot?.sessions ?? [],
    pendingCount: pendingList.length,
    lastTurnFinishedAt,
  });

  useEffect(() => {
    if (!expanded) {
      window.agentwatch?.resizeOverlay(220, 48);
    } else {
      const targetHeight = Math.min(
        620,
        165 +
          (topPerm ? 165 : 0) +
          Math.max(1, sessions.length) * 62 +
          (devServers.length > 0 ? 46 + devServers.length * 34 : 0),
      );
      window.agentwatch?.resizeOverlay(440, targetHeight);
    }
  }, [expanded, topPerm?.requestId, sessions.length, devServers.length, snapshot?.permissionNotice]);

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        pointerEvents: 'none',
      }}
    >
      <div
        onMouseEnter={() => window.agentwatch?.setOverlayHover(true)}
        onMouseLeave={() => window.agentwatch?.setOverlayHover(false)}
        style={{
          pointerEvents: 'auto',
          background: 'var(--bg-notch)',
          color: 'var(--text-primary)',
          borderRadius: '0 0 18px 18px',
          boxShadow: 'var(--shadow-overlay)',
          padding: expanded ? '10px 14px 12px' : '6px 14px',
          width: expanded ? '428px' : 'auto',
          minWidth: expanded ? '428px' : '186px',
          transition: 'all var(--transition-med)',
          border: '1px solid var(--border-subtle)',
          borderTop: 'none',
        }}
      >
        <div
          onClick={() => {
            if (expanded && pendingList.length > 0) return;
            void window.agentwatch?.setOverlayExpanded(!expanded);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            justifyContent: 'space-between',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {(snapshot?.settings.mascot.enabled ?? true) && (
              <Mascot
                mood={mascotMood}
                visible={snapshot?.overlayVisible ?? true}
                reduceMotion={reduceMotion}
                size={22}
              />
            )}
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background:
                  needsCount > 0
                    ? 'var(--status-needs-you)'
                    : workingCount > 0
                      ? 'var(--status-working)'
                      : 'var(--status-done)',
              }}
            />
            <span style={{ fontSize: 12, fontWeight: 600 }}>{snapshot?.appName ?? APP_NAME}</span>
            {!expanded && workingCount > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {workingCount} active
              </span>
            )}
          </div>
          {needsCount > 0 && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: '1px 7px',
                borderRadius: 'var(--radius-pill)',
                background: 'var(--status-needs-you-bg)',
                color: 'var(--status-needs-you)',
              }}
            >
              ! {needsCount}
            </span>
          )}
        </div>

        {expanded && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 6,
                padding: '6px 8px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                fontSize: 10.5,
              }}
            >
              <div>
                <div style={{ color: 'var(--text-muted)' }}>Claude 5h</div>
                <div style={{ fontWeight: 600 }}>{formatWindowChip(snapshot?.usage.claude_code)}</div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)' }}>Codex 5h</div>
                <div style={{ fontWeight: 600 }}>{formatWindowChip(snapshot?.usage.codex)}</div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)' }}>
                  {snapshot?.settings.featureFlags.showCost ? 'MTD Cost' : 'MTD Tokens'}
                </div>
                <div style={{ fontWeight: 600 }}>
                  {formatCompactTokens(snapshot?.analytics.totalTokens ?? 0)}
                </div>
              </div>
            </div>
            {snapshot?.permissionNotice && (
              <div
                style={{
                  fontSize: 11,
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--status-needs-you-bg)',
                  color: 'var(--status-needs-you)',
                  border: '1px solid var(--status-needs-you)',
                }}
              >
                {snapshot.permissionNotice}
              </div>
            )}

            {topPerm && (
              <div
                style={{
                  padding: 10,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-surface-elevated)',
                  border: '1px solid var(--status-needs-you)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--status-needs-you)' }}>
                    PERMISSION PENDING · {topPerm.toolName.toUpperCase()}
                  </span>
                  {pendingList.length > 1 && (
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      1 of {pendingList.length} queued
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    background: 'var(--bg-input)',
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-subtle)',
                    wordBreak: 'break-word',
                    maxHeight: 54,
                    overflowY: 'auto',
                  }}
                >
                  {topPerm.commandOrAction}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {topPerm.agent === 'claude_code' ? 'Claude Code' : 'Codex'} · {topPerm.folderName}
                </div>

                {topPerm.readOnlyInTerminal ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      Needs approval in terminal
                    </span>
                    <button
                      onClick={() => void window.agentwatch?.openTerminal(topPerm.sessionId)}
                      style={{
                        padding: '5px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 'var(--radius-sm)',
                        border: 'none',
                        background: 'var(--accent-primary)',
                        color: 'var(--text-on-accent)',
                        cursor: 'pointer',
                      }}
                    >
                      Open Terminal
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => void window.agentwatch?.resolvePermission(topPerm.requestId, 'deny', false)}
                      style={{
                        flex: 1,
                        padding: '6px 8px',
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-strong)',
                        background: 'var(--status-error-bg)',
                        color: 'var(--status-error)',
                        cursor: 'pointer',
                      }}
                      title={formatHotkeyLabel(snapshot?.settings.hotkeys.deny || 'Ctrl+N')}
                    >
                      Deny ({formatHotkeyLabel(snapshot?.settings.hotkeys.deny || 'Ctrl+N')})
                    </button>
                    <button
                      onClick={() => void window.agentwatch?.resolvePermission(topPerm.requestId, 'allow', false)}
                      style={{
                        flex: 1,
                        padding: '6px 8px',
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 'var(--radius-sm)',
                        border: 'none',
                        background: 'var(--accent-primary)',
                        color: 'var(--text-on-accent)',
                        cursor: 'pointer',
                      }}
                      title={formatHotkeyLabel(snapshot?.settings.hotkeys.allow || 'Ctrl+Y')}
                    >
                      Allow ({formatHotkeyLabel(snapshot?.settings.hotkeys.allow || 'Ctrl+Y')})
                    </button>
                    <button
                      onClick={() => void window.agentwatch?.resolvePermission(topPerm.requestId, 'allow', true)}
                      style={{
                        flex: 1.2,
                        padding: '6px 8px',
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-strong)',
                        background: 'var(--bg-surface)',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                      }}
                      title={formatHotkeyLabel(snapshot?.settings.hotkeys.alwaysAllow || 'Ctrl+Shift+Y')}
                    >
                      Always allow
                    </button>
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
              {sessions.length === 0 ? (
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    padding: '10px',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  No active agent sessions yet.
                </div>
              ) : (
                sessions.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>
                        {s.agent === 'claude_code' ? 'Claude Code' : 'Codex'} · {s.folderName}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 11, color: STATE_COLOR[s.state], fontWeight: 600 }}>
                          {STATE_LABEL[s.state]} · {formatRelativeTime(s.lastEventAt)}
                        </span>
                        <button
                          onClick={() => {
                            void window.agentwatch?.openTerminal(s.id).then((res) => {
                              if (!res.ok && res.message) {
                                setTerminalMsg(res.message);
                                setTimeout(() => setTerminalMsg(null), 4000);
                              }
                            });
                          }}
                          style={{
                            padding: '2px 6px',
                            fontSize: 10,
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-strong)',
                            background: 'var(--bg-surface-elevated)',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                          }}
                        >
                          Open Terminal
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.summary || (s.lastTool ? `Running ${s.lastTool}` : s.title)}
                    </div>
                  </div>
                ))
              )}
            </div>

            {terminalMsg && (
              <div style={{ fontSize: 11, color: 'var(--status-needs-you)' }}>{terminalMsg}</div>
            )}

            {devServers.length > 0 && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>
                  Dev Servers ({devServers.length})
                </div>
                {devServers.map((ds) => (
                  <div
                    key={ds.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11,
                    }}
                  >
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <strong>{ds.folderName}</strong> · {ds.commandShort} ·{' '}
                      <a
                        href={ds.url}
                        onClick={(e) => {
                          e.preventDefault();
                          void window.agentwatch?.openExternalLocalhost(ds.url);
                        }}
                        style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}
                      >
                        :{ds.port}
                      </a>
                    </div>
                    <button
                      onClick={() => void window.agentwatch?.stopDevServer(ds.pid, ds.trackedChild)}
                      style={{
                        padding: '2px 7px',
                        fontSize: 10.5,
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-strong)',
                        background: 'var(--status-error-bg)',
                        color: 'var(--status-error)',
                        cursor: 'pointer',
                      }}
                    >
                      Stop
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                onClick={() => void window.agentwatch?.openDashboard()}
                style={{
                  padding: '5px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-surface-elevated)',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                }}
              >
                Open Dashboard
              </button>
              {pendingList.length === 0 && (
                <button
                  onClick={() => void window.agentwatch?.setOverlayExpanded(false)}
                  style={{
                    padding: '5px 8px',
                    fontSize: 11,
                    borderRadius: 'var(--radius-sm)',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  Collapse
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
