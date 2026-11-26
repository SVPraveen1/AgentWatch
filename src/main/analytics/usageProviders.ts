import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, AppSettings, UsageProviderResult, UsageWindowMetric } from '../../shared/types';
import type { AgentPaths } from '../adapters/pathResolver';
import type { TokenAnalyticsEngine } from './tokenAnalytics';

export interface UsageProvider {
  readonly agent: AgentId;
  getUsage(paths: AgentPaths, settings: AppSettings, nowMs?: number): UsageProviderResult;
}

interface ClaudeStatusLineCache {
  capturedAt: number;
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
}

function buildEstimatedWindow(
  tokensUsed: number,
  oldestTs: number | null,
  manualLimit: number | null,
  windowMinutes: number,
  nowMs: number,
): UsageWindowMetric | undefined {
  if (tokensUsed <= 0 && !manualLimit) {
    return undefined;
  }
  const usedPercent =
    manualLimit && manualLimit > 0
      ? Math.min(100, Math.round((tokensUsed / manualLimit) * 1000) / 10)
      : null;
  const remainingPercent = usedPercent !== null ? Math.max(0, Math.round((100 - usedPercent) * 10) / 10) : null;
  const resetsAt = oldestTs ? oldestTs + windowMinutes * 60_000 : nowMs + windowMinutes * 60_000;
  return {
    usedPercent,
    remainingPercent,
    resetsAt,
    tokensUsed,
    tokenLimit: manualLimit,
    windowMinutes,
    estimated: true,
  };
}

function normalizeResetEpochMs(resetsAt?: number): number | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  return resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
}

export class ClaudeUsageProvider implements UsageProvider {
  readonly agent = 'claude_code' as const;

  constructor(
    private readonly dataDir: string,
    private readonly analytics: TokenAnalyticsEngine,
  ) {}

  getUsage(paths: AgentPaths, settings: AppSettings, nowMs = Date.now()): UsageProviderResult {
    const cacheFile = path.join(this.dataDir, 'claude-ratelimits.json');
    if (fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as ClaudeStatusLineCache;
        const rl = cached.rate_limits;
        const fiveReset = normalizeResetEpochMs(rl?.five_hour?.resets_at);
        const weekReset = normalizeResetEpochMs(rl?.seven_day?.resets_at);
        const freshFive =
          typeof rl?.five_hour?.used_percentage === 'number' &&
          (!fiveReset || fiveReset > nowMs);
        const freshWeek =
          typeof rl?.seven_day?.used_percentage === 'number' &&
          (!weekReset || weekReset > nowMs);

        if (freshFive || freshWeek) {
          const fivePct = freshFive ? rl!.five_hour!.used_percentage! : null;
          const weekPct = freshWeek ? rl!.seven_day!.used_percentage! : null;
          return {
            agent: this.agent,
            fiveHour:
              fivePct !== null
                ? {
                    usedPercent: fivePct,
                    remainingPercent: Math.max(0, Math.round((100 - fivePct) * 10) / 10),
                    resetsAt: fiveReset,
                    windowMinutes: 300,
                    estimated: false,
                  }
                : undefined,
            weekly:
              weekPct !== null
                ? {
                    usedPercent: weekPct,
                    remainingPercent: Math.max(0, Math.round((100 - weekPct) * 10) / 10),
                    resetsAt: weekReset,
                    windowMinutes: 10080,
                    estimated: false,
                  }
                : undefined,
            source: 'claude-statusline',
            confidence: 'authoritative',
          };
        }
      } catch {
        // Fall through to local transcript estimate.
      }
    }

    const roll5h = this.analytics.getRollingWindowTokens(paths, 'claude_code', 300, nowMs);
    const roll7d = this.analytics.getRollingWindowTokens(paths, 'claude_code', 10080, nowMs);

    const fiveHour = buildEstimatedWindow(
      roll5h.tokensUsed,
      roll5h.oldestRecordTs,
      settings.usage.manualClaudeFiveHourTokens,
      300,
      nowMs,
    );
    const weekly = buildEstimatedWindow(
      roll7d.tokensUsed,
      roll7d.oldestRecordTs,
      settings.usage.manualClaudeWeeklyTokens,
      10080,
      nowMs,
    );

    if (!fiveHour && !weekly) {
      return {
        agent: this.agent,
        source: 'local-transcripts',
        confidence: 'unavailable',
        note: 'No Claude Code rate-limit snapshot or recent rolling tokens yet.',
      };
    }

    return {
      agent: this.agent,
      fiveHour,
      weekly,
      source: 'local-transcripts',
      confidence: 'estimated',
      note: 'Estimated from local Claude Code JSONL transcripts (set manual plan limit or enable StatusLine bridge for %)',
    };
  }
}

export class CodexUsageProvider implements UsageProvider {
  readonly agent = 'codex' as const;

  constructor(private readonly analytics: TokenAnalyticsEngine) {}

  getUsage(paths: AgentPaths, settings: AppSettings, nowMs = Date.now()): UsageProviderResult {
    const { latestCodexRateLimits } = this.analytics.refresh(paths);
    if (latestCodexRateLimits) {
      const p = latestCodexRateLimits.primary;
      const s = latestCodexRateLimits.secondary;
      const pReset = normalizeResetEpochMs(p?.resets_at);
      const sReset = normalizeResetEpochMs(s?.resets_at);

      const pValid = typeof p?.used_percent === 'number' && (!pReset || pReset > nowMs);
      const sValid = typeof s?.used_percent === 'number' && (!sReset || sReset > nowMs);

      if (pValid || sValid) {
        return {
          agent: this.agent,
          fiveHour: pValid
            ? {
                usedPercent: p!.used_percent!,
                remainingPercent: Math.max(0, Math.round((100 - p!.used_percent!) * 10) / 10),
                resetsAt: pReset,
                windowMinutes: p?.window_minutes ?? 300,
                estimated: false,
              }
            : undefined,
          weekly: sValid
            ? {
                usedPercent: s!.used_percent!,
                remainingPercent: Math.max(0, Math.round((100 - s!.used_percent!) * 10) / 10),
                resetsAt: sReset,
                windowMinutes: s?.window_minutes ?? 10080,
                estimated: false,
              }
            : undefined,
          source: 'codex-rollout-logs',
          confidence: 'authoritative',
        };
      }
    }

    const roll5h = this.analytics.getRollingWindowTokens(paths, 'codex', 300, nowMs);
    const roll7d = this.analytics.getRollingWindowTokens(paths, 'codex', 10080, nowMs);

    const fiveHour = buildEstimatedWindow(
      roll5h.tokensUsed,
      roll5h.oldestRecordTs,
      settings.usage.manualCodexFiveHourTokens,
      300,
      nowMs,
    );
    const weekly = buildEstimatedWindow(
      roll7d.tokensUsed,
      roll7d.oldestRecordTs,
      settings.usage.manualCodexWeeklyTokens,
      10080,
      nowMs,
    );

    if (!fiveHour && !weekly) {
      return {
        agent: this.agent,
        source: 'codex-rollout-logs',
        confidence: 'unavailable',
        note: 'No Codex rate-limit snapshot or recent rolling tokens yet.',
      };
    }

    return {
      agent: this.agent,
      fiveHour,
      weekly,
      source: 'codex-rollout-logs',
      confidence: 'estimated',
      note: 'Estimated from local Codex rollout logs (rate_limits snapshot unavailable or expired).',
    };
  }
}
