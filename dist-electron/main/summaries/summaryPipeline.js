"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SummaryPipeline = exports.DisabledLlmSummarizerStub = exports.SUMMARY_CONTEXT_INSTRUCTION = void 0;
exports.parseAgentAuthoredSummary = parseAgentAuthoredSummary;
exports.readLastAssistantMessageFromTranscript = readLastAssistantMessageFromTranscript;
const node_fs_1 = __importDefault(require("node:fs"));
const constants_1 = require("../../shared/constants");
const sanitizer_1 = require("./sanitizer");
exports.SUMMARY_CONTEXT_INSTRUCTION = `When you finish your final response for this turn, end with a single plain-language line on its own line: ${constants_1.SUMMARY_MARKER_PREFIX} <one sentence, max ${constants_1.SUMMARY_MAX_CHARS} characters, describing what changed or was found>.`;
class DisabledLlmSummarizerStub {
    id = 'disabled-llm-summarizer-stub';
    async summarize() {
        // Off by default in v1; reserved hook for invoking the agent's headless CLI later.
        return null;
    }
}
exports.DisabledLlmSummarizerStub = DisabledLlmSummarizerStub;
function parseAgentAuthoredSummary(message) {
    if (!message)
        return { summary: null, strippedMessage: '' };
    const lines = message.split(/\r?\n/);
    let extracted = null;
    const keptLines = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.toUpperCase().startsWith(constants_1.SUMMARY_MARKER_PREFIX)) {
            const candidate = trimmed.slice(constants_1.SUMMARY_MARKER_PREFIX.length).trim();
            // Treat placeholder/empty/too-short lines as missing so Tier 2 takes over cleanly.
            if (candidate.length >= 6 && !/^<.*>$/.test(candidate)) {
                extracted = (0, sanitizer_1.truncateSummary)((0, sanitizer_1.stripMarkdownToPlainText)(candidate), constants_1.SUMMARY_MAX_CHARS);
            }
            continue;
        }
        keptLines.push(line);
    }
    return {
        summary: extracted && extracted.length >= 6 ? extracted : null,
        strippedMessage: keptLines.join('\n').trim(),
    };
}
function readLastAssistantMessageFromTranscript(agent, transcriptPath) {
    if (!transcriptPath || !node_fs_1.default.existsSync(transcriptPath))
        return null;
    try {
        const stat = node_fs_1.default.statSync(transcriptPath);
        // Read at most the last 256 KB so huge session transcripts never stall the main thread.
        const readSize = Math.min(stat.size, 256 * 1024);
        const startOffset = Math.max(0, stat.size - readSize);
        const buf = Buffer.alloc(readSize);
        const fd = node_fs_1.default.openSync(transcriptPath, 'r');
        try {
            node_fs_1.default.readSync(fd, buf, 0, readSize, startOffset);
        }
        finally {
            node_fs_1.default.closeSync(fd);
        }
        const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const obj = JSON.parse(lines[i]);
                const text = extractAssistantTextFromTranscriptLine(agent, obj);
                if (text && text.trim())
                    return text;
            }
            catch {
                // Ignore truncated first line or malformed line.
            }
        }
    }
    catch {
        return null;
    }
    return null;
}
function extractAssistantTextFromTranscriptLine(agent, entry) {
    if (agent === 'claude_code') {
        if (entry.type === 'assistant' && entry.message && typeof entry.message === 'object') {
            const msg = entry.message;
            return extractTextBlocks(msg.content);
        }
    }
    if (agent === 'codex') {
        if (entry.type === 'response_item' && entry.payload && typeof entry.payload === 'object') {
            const p = entry.payload;
            if (p.type === 'message' && p.role === 'assistant') {
                return extractTextBlocks(p.content);
            }
        }
        if (entry.type === 'event_msg' && entry.payload && typeof entry.payload === 'object') {
            const p = entry.payload;
            if (p.type === 'agent_message' && typeof p.message === 'string') {
                return p.message;
            }
        }
    }
    return null;
}
function extractTextBlocks(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return null;
    const parts = [];
    for (const item of content) {
        if (!item || typeof item !== 'object')
            continue;
        const block = item;
        if ((block.type === 'text' || block.type === 'output_text') && typeof block.text === 'string') {
            parts.push(block.text);
        }
    }
    return parts.length > 0 ? parts.join('\n') : null;
}
class SummaryPipeline {
    tier3;
    constructor(tier3 = new DisabledLlmSummarizerStub()) {
        this.tier3 = tier3;
    }
    async generateSummary(event, options) {
        const agentLabel = event.agent === 'claude_code' ? 'Claude Code' : 'Codex';
        if (event.type === 'permission_requested') {
            const action = (0, sanitizer_1.redactSecrets)(event.commandOrAction || event.toolName || 'an action');
            return (0, sanitizer_1.truncateSummary)(`${agentLabel} needs approval to run ${action} in ${event.folderName}.`);
        }
        if (event.type === 'needs_input') {
            if (event.summary)
                return (0, sanitizer_1.truncateSummary)((0, sanitizer_1.stripMarkdownToPlainText)(event.summary));
            return (0, sanitizer_1.truncateSummary)(`${agentLabel} is waiting for your input in ${event.folderName}.`);
        }
        if (event.type === 'error') {
            const errMsg = (0, sanitizer_1.stripMarkdownToPlainText)(event.errorMessage || 'encountered an error');
            return (0, sanitizer_1.truncateSummary)(`${agentLabel} error in ${event.folderName}: ${errMsg}`);
        }
        if (event.type === 'turn_finished') {
            const rawMessage = event.lastAssistantMessage ||
                readLastAssistantMessageFromTranscript(event.agent, event.transcriptPath) ||
                '';
            // Tier 1: agent-authored summary line
            const parsed = parseAgentAuthoredSummary(rawMessage);
            if (options.askAgents && parsed.summary) {
                return parsed.summary;
            }
            // Tier 2: app-side watcher fallback (deterministic local extraction, zero model call)
            const cleaned = (0, sanitizer_1.stripMarkdownToPlainText)(parsed.strippedMessage || rawMessage);
            if (cleaned) {
                const sentence = (0, sanitizer_1.extractSentencesUpToLimit)(cleaned, constants_1.SUMMARY_MAX_CHARS);
                if (sentence)
                    return sentence;
            }
            // Tier 3: optional LLM summarizer stub (off by default in v1)
            if (options.llmSummarizerEnabled) {
                const llmOut = await this.tier3.summarize({
                    agent: event.agent,
                    text: parsed.strippedMessage || rawMessage,
                    cwd: event.cwd,
                });
                if (llmOut)
                    return (0, sanitizer_1.truncateSummary)(llmOut);
            }
            if (event.summary) {
                return (0, sanitizer_1.truncateSummary)((0, sanitizer_1.stripMarkdownToPlainText)(event.summary));
            }
            return `${agentLabel} finished turn in ${event.folderName}.`;
        }
        return event.summary ? (0, sanitizer_1.truncateSummary)(event.summary) : '';
    }
}
exports.SummaryPipeline = SummaryPipeline;
