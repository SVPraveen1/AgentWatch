import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, DailyTokenBucket, TokenAnalyticsReport } from '../../shared/types';
import type { AgentPaths } from '../adapters/pathResolver';
import { atomicWriteFileSync } from '../core/settingsStore';

export interface ParsedTokenRecord {
  ts: number;
  date: string; // YYYY-MM-DD local date
  agent: AgentId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

export interface CodexRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

export interface CodexRateLimitSnapshot {
  capturedAt: number;
  planType?: string;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

interface CachedFileState {
  mtimeMs: number;
  size: number;
  offset: number;
  agent: AgentId;
  activeModel?: string;
  seenIds?: string[];
  lastTotals?: {
    input: number;
    cached: number;
    output: number;
    reasoning: number;
  };
  records: ParsedTokenRecord[];
  latestCodexRateLimits?: CodexRateLimitSnapshot | null;
}

interface CacheFilePayload {
  version: 1;
  files: Record<string, CachedFileState>;
}

const CHUNK_SIZE = 64 * 1024;

function toLocalDateKey(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function listJsonlFiles(rootDir: string, predicate: (name: string) => boolean): string[] {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const results: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && predicate(ent.name)) {
        results.push(full);
      }
    }
  }
  return results;
}

export class TokenAnalyticsEngine {
  private readonly cachePath: string;
  private cache: CacheFilePayload = { version: 1, files: {} };

  constructor(dataDir: string) {
    this.cachePath = path.join(dataDir, 'analytics-cache.json');
    this.loadCache();
  }

  refresh(paths: AgentPaths): {
    records: ParsedTokenRecord[];
    latestCodexRateLimits: CodexRateLimitSnapshot | null;
  } {
    const claudeFiles = listJsonlFiles(paths.claudeProjectsDir, (n) => n.endsWith('.jsonl'));
    const codexFiles = listJsonlFiles(
      paths.codexSessionsDir,
      (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
    );

    const activePaths = new Set<string>([...claudeFiles, ...codexFiles]);
    let dirty = false;

    for (const existingPath of Object.keys(this.cache.files)) {
      if (!activePaths.has(existingPath)) {
        delete this.cache.files[existingPath];
        dirty = true;
      }
    }

    for (const file of claudeFiles) {
      if (this.updateFileCache(file, 'claude_code')) dirty = true;
    }
    for (const file of codexFiles) {
      if (this.updateFileCache(file, 'codex')) dirty = true;
    }

    if (dirty) {
      this.saveCache();
    }

    const records: ParsedTokenRecord[] = [];
    let latestCodexRateLimits: CodexRateLimitSnapshot | null = null;
    for (const entry of Object.values(this.cache.files)) {
      records.push(...entry.records);
      if (
        entry.latestCodexRateLimits &&
        (!latestCodexRateLimits ||
          entry.latestCodexRateLimits.capturedAt > latestCodexRateLimits.capturedAt)
      ) {
        latestCodexRateLimits = entry.latestCodexRateLimits;
      }
    }

    return { records, latestCodexRateLimits };
  }

  buildReport(
    paths: AgentPaths,
    range: TokenAnalyticsReport['range'] = 'this_month',
    nowMs = Date.now(),
  ): TokenAnalyticsReport {
    const { records } = this.refresh(paths);
    const { startDate, endDate, dateKeys, daysElapsedInMonth, totalDaysInMonth } =
      computeRangeWindow(range, nowMs);

    const byDate = new Map<string, DailyTokenBucket>();
    for (const key of dateKeys) {
      byDate.set(key, {
        date: key,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        byAgent: { claude_code: 0, codex: 0 },
        byModel: {},
      });
    }

    const byAgent: TokenAnalyticsReport['byAgent'] = {
      claude_code: { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
      codex: { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
    };

    const byModelMap = new Map<
      string,
      {
        model: string;
        agent: AgentId;
        inputTokens: number;
        outputTokens: number;
        cacheCreateTokens: number;
        cacheReadTokens: number;
        totalTokens: number;
      }
    >();

    let totalTokens = 0;

    for (const rec of records) {
      if (rec.date < startDate || rec.date > endDate) continue;
      const bucket = byDate.get(rec.date);
      const recTotal =
        rec.inputTokens + rec.outputTokens + rec.cacheCreateTokens + rec.cacheReadTokens;
      if (recTotal <= 0) continue;

      totalTokens += recTotal;
      if (bucket) {
        bucket.inputTokens += rec.inputTokens;
        bucket.outputTokens += rec.outputTokens;
        bucket.cacheCreateTokens += rec.cacheCreateTokens;
        bucket.cacheReadTokens += rec.cacheReadTokens;
        bucket.reasoningTokens += rec.reasoningTokens;
        bucket.totalTokens += recTotal;
        bucket.byAgent[rec.agent] += recTotal;
        bucket.byModel[rec.model] = (bucket.byModel[rec.model] || 0) + recTotal;
      }

      const ag = byAgent[rec.agent];
      ag.inputTokens += rec.inputTokens;
      ag.outputTokens += rec.outputTokens;
      ag.cacheCreateTokens += rec.cacheCreateTokens;
      ag.cacheReadTokens += rec.cacheReadTokens;
      ag.totalTokens += recTotal;

      const modelKey = `${rec.agent}::${rec.model}`;
      const existingModel = byModelMap.get(modelKey) ?? {
        model: rec.model,
        agent: rec.agent,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
      };
      existingModel.inputTokens += rec.inputTokens;
      existingModel.outputTokens += rec.outputTokens;
      existingModel.cacheCreateTokens += rec.cacheCreateTokens;
      existingModel.cacheReadTokens += rec.cacheReadTokens;
      existingModel.totalTokens += recTotal;
      byModelMap.set(modelKey, existingModel);
    }

    const dailyBuckets = Array.from(byDate.values());
    const activeDays = dailyBuckets.filter((b) => b.totalTokens > 0).length;

    let forecastEndOfMonthTokens: number | null = null;
    if (range === 'this_month' && daysElapsedInMonth > 0 && totalTokens > 0) {
      forecastEndOfMonthTokens = Math.round((totalTokens / daysElapsedInMonth) * totalDaysInMonth);
    }

    return {
      range,
      rangeStart: startDate,
      rangeEnd: endDate,
      totalTokens,
      activeDays,
      totalDaysInRange: dailyBuckets.length,
      byAgent,
      byModel: Array.from(byModelMap.values()).sort((a, b) => b.totalTokens - a.totalTokens),
      dailyBuckets,
      forecastEndOfMonthTokens,
      forecastLabel: 'estimated',
      lastUpdatedAt: nowMs,
    };
  }

  getRollingWindowTokens(
    paths: AgentPaths,
    agent: AgentId,
    windowMinutes: number,
    nowMs = Date.now(),
  ): { tokensUsed: number; oldestRecordTs: number | null } {
    const { records } = this.refresh(paths);
    const cutoff = nowMs - windowMinutes * 60_000;
    let tokensUsed = 0;
    let oldestRecordTs: number | null = null;
    for (const r of records) {
      if (r.agent !== agent || r.ts < cutoff || r.ts > nowMs) continue;
      const tot = r.inputTokens + r.outputTokens + r.cacheCreateTokens + r.cacheReadTokens;
      if (tot <= 0) continue;
      tokensUsed += tot;
      if (oldestRecordTs === null || r.ts < oldestRecordTs) {
        oldestRecordTs = r.ts;
      }
    }
    return { tokensUsed, oldestRecordTs };
  }

  private updateFileCache(filePath: string, agent: AgentId): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return false;
    }

    let state = this.cache.files[filePath];
    if (state && state.mtimeMs === stat.mtimeMs && state.size === stat.size) {
      return false;
    }

    if (!state || stat.size < state.offset) {
      state = {
        mtimeMs: 0,
        size: 0,
        offset: 0,
        agent,
        seenIds: [],
        records: [],
      };
    }

    const seenSet = new Set<string>(state.seenIds ?? []);
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      let pos = state.offset;
      let leftover = '';
      while (pos < stat.size) {
        const toRead = Math.min(CHUNK_SIZE, stat.size - pos);
        const buf = Buffer.alloc(toRead);
        const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;

        const text = leftover + buf.subarray(0, bytesRead).toString('utf8');
        const lines = text.split(/\r?\n/);
        leftover = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          this.consumeLine(line, state, seenSet);
        }
      }

      // Advance offset only to last complete newline so partial writes finish on next poll.
      const incompleteBytes = Buffer.byteLength(leftover, 'utf8');
      state.offset = Math.max(state.offset, pos - incompleteBytes);
      state.mtimeMs = stat.mtimeMs;
      state.size = stat.size;
      state.seenIds = Array.from(seenSet).slice(-5000);
      this.cache.files[filePath] = state;
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private consumeLine(rawLine: string, state: CachedFileState, seenSet: Set<string>): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      return;
    }

    const ts = parseTimestamp(obj.timestamp) ?? Date.now();
    const date = toLocalDateKey(ts);

    if (state.agent === 'claude_code') {
      if (obj.type !== 'assistant' || !obj.message || typeof obj.message !== 'object') return;
      const msg = obj.message as Record<string, unknown>;
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (!usage || typeof usage !== 'object') return;

      const dedupeId = String(msg.id || obj.requestId || obj.uuid || '');
      if (dedupeId) {
        if (seenSet.has(dedupeId)) return;
        seenSet.add(dedupeId);
      }

      const inputTokens = toNonNegInt(usage.input_tokens);
      const outputTokens = toNonNegInt(usage.output_tokens);
      const cacheCreateTokens = toNonNegInt(usage.cache_creation_input_tokens);
      const cacheReadTokens = toNonNegInt(usage.cache_read_input_tokens);
      if (inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens === 0) return;

      state.records.push({
        ts,
        date,
        agent: 'claude_code',
        model: typeof msg.model === 'string' && msg.model ? msg.model : 'claude',
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        reasoningTokens: 0,
      });
      return;
    }

    // Codex rollout-*.jsonl format
    const payload = (obj.payload && typeof obj.payload === 'object' ? obj.payload : {}) as Record<
      string,
      unknown
    >;

    if (obj.type === 'session_meta' || obj.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) {
        state.activeModel = payload.model;
      }
      return;
    }

    if (obj.type === 'event_msg' && payload.type === 'token_count') {
      if (payload.rate_limits && typeof payload.rate_limits === 'object') {
        const rl = payload.rate_limits as Record<string, unknown>;
        state.latestCodexRateLimits = {
          capturedAt: ts,
          planType: typeof rl.plan_type === 'string' ? rl.plan_type : undefined,
          primary: (rl.primary as CodexRateLimitWindow | null) ?? null,
          secondary: (rl.secondary as CodexRateLimitWindow | null) ?? null,
        };
      }

      const info = payload.info as Record<string, unknown> | undefined;
      if (!info || typeof info !== 'object') return;

      const totalUsage = info.total_token_usage as Record<string, unknown> | undefined;
      const lastUsage = info.last_token_usage as Record<string, unknown> | undefined;

      let inputDelta = 0;
      let cachedDelta = 0;
      let outputDelta = 0;
      let reasoningDelta = 0;

      if (totalUsage && typeof totalUsage === 'object') {
        const curInput = toNonNegInt(totalUsage.input_tokens);
        const curCached = toNonNegInt(totalUsage.cached_input_tokens);
        const curOutput = toNonNegInt(totalUsage.output_tokens);
        const curReasoning = toNonNegInt(totalUsage.reasoning_output_tokens);
        const prev = state.lastTotals ?? { input: 0, cached: 0, output: 0, reasoning: 0 };

        inputDelta = Math.max(0, curInput - prev.input);
        cachedDelta = Math.max(0, curCached - prev.cached);
        outputDelta = Math.max(0, curOutput - prev.output);
        reasoningDelta = Math.max(0, curReasoning - prev.reasoning);

        state.lastTotals = {
          input: Math.max(prev.input, curInput),
          cached: Math.max(prev.cached, curCached),
          output: Math.max(prev.output, curOutput),
          reasoning: Math.max(prev.reasoning, curReasoning),
        };
      } else if (lastUsage && typeof lastUsage === 'object') {
        inputDelta = toNonNegInt(lastUsage.input_tokens);
        cachedDelta = toNonNegInt(lastUsage.cached_input_tokens);
        outputDelta = toNonNegInt(lastUsage.output_tokens);
        reasoningDelta = toNonNegInt(lastUsage.reasoning_output_tokens);
      }

      if (inputDelta + cachedDelta + outputDelta === 0) return;

      // In Codex total_token_usage, input_tokens typically includes cached_input_tokens; avoid double counting.
      const nonCachedInput = Math.max(0, inputDelta - cachedDelta);

      state.records.push({
        ts,
        date,
        agent: 'codex',
        model: state.activeModel || 'codex',
        inputTokens: nonCachedInput,
        outputTokens: outputDelta,
        cacheCreateTokens: 0,
        cacheReadTokens: cachedDelta,
        reasoningTokens: reasoningDelta,
      });
    }
  }

  private loadCache(): void {
    try {
      if (!fs.existsSync(this.cachePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as CacheFilePayload;
      if (parsed && parsed.version === 1 && parsed.files) {
        this.cache = parsed;
      }
    } catch {
      this.cache = { version: 1, files: {} };
    }
  }

  private saveCache(): void {
    atomicWriteFileSync(this.cachePath, JSON.stringify(this.cache));
  }
}

function toNonNegInt(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function parseTimestamp(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val > 1e12 ? val : val * 1000;
  }
  if (typeof val === 'string' && val.trim()) {
    const ms = Date.parse(val);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function computeRangeWindow(
  range: TokenAnalyticsReport['range'],
  nowMs: number,
): {
  startDate: string;
  endDate: string;
  dateKeys: string[];
  daysElapsedInMonth: number;
  totalDaysInMonth: number;
} {
  const now = new Date(nowMs);
  let start: Date;
  let end: Date;

  if (range === 'last_month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (range === 'last_30_days') {
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start = new Date(end.getTime() - 29 * 86_400_000);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }

  const dateKeys: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (cursor <= end) {
    dateKeys.push(toLocalDateKey(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }

  const totalDaysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsedInMonth = now.getDate();

  return {
    startDate: dateKeys[0],
    endDate: dateKeys[dateKeys.length - 1],
    dateKeys,
    daysElapsedInMonth,
    totalDaysInMonth,
  };
}
