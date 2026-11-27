import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, AlwaysAllowRule } from '../../shared/types';
import { atomicWriteFileSync } from '../core/settingsStore';

const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'cmd', 'execute_command', 'terminal']);

const SINGLE_TOKEN_COMMANDS = new Set([
  'ls',
  'dir',
  'pwd',
  'whoami',
  'cat',
  'type',
  'echo',
  'find',
  'grep',
  'rg',
  'sed',
  'awk',
  'head',
  'tail',
  'wc',
  'sort',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'curl',
  'wget',
  'node',
  'python',
  'python3',
  'pytest',
  'vitest',
  'tsc',
  'eslint',
  'prettier',
]);

const DESTRUCTIVE_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  // Recursive or forced deletions (catches "rm -rf", split flags "rm -r /dir -f", "rm -R", etc.)
  { regex: /\brm\b[^\n]*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)/i, reason: 'Recursive file deletion (rm -r)' },
  { regex: /\brm\b[^\n]*(?:-[a-zA-Z]*f[a-zA-Z]*|--force)/i, reason: 'Forced file deletion (rm -f)' },
  { regex: /\bfind\b[^\n]*(?:-delete|-exec\s+rm\b)/i, reason: 'Recursive file deletion with find' },
  { regex: /\b(?:rmdir|rd)\b[^\n]*\/s/i, reason: 'Recursive Windows directory deletion' },
  { regex: /\b(?:del|erase)\b[^\n]*\/[sfq]/i, reason: 'Forced/recursive Windows file deletion' },
  { regex: /\b(?:Remove-Item|ri)\b[^\n]*-(?:Recurse|Force|r|fo)\b/i, reason: 'PowerShell recursive/forced Remove-Item' },
  { regex: /\bgit\s+push\b[^\n]*(?:\s-f\b|--force(?:-with-lease)?\b)/i, reason: 'Forced git push' },
  { regex: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\b[^\n]*-[a-zA-Z]*f/i, reason: 'Destructive git reset or clean' },
  { regex: /\bgit\s+checkout\b[^\n]*(?:\s-f\b|--force\b)/i, reason: 'Forced git checkout discarding changes' },
  { regex: /\bgit\s+branch\b[^\n]*(?:\s-D\b|--delete\s+--force\b)/i, reason: 'Force branch deletion' },
  { regex: /\b(?:format(?:\.com|\.exe)?|diskpart|mkfs(?:\.[a-z0-9]+)?|fdisk|parted|shred|wipefs|bcdedit)\b/i, reason: 'Disk formatting or partition command' },
  { regex: /\bdd\s+[^\n]*\bof=/i, reason: 'Raw disk/file overwrite with dd' },
  { regex: /\b(?:shutdown|Stop-Computer|Restart-Computer|reg\s+delete)\b/i, reason: 'System shutdown or registry deletion' },
  { regex: /\b(?:DROP\s+(?:DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE)\b/i, reason: 'Destructive SQL schema/data drop' },
  { regex: /\b(?:prisma|drizzle-kit|supabase)\s+(?:migrate\s+reset|db\s+push\s+--force-reset|db\s+reset)\b/i, reason: 'Database reset command' },
  { regex: /(?:curl|wget|irm|Invoke-WebRequest)\b[^\n]*\|\s*(?:sh|bash|pwsh|powershell|iex|Invoke-Expression)\b/i, reason: 'Piped remote script execution' },
  { regex: /\b(?:sh|bash|zsh|cmd|powershell|pwsh)\s+(?:-c|-Command|\/c)\s+["'][^"']*\b(?:rm\s+-[a-zA-Z]*[rf]|del\s+\/|Remove-Item)\b/i, reason: 'Subshell wrapped destructive command' },
  { regex: /\bchmod\s+-R\s+(?:777|000)\s+\/(?:\s|$)/i, reason: 'Root recursive dangerous chmod' },
  { regex: /\b(?:Write|Edit|MultiEdit|apply_patch)\b[^\n]*(?:\.env|id_rsa|id_ed25519|authorized_keys|system32|\.ssh[\/\\]|\.aws[\/\\])/i, reason: 'Sensitive system or secret file modification' },
  { regex: /(?:>|>>)\s*[^\n]*(?:\.env|id_rsa|authorized_keys|\.ssh[\/\\])/i, reason: 'Shell redirection into secret or auth file' },
];

export function checkDestructiveCommand(
  toolName: string,
  commandOrAction: string,
): { destructive: boolean; reason?: string } {
  const combined = `${toolName} ${commandOrAction}`.trim();
  for (const rule of DESTRUCTIVE_PATTERNS) {
    if (rule.regex.test(combined)) {
      return { destructive: true, reason: rule.reason };
    }
  }
  return { destructive: false };
}

/**
 * Extracts leading program + subcommand (e.g. "pnpm prisma migrate deploy" -> "pnpm prisma",
 * "pnpm test --filter billing" -> "pnpm test", "NODE_ENV=test npm test" -> "npm test").
 */
export function extractMatcherPrefix(toolName: string, commandOrAction: string): string {
  const normalizedTool = toolName.trim().toLowerCase();
  if (!SHELL_TOOLS.has(normalizedTool)) {
    return toolName.trim();
  }

  const tokens = commandOrAction
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  // Strip leading VAR=val env assignments
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
    idx++;
  }
  const prog = tokens[idx];
  if (!prog) return toolName.trim();

  const progBase = path.basename(prog).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  const next = tokens[idx + 1];

  if (
    next &&
    !next.startsWith('-') &&
    !SINGLE_TOKEN_COMMANDS.has(progBase) &&
    !/[\\/:.]/.test(next)
  ) {
    return `${prog} ${next}`;
  }
  return prog;
}

export function buildAlwaysAllowRule(params: {
  agent: AgentId;
  toolName: string;
  commandOrAction: string;
  cwd: string;
}): { rule?: AlwaysAllowRule; blockedReason?: string } {
  const safety = checkDestructiveCommand(params.toolName, params.commandOrAction);
  if (safety.destructive) {
    return {
      blockedReason: `Safety guard blocked creating an Always-Allow rule (${safety.reason}). Allowed this request once.`,
    };
  }

  const normalizedTool = params.toolName.trim().toLowerCase();
  const isShell = SHELL_TOOLS.has(normalizedTool);
  const matcher = extractMatcherPrefix(params.toolName, params.commandOrAction);
  const scope: AlwaysAllowRule['scope'] = 'folder';

  const agentLabel = params.agent === 'claude_code' ? 'Claude Code' : 'Codex';
  const folderLabel = path.basename(params.cwd.replace(/[\\/]+$/, '')) || params.cwd || 'workspace';
  const description = isShell
    ? `${agentLabel}: allow ${params.toolName} commands starting with "${matcher}" in ${folderLabel}`
    : `${agentLabel}: allow tool "${params.toolName}" in ${folderLabel}`;

  return {
    rule: {
      id: crypto.randomUUID(),
      agent: params.agent,
      tool: params.toolName,
      matcher,
      scope,
      cwd: params.cwd,
      description,
      createdAt: Date.now(),
    },
  };
}

export function doesRuleMatch(
  rule: AlwaysAllowRule,
  params: { agent: AgentId; toolName: string; commandOrAction: string; cwd: string },
): boolean {
  if (rule.agent !== params.agent) return false;
  if (rule.tool.toLowerCase() !== params.toolName.toLowerCase()) return false;
  if (rule.scope === 'folder' && rule.cwd && normalizeCwd(rule.cwd) !== normalizeCwd(params.cwd)) {
    return false;
  }

  // Never auto-allow destructive commands even if a legacy/manual rule existed.
  if (checkDestructiveCommand(params.toolName, params.commandOrAction).destructive) {
    return false;
  }

  if (!SHELL_TOOLS.has(rule.tool.toLowerCase())) {
    return true;
  }

  const candidate = stripEnvAssignments(params.commandOrAction.trim());
  const prefix = rule.matcher.trim();
  if (!prefix) return false;
  return (
    candidate === prefix ||
    candidate.startsWith(`${prefix} `) ||
    candidate.startsWith(`${prefix}\t`)
  );
}

function stripEnvAssignments(cmd: string): string {
  const parts = cmd.split(/\s+/);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) {
    i++;
  }
  return parts.slice(i).join(' ');
}

function normalizeCwd(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase();
}

export class RuleStore {
  private readonly filePath: string;
  private rules: AlwaysAllowRule[] = [];

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'rules.json');
    this.load();
  }

  list(): AlwaysAllowRule[] {
    return [...this.rules].sort((a, b) => b.createdAt - a.createdAt);
  }

  add(rule: AlwaysAllowRule): AlwaysAllowRule {
    const dup = this.rules.find(
      (r) =>
        r.agent === rule.agent &&
        r.tool.toLowerCase() === rule.tool.toLowerCase() &&
        r.matcher === rule.matcher &&
        r.scope === rule.scope &&
        normalizeCwd(r.cwd || '') === normalizeCwd(rule.cwd || ''),
    );
    if (dup) return dup;
    this.rules.push(rule);
    this.save();
    return rule;
  }

  findMatchingRule(params: {
    agent: AgentId;
    toolName: string;
    commandOrAction: string;
    cwd: string;
  }): AlwaysAllowRule | undefined {
    return this.rules.find((r) => doesRuleMatch(r, params));
  }

  revoke(ruleId: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== ruleId);
    if (this.rules.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  clearAll(): void {
    this.rules = [];
    this.save();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as AlwaysAllowRule[];
      if (Array.isArray(parsed)) this.rules = parsed;
    } catch {
      this.rules = [];
    }
  }

  private save(): void {
    atomicWriteFileSync(this.filePath, JSON.stringify(this.rules, null, 2) + '\n');
  }
}
