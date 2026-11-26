import fs from 'node:fs';
import { SUMMARY_MAX_CHARS, SUMMARY_MARKER_PREFIX } from '../../shared/constants';
import type { AgentId, NormalizedEvent } from '../../shared/types';
import {
  extractSentencesUpToLimit,
  redactSecrets,
  stripMarkdownToPlainText,
  truncateSummary,
} from './sanitizer';

export const SUMMARY_CONTEXT_INSTRUCTION =
  `When you finish your final response for this turn, end with a single plain-language line on its own line: ${SUMMARY_MARKER_PREFIX} <one sentence, max ${SUMMARY_MAX_CHARS} characters, describing what changed or was found>.`;

/**
 * Tier 3 optional LLM summarizer interface (stubbed and off by default in v1).
 */
export interface LlmSummarizer {
  readonly id: string;
  summarize(input: { agent: AgentId; text: string; cwd: string }): Promise<string | null>;
}

export class DisabledLlmSummarizerStub implements LlmSummarizer {
  readonly id = 'disabled-llm-summarizer-stub';

  async summarize(): Promise<string | null> {
    // Off by default in v1; reserved hook for invoking the agent's headless CLI later.
    return null;
  }
}

export function parseAgentAuthoredSummary(message?: string): {
  summary: string | null;
  strippedMessage: string;
} {
  if (!message) return { summary: null, strippedMessage: '' };
  const lines = message.split(/\r?\n/);
  let extracted: string | null = null;
  const keptLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase().startsWith(SUMMARY_MARKER_PREFIX)) {
      const candidate = trimmed.slice(SUMMARY_MARKER_PREFIX.length).trim();
      // Treat placeholder/empty/too-short lines as missing so Tier 2 takes over cleanly.
      if (candidate.length >= 6 && !/^<.*>$/.test(candidate)) {
        extracted = truncateSummary(stripMarkdownToPlainText(candidate), SUMMARY_MAX_CHARS);
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

export function readLastAssistantMessageFromTranscript(
  agent: AgentId,
  transcriptPath?: string,
): string | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const stat = fs.statSync(transcriptPath);
    // Read at most the last 256 KB so huge session transcripts never stall the main thread.
    const readSize = Math.min(stat.size, 256 * 1024);
    const startOffset = Math.max(0, stat.size - readSize);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, readSize, startOffset);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]) as Record<string, unknown>;
        const text = extractAssistantTextFromTranscriptLine(agent, obj);
        if (text && text.trim()) return text;
      } catch {
        // Ignore truncated first line or malformed line.
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extractAssistantTextFromTranscriptLine(
  agent: AgentId,
  entry: Record<string, unknown>,
): string | null {
  if (agent === 'claude_code') {
    if (entry.type === 'assistant' && entry.message && typeof entry.message === 'object') {
      const msg = entry.message as Record<string, unknown>;
      return extractTextBlocks(msg.content);
    }
  }
  if (agent === 'codex') {
    if (entry.type === 'response_item' && entry.payload && typeof entry.payload === 'object') {
      const p = entry.payload as Record<string, unknown>;
      if (p.type === 'message' && p.role === 'assistant') {
        return extractTextBlocks(p.content);
      }
    }
    if (entry.type === 'event_msg' && entry.payload && typeof entry.payload === 'object') {
      const p = entry.payload as Record<string, unknown>;
      if (p.type === 'agent_message' && typeof p.message === 'string') {
        return p.message;
      }
    }
  }
  return null;
}

function extractTextBlocks(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if ((block.type === 'text' || block.type === 'output_text') && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export class SummaryPipeline {
  constructor(private readonly tier3: LlmSummarizer = new DisabledLlmSummarizerStub()) {}

  async generateSummary(
    event: NormalizedEvent,
    options: { askAgents: boolean; llmSummarizerEnabled: boolean },
  ): Promise<string> {
    const agentLabel = event.agent === 'claude_code' ? 'Claude Code' : 'Codex';

    if (event.type === 'permission_requested') {
      const action = redactSecrets(event.commandOrAction || event.toolName || 'an action');
      return truncateSummary(`${agentLabel} needs approval to run ${action} in ${event.folderName}.`);
    }

    if (event.type === 'needs_input') {
      if (event.summary) return truncateSummary(stripMarkdownToPlainText(event.summary));
      return truncateSummary(`${agentLabel} is waiting for your input in ${event.folderName}.`);
    }

    if (event.type === 'error') {
      const errMsg = stripMarkdownToPlainText(event.errorMessage || 'encountered an error');
      return truncateSummary(`${agentLabel} error in ${event.folderName}: ${errMsg}`);
    }

    if (event.type === 'turn_finished') {
      const rawMessage =
        event.lastAssistantMessage ||
        readLastAssistantMessageFromTranscript(event.agent, event.transcriptPath) ||
        '';

      // Tier 1: agent-authored summary line
      const parsed = parseAgentAuthoredSummary(rawMessage);
      if (options.askAgents && parsed.summary) {
        return parsed.summary;
      }

      // Tier 2: app-side watcher fallback (deterministic local extraction, zero model call)
      const cleaned = stripMarkdownToPlainText(parsed.strippedMessage || rawMessage);
      if (cleaned) {
        const sentence = extractSentencesUpToLimit(cleaned, SUMMARY_MAX_CHARS);
        if (sentence) return sentence;
      }

      // Tier 3: optional LLM summarizer stub (off by default in v1)
      if (options.llmSummarizerEnabled) {
        const llmOut = await this.tier3.summarize({
          agent: event.agent,
          text: parsed.strippedMessage || rawMessage,
          cwd: event.cwd,
        });
        if (llmOut) return truncateSummary(llmOut);
      }

      if (event.summary) {
        return truncateSummary(stripMarkdownToPlainText(event.summary));
      }

      return `${agentLabel} finished turn in ${event.folderName}.`;
    }

    return event.summary ? truncateSummary(event.summary) : '';
  }
}
