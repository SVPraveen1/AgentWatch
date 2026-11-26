"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenAnalyticsEngine = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const settingsStore_1 = require("../core/settingsStore");
const CHUNK_SIZE = 64 * 1024;
function toLocalDateKey(tsMs) {
    const d = new Date(tsMs);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function listJsonlFiles(rootDir, predicate) {
    if (!rootDir || !node_fs_1.default.existsSync(rootDir))
        return [];
    const results = [];
    const stack = [rootDir];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const ent of entries) {
            const full = node_path_1.default.join(dir, ent.name);
            if (ent.isDirectory()) {
                stack.push(full);
            }
            else if (ent.isFile() && predicate(ent.name)) {
                results.push(full);
            }
        }
    }
    return results;
}
class TokenAnalyticsEngine {
    cachePath;
    cache = { version: 1, files: {} };
    constructor(dataDir) {
        this.cachePath = node_path_1.default.join(dataDir, 'analytics-cache.json');
        this.loadCache();
    }
    refresh(paths) {
        const claudeFiles = listJsonlFiles(paths.claudeProjectsDir, (n) => n.endsWith('.jsonl'));
        const codexFiles = listJsonlFiles(paths.codexSessionsDir, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
        const activePaths = new Set([...claudeFiles, ...codexFiles]);
        let dirty = false;
        for (const existingPath of Object.keys(this.cache.files)) {
            if (!activePaths.has(existingPath)) {
                delete this.cache.files[existingPath];
                dirty = true;
            }
        }
        for (const file of claudeFiles) {
            if (this.updateFileCache(file, 'claude_code'))
                dirty = true;
        }
        for (const file of codexFiles) {
            if (this.updateFileCache(file, 'codex'))
                dirty = true;
        }
        if (dirty) {
            this.saveCache();
        }
        const records = [];
        let latestCodexRateLimits = null;
        for (const entry of Object.values(this.cache.files)) {
            records.push(...entry.records);
            if (entry.latestCodexRateLimits &&
                (!latestCodexRateLimits ||
                    entry.latestCodexRateLimits.capturedAt > latestCodexRateLimits.capturedAt)) {
                latestCodexRateLimits = entry.latestCodexRateLimits;
            }
        }
        return { records, latestCodexRateLimits };
    }
    buildReport(paths, range = 'this_month', nowMs = Date.now()) {
        const { records } = this.refresh(paths);
        const { startDate, endDate, dateKeys, daysElapsedInMonth, totalDaysInMonth } = computeRangeWindow(range, nowMs);
        const byDate = new Map();
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
        const byAgent = {
            claude_code: { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
            codex: { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
        };
        const byModelMap = new Map();
        let totalTokens = 0;
        for (const rec of records) {
            if (rec.date < startDate || rec.date > endDate)
                continue;
            const bucket = byDate.get(rec.date);
            const recTotal = rec.inputTokens + rec.outputTokens + rec.cacheCreateTokens + rec.cacheReadTokens;
            if (recTotal <= 0)
                continue;
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
        let forecastEndOfMonthTokens = null;
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
    getRollingWindowTokens(paths, agent, windowMinutes, nowMs = Date.now()) {
        const { records } = this.refresh(paths);
        const cutoff = nowMs - windowMinutes * 60_000;
        let tokensUsed = 0;
        let oldestRecordTs = null;
        for (const r of records) {
            if (r.agent !== agent || r.ts < cutoff || r.ts > nowMs)
                continue;
            const tot = r.inputTokens + r.outputTokens + r.cacheCreateTokens + r.cacheReadTokens;
            if (tot <= 0)
                continue;
            tokensUsed += tot;
            if (oldestRecordTs === null || r.ts < oldestRecordTs) {
                oldestRecordTs = r.ts;
            }
        }
        return { tokensUsed, oldestRecordTs };
    }
    updateFileCache(filePath, agent) {
        let stat;
        try {
            stat = node_fs_1.default.statSync(filePath);
        }
        catch {
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
        const seenSet = new Set(state.seenIds ?? []);
        let fd;
        try {
            fd = node_fs_1.default.openSync(filePath, 'r');
            let pos = state.offset;
            let leftover = '';
            while (pos < stat.size) {
                const toRead = Math.min(CHUNK_SIZE, stat.size - pos);
                const buf = Buffer.alloc(toRead);
                const bytesRead = node_fs_1.default.readSync(fd, buf, 0, toRead, pos);
                if (bytesRead <= 0)
                    break;
                pos += bytesRead;
                const text = leftover + buf.subarray(0, bytesRead).toString('utf8');
                const lines = text.split(/\r?\n/);
                leftover = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.trim())
                        continue;
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
        }
        catch {
            return false;
        }
        finally {
            if (fd !== undefined)
                node_fs_1.default.closeSync(fd);
        }
    }
    consumeLine(rawLine, state, seenSet) {
        let obj;
        try {
            obj = JSON.parse(rawLine);
        }
        catch {
            return;
        }
        const ts = parseTimestamp(obj.timestamp) ?? Date.now();
        const date = toLocalDateKey(ts);
        if (state.agent === 'claude_code') {
            if (obj.type !== 'assistant' || !obj.message || typeof obj.message !== 'object')
                return;
            const msg = obj.message;
            const usage = msg.usage;
            if (!usage || typeof usage !== 'object')
                return;
            const dedupeId = String(msg.id || obj.requestId || obj.uuid || '');
            if (dedupeId) {
                if (seenSet.has(dedupeId))
                    return;
                seenSet.add(dedupeId);
            }
            const inputTokens = toNonNegInt(usage.input_tokens);
            const outputTokens = toNonNegInt(usage.output_tokens);
            const cacheCreateTokens = toNonNegInt(usage.cache_creation_input_tokens);
            const cacheReadTokens = toNonNegInt(usage.cache_read_input_tokens);
            if (inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens === 0)
                return;
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
        const payload = (obj.payload && typeof obj.payload === 'object' ? obj.payload : {});
        if (obj.type === 'session_meta' || obj.type === 'turn_context') {
            if (typeof payload.model === 'string' && payload.model) {
                state.activeModel = payload.model;
            }
            return;
        }
        if (obj.type === 'event_msg' && payload.type === 'token_count') {
            if (payload.rate_limits && typeof payload.rate_limits === 'object') {
                const rl = payload.rate_limits;
                state.latestCodexRateLimits = {
                    capturedAt: ts,
                    planType: typeof rl.plan_type === 'string' ? rl.plan_type : undefined,
                    primary: rl.primary ?? null,
                    secondary: rl.secondary ?? null,
                };
            }
            const info = payload.info;
            if (!info || typeof info !== 'object')
                return;
            const totalUsage = info.total_token_usage;
            const lastUsage = info.last_token_usage;
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
            }
            else if (lastUsage && typeof lastUsage === 'object') {
                inputDelta = toNonNegInt(lastUsage.input_tokens);
                cachedDelta = toNonNegInt(lastUsage.cached_input_tokens);
                outputDelta = toNonNegInt(lastUsage.output_tokens);
                reasoningDelta = toNonNegInt(lastUsage.reasoning_output_tokens);
            }
            if (inputDelta + cachedDelta + outputDelta === 0)
                return;
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
    loadCache() {
        try {
            if (!node_fs_1.default.existsSync(this.cachePath))
                return;
            const parsed = JSON.parse(node_fs_1.default.readFileSync(this.cachePath, 'utf8'));
            if (parsed && parsed.version === 1 && parsed.files) {
                this.cache = parsed;
            }
        }
        catch {
            this.cache = { version: 1, files: {} };
        }
    }
    saveCache() {
        (0, settingsStore_1.atomicWriteFileSync)(this.cachePath, JSON.stringify(this.cache));
    }
}
exports.TokenAnalyticsEngine = TokenAnalyticsEngine;
function toNonNegInt(val) {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function parseTimestamp(val) {
    if (typeof val === 'number' && Number.isFinite(val)) {
        return val > 1e12 ? val : val * 1000;
    }
    if (typeof val === 'string' && val.trim()) {
        const ms = Date.parse(val);
        return Number.isFinite(ms) ? ms : null;
    }
    return null;
}
function computeRangeWindow(range, nowMs) {
    const now = new Date(nowMs);
    let start;
    let end;
    if (range === 'last_month') {
        start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        end = new Date(now.getFullYear(), now.getMonth(), 0);
    }
    else if (range === 'last_30_days') {
        end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        start = new Date(end.getTime() - 29 * 86_400_000);
    }
    else {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    }
    const dateKeys = [];
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
