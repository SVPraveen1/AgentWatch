import React from 'react';
import type {
  AgentId,
  AppSnapshot,
  TokenAnalyticsReport,
  UsageProviderResult,
  UsageWindowMetric,
} from '../../shared/types';

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function formatCountdown(resetsAt: number | null): string {
  if (!resetsAt) return '—';
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 0) return 'resetting soon';
  const totalMins = Math.floor(diffMs / 60_000);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs >= 24) {
    const days = Math.floor(hrs / 24);
    const remHrs = hrs % 24;
    return `${days}d ${remHrs}h`;
  }
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
}

function renderWindow(label: string, metric?: UsageWindowMetric): React.ReactNode {
  if (!metric) {
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
        <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
        <span>—</span>
      </div>
    );
  }
  const pctText =
    metric.remainingPercent !== null
      ? `${metric.remainingPercent.toFixed(0)}% left (${metric.usedPercent?.toFixed(0)}% used)`
      : typeof metric.tokensUsed === 'number'
        ? `${formatTokens(metric.tokensUsed)} tokens`
        : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
        <span style={{ color: 'var(--text-secondary)' }}>
          {label} {metric.estimated ? '(estimated)' : ''}
        </span>
        <strong>{pctText}</strong>
      </div>
      {metric.usedPercent !== null && (
        <div
          style={{
            height: 6,
            borderRadius: 'var(--radius-pill)',
            background: 'var(--bg-surface-elevated)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.min(100, Math.max(0, metric.usedPercent))}%`,
              height: '100%',
              background: metric.usedPercent > 85 ? 'var(--status-needs-you)' : 'var(--accent-primary)',
            }}
          />
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Resets in {formatCountdown(metric.resetsAt)}
        {metric.estimated ? ' (estimated)' : ''}
      </div>
    </div>
  );
}

function getHeatBucket(tokens: number, maxTokens: number): number {
  if (tokens <= 0 || maxTokens <= 0) return 0;
  const ratio = tokens / maxTokens;
  if (ratio < 0.25) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.75) return 3;
  return 4;
}

export const UsagePanel: React.FC<{ snapshot: AppSnapshot | null }> = ({ snapshot }) => {
  const analytics = snapshot?.analytics;
  const usageClaude: UsageProviderResult | undefined = snapshot?.usage.claude_code;
  const usageCodex: UsageProviderResult | undefined = snapshot?.usage.codex;
  const maxDayTokens = Math.max(1, ...(analytics?.dailyBuckets.map((d) => d.totalTokens) ?? [0]));

  const setRange = (range: TokenAnalyticsReport['range']) => {
    void window.agentwatch?.setAnalyticsRange(range);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Usage & Token Analytics</h1>
        <div style={{ display: 'flex', gap: 6 }}>
          {([
            ['this_month', 'This month'],
            ['last_month', 'Last month'],
            ['last_30_days', 'Last 30 days'],
          ] as Array<[TokenAnalyticsReport['range'], string]>).map(([r, label]) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                padding: '6px 10px',
                fontSize: 12,
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-strong)',
                background: analytics?.range === r ? 'var(--accent-primary)' : 'var(--bg-surface)',
                color: analytics?.range === r ? 'var(--text-on-accent)' : 'var(--text-primary)',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => void window.agentwatch?.refreshUsageAndAnalytics()}
            style={{
              padding: '6px 10px',
              fontSize: 12,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-strong)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Quota windows */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 12 }}>
        {([
          ['Claude Code', usageClaude],
          ['Codex', usageCodex],
        ] as Array<[string, UsageProviderResult | undefined]>).map(([title, res]) => (
          <div
            key={title}
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
              <strong style={{ fontSize: 15 }}>{title} Limits</strong>
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-pill)',
                  background: 'var(--bg-surface-elevated)',
                  color: 'var(--text-secondary)',
                }}
              >
                {res?.confidence === 'authoritative'
                  ? 'live snapshot'
                  : res?.confidence === 'estimated'
                    ? 'estimated'
                    : 'unavailable'}
              </span>
            </div>
            {renderWindow('5-hour window', res?.fiveHour)}
            {renderWindow('Weekly window', res?.weekly)}
            {res?.note && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{res.note}</div>}
          </div>
        ))}
      </div>

      {/* Summary metrics (dollars hidden while showCost is false) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: 14,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Total Tokens</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
            {formatTokens(analytics?.totalTokens ?? 0)}
          </div>
        </div>
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: 14,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Active Days</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
            {analytics ? `${analytics.activeDays}/${analytics.totalDaysInRange}` : '0/30'}
          </div>
        </div>
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: 14,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Month-End Token Forecast ({analytics?.forecastLabel ?? 'estimated'})
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
            {analytics?.forecastEndOfMonthTokens !== null && analytics?.forecastEndOfMonthTokens !== undefined
              ? formatTokens(analytics.forecastEndOfMonthTokens)
              : '—'}
          </div>
        </div>
      </div>

      {/* Day-by-day calendar heatmap */}
      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <strong style={{ fontSize: 14 }}>Daily Token Heatmap</strong>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {analytics?.rangeStart} to {analytics?.rangeEnd}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(28px, 1fr))', gap: 5 }}>
          {(analytics?.dailyBuckets ?? []).map((b) => {
            const level = getHeatBucket(b.totalTokens, maxDayTokens);
            return (
              <div
                key={b.date}
                title={`${b.date}: ${formatTokens(b.totalTokens)} tokens`}
                style={{
                  height: 28,
                  borderRadius: 'var(--radius-sm)',
                  background: `var(--heat-${level})`,
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'var(--font-mono)',
                  color: level >= 2 ? '#ffffff' : 'var(--text-secondary)',
                }}
              >
                {b.date.slice(-2)}
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-agent split & per-model breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 12 }}>
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: 16,
          }}
        >
          <strong style={{ fontSize: 14 }}>Per-Agent Split</strong>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(['claude_code', 'codex'] as AgentId[]).map((ag) => {
              const row = analytics?.byAgent[ag];
              return (
                <div key={ag} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                  <span>{ag === 'claude_code' ? 'Claude Code' : 'Codex'}</span>
                  <strong>{formatTokens(row?.totalTokens ?? 0)} tok</strong>
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: 16,
          }}
        >
          <strong style={{ fontSize: 14 }}>Per-Model Breakdown</strong>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(analytics?.byModel ?? []).length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No token records in range.</span>
            ) : (
              analytics!.byModel.slice(0, 8).map((m) => (
                <div key={`${m.agent}-${m.model}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span>{m.model}</span>
                  <strong>{formatTokens(m.totalTokens)}</strong>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Manual limit calibration + opt-in statusLine bridge */}
      <div
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
        <strong style={{ fontSize: 14 }}>Quota Calibration (Optional)</strong>
        <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={snapshot?.settings.usage.enableClaudeStatusLineBridge ?? false}
            onChange={(e) =>
              void window.agentwatch?.updateSettings({
                usage: { enableClaudeStatusLineBridge: e.target.checked },
              })
            }
          />
          Capture Claude Code live 5h/7d rate_limits via optional StatusLine bridge (re-connect Claude Code after toggling)
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8 }}>
          <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            Claude 5h token limit (for estimated %)
            <input
              type="number"
              placeholder="e.g. 500000"
              value={snapshot?.settings.usage.manualClaudeFiveHourTokens ?? ''}
              onChange={(e) =>
                void window.agentwatch?.updateSettings({
                  usage: {
                    manualClaudeFiveHourTokens: e.target.value ? Number(e.target.value) : null,
                  },
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
          </label>
          <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            Codex 5h token limit (for estimated %)
            <input
              type="number"
              placeholder="e.g. 500000"
              value={snapshot?.settings.usage.manualCodexFiveHourTokens ?? ''}
              onChange={(e) =>
                void window.agentwatch?.updateSettings({
                  usage: {
                    manualCodexFiveHourTokens: e.target.value ? Number(e.target.value) : null,
                  },
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
          </label>
        </div>
      </div>
    </div>
  );
};
