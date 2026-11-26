import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgentPaths } from '../../src/main/adapters/pathResolver';
import { TokenAnalyticsEngine } from '../../src/main/analytics/tokenAnalytics';
import { ClaudeUsageProvider, CodexUsageProvider } from '../../src/main/analytics/usageProviders';
import { createDefaultSettings } from '../../src/main/core/settingsStore';

describe('M5 Token analytics, caching, and UsageProviders', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('parses Claude and Codex JSONL incrementally without double counting or crashing on malformed lines', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ana-'));
    dirs.push(tmp);
    const dataDir = path.join(tmp, 'data');
    const homeDir = path.join(tmp, 'home');
    const paths = resolveAgentPaths({ homeDir, env: {} });

    const claudeProj = path.join(paths.claudeProjectsDir, 'C--Users-dev-billing');
    const codexDay = path.join(paths.codexSessionsDir, '2026', '11', '26');
    fs.mkdirSync(claudeProj, { recursive: true });
    fs.mkdirSync(codexDay, { recursive: true });

    const claudeFile = path.join(claudeProj, 's1.jsonl');
    const codexFile = path.join(codexDay, 'rollout-2026-11-26T08-00-00-cx1.jsonl');
    fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'claude-transcript.jsonl'), claudeFile);
    fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'codex-rollout.jsonl'), codexFile);

    const engine = new TokenAnalyticsEngine(dataDir);
    const nowMs = Date.parse('2026-11-26T10:00:00.000Z');
    const report = engine.buildReport(paths, 'this_month', nowMs);

    // Claude: msg-1 (1200+300+500+2000 = 4000, deduplicated) + msg-2 (800+200+1000 = 2000) = 6000
    expect(report.byAgent.claude_code.totalTokens).toBe(6000);
    // Codex: cumulative total_token_usage reached input=1500 (cached=400 -> nonCached=1100), output=400 => 1900 (duplicate line ignored)
    expect(report.byAgent.codex.totalTokens).toBe(1900);
    expect(report.totalTokens).toBe(7900);
    expect(report.activeDays).toBe(1);
    expect(report.forecastEndOfMonthTokens).toBeGreaterThan(7900);

    // Append a new Claude message and verify incremental cache picks up ONLY the new entry
    fs.appendFileSync(
      claudeFile,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-26T09:30:00.000Z',
        message: {
          id: 'msg-3',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }) + '\n',
    );
    const engineReloaded = new TokenAnalyticsEngine(dataDir);
    const report2 = engineReloaded.buildReport(paths, 'this_month', nowMs);
    expect(report2.byAgent.claude_code.totalTokens).toBe(6150);
  });

  it('provides authoritative Codex/Claude rate limits when cached and graceful estimated fallback otherwise', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-usage-'));
    dirs.push(tmp);
    const dataDir = path.join(tmp, 'data');
    const homeDir = path.join(tmp, 'home');
    const paths = resolveAgentPaths({ homeDir, env: {} });
    const codexDay = path.join(paths.codexSessionsDir, '2026', '11', '26');
    const claudeProj = path.join(paths.claudeProjectsDir, 'C--Users-dev-billing');
    fs.mkdirSync(codexDay, { recursive: true });
    fs.mkdirSync(claudeProj, { recursive: true });

    fs.copyFileSync(
      path.join(__dirname, '..', 'fixtures', 'codex-rollout.jsonl'),
      path.join(codexDay, 'rollout-1.jsonl'),
    );
    fs.copyFileSync(
      path.join(__dirname, '..', 'fixtures', 'claude-transcript.jsonl'),
      path.join(claudeProj, 's1.jsonl'),
    );

    const engine = new TokenAnalyticsEngine(dataDir);
    const settings = createDefaultSettings();
    const nowMs = Date.parse('2026-11-26T09:30:00.000Z');

    const codexUsage = new CodexUsageProvider(engine).getUsage(paths, settings, nowMs);
    expect(codexUsage.confidence).toBe('authoritative');
    expect(codexUsage.fiveHour?.usedPercent).toBe(18.5);
    expect(codexUsage.fiveHour?.remainingPercent).toBe(81.5);
    expect(codexUsage.weekly?.usedPercent).toBe(42);

    // Claude without StatusLine cache -> estimated rolling tokens, null % unless manual limit set
    const claudeEst = new ClaudeUsageProvider(dataDir, engine).getUsage(paths, settings, nowMs);
    expect(claudeEst.confidence).toBe('estimated');
    expect(claudeEst.fiveHour?.estimated).toBe(true);
    expect(claudeEst.fiveHour?.tokensUsed).toBe(6000);
    expect(claudeEst.fiveHour?.usedPercent).toBeNull();

    // With manual plan limit -> computes estimated percent
    settings.usage.manualClaudeFiveHourTokens = 24000;
    const claudeManual = new ClaudeUsageProvider(dataDir, engine).getUsage(paths, settings, nowMs);
    expect(claudeManual.fiveHour?.usedPercent).toBe(25);
    expect(claudeManual.fiveHour?.remainingPercent).toBe(75);
  });
});
