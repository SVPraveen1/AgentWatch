import { SUMMARY_MAX_CHARS } from '../../shared/constants';

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bAIzaSy[A-Za-z0-9_-]{33}\b/g,
  /\bhf_[A-Za-z0-9]{34,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g,
  /(?<=Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(?<=(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(?<=(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:\s]+:)[^@\s]+(?=@)/gi,
  /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/gi,
  /\b[0-9a-fA-F]{32,}\b/g,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  return out;
}

export function stripMarkdownToPlainText(input: string): string {
  return input
    // Remove fenced code blocks completely
    .replace(/```[\s\S]*?```/g, ' ')
    // Remove inline code backticks while preserving short command text
    .replace(/`([^`]+)`/g, '$1')
    // Convert markdown links [label](url) -> label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Strip markdown headings, blockquotes, list bullets, emphasis
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateSummary(text: string, maxChars = SUMMARY_MAX_CHARS): string {
  const clean = redactSecrets(text).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  const sliced = clean.slice(0, maxChars - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  const base = lastSpace > maxChars * 0.55 ? sliced.slice(0, lastSpace) : sliced;
  return `${base.replace(/[,:;.\s-]+$/, '')}…`;
}

export function extractSentencesUpToLimit(plainText: string, maxChars = SUMMARY_MAX_CHARS): string {
  const redacted = redactSecrets(plainText).replace(/\s+/g, ' ').trim();
  if (!redacted) return '';
  const sentences = redacted.match(/[^.!?]+[.!?]?/g) ?? [redacted];
  let collected = '';
  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence || sentence.length < 3) continue;
    if (!collected) {
      collected = sentence;
    } else if (`${collected} ${sentence}`.length <= maxChars) {
      collected = `${collected} ${sentence}`;
    } else {
      break;
    }
    if (collected.split(/[.!?]/).filter(Boolean).length >= 2) {
      break;
    }
  }
  return truncateSummary(collected || redacted, maxChars);
}
