"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuleStore = void 0;
exports.checkDestructiveCommand = checkDestructiveCommand;
exports.extractMatcherPrefix = extractMatcherPrefix;
exports.buildAlwaysAllowRule = buildAlwaysAllowRule;
exports.doesRuleMatch = doesRuleMatch;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const settingsStore_1 = require("../core/settingsStore");
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
const DESTRUCTIVE_PATTERNS = [
    { regex: /(?:^|\s|;|&&|\|)rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)/i, reason: 'Recursive or forced file deletion (rm)' },
    { regex: /\brmdir\s+\/s\b|\bdel\s+\/[sfq]/i, reason: 'Recursive/forced Windows deletion' },
    { regex: /\bRemove-Item\b[^\n]*-(?:Recurse|Force)\b/i, reason: 'PowerShell recursive/forced Remove-Item' },
    { regex: /\bgit\s+push\b[^\n]*(?:\s-f\b|--force(?:-with-lease)?\b)/i, reason: 'Forced git push' },
    { regex: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-zA-Z]*f/i, reason: 'Destructive git reset/clean' },
    { regex: /\b(?:format(?:\.com|\.exe)?|diskpart|mkfs(?:\.[a-z0-9]+)?|fdisk|parted|shred|wipefs|bcdedit)\b/i, reason: 'Disk formatting or partition command' },
    { regex: /\bdd\s+[^\n]*\bof=/i, reason: 'Raw disk/file overwrite with dd' },
    { regex: /\b(?:shutdown|Stop-Computer|Restart-Computer|reg\s+delete)\b/i, reason: 'System shutdown or registry deletion' },
    { regex: /\b(?:DROP\s+(?:DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE)\b/i, reason: 'Destructive SQL schema/data drop' },
    { regex: /\bprisma\s+(?:migrate\s+reset|db\s+push\s+--force-reset)\b/i, reason: 'Database reset command' },
    { regex: /(?:curl|wget|irm|Invoke-WebRequest)\b[^\n]*\|\s*(?:sh|bash|pwsh|powershell|iex|Invoke-Expression)\b/i, reason: 'Piped remote script execution' },
    { regex: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i, reason: 'Root recursive chmod 777' },
    { regex: /\b(?:Write|Edit|MultiEdit|apply_patch)\b[^\n]*(?:\.env|id_rsa|authorized_keys|system32)/i, reason: 'Sensitive system or secret file modification' },
];
function checkDestructiveCommand(toolName, commandOrAction) {
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
function extractMatcherPrefix(toolName, commandOrAction) {
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
    if (!prog)
        return toolName.trim();
    const progBase = node_path_1.default.basename(prog).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
    const next = tokens[idx + 1];
    if (next &&
        !next.startsWith('-') &&
        !SINGLE_TOKEN_COMMANDS.has(progBase) &&
        !/[\\/:.]/.test(next)) {
        return `${prog} ${next}`;
    }
    return prog;
}
function buildAlwaysAllowRule(params) {
    const safety = checkDestructiveCommand(params.toolName, params.commandOrAction);
    if (safety.destructive) {
        return {
            blockedReason: `Safety guard blocked creating an Always-Allow rule (${safety.reason}). Allowed this request once.`,
        };
    }
    const normalizedTool = params.toolName.trim().toLowerCase();
    const isShell = SHELL_TOOLS.has(normalizedTool);
    const matcher = extractMatcherPrefix(params.toolName, params.commandOrAction);
    const scope = 'folder';
    const agentLabel = params.agent === 'claude_code' ? 'Claude Code' : 'Codex';
    const folderLabel = node_path_1.default.basename(params.cwd.replace(/[\\/]+$/, '')) || params.cwd || 'workspace';
    const description = isShell
        ? `${agentLabel}: allow ${params.toolName} commands starting with "${matcher}" in ${folderLabel}`
        : `${agentLabel}: allow tool "${params.toolName}" in ${folderLabel}`;
    return {
        rule: {
            id: node_crypto_1.default.randomUUID(),
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
function doesRuleMatch(rule, params) {
    if (rule.agent !== params.agent)
        return false;
    if (rule.tool.toLowerCase() !== params.toolName.toLowerCase())
        return false;
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
    if (!prefix)
        return false;
    return (candidate === prefix ||
        candidate.startsWith(`${prefix} `) ||
        candidate.startsWith(`${prefix}\t`));
}
function stripEnvAssignments(cmd) {
    const parts = cmd.split(/\s+/);
    let i = 0;
    while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) {
        i++;
    }
    return parts.slice(i).join(' ');
}
function normalizeCwd(p) {
    return p.replace(/[\\/]+$/, '').toLowerCase();
}
class RuleStore {
    filePath;
    rules = [];
    constructor(dataDir) {
        this.filePath = node_path_1.default.join(dataDir, 'rules.json');
        this.load();
    }
    list() {
        return [...this.rules].sort((a, b) => b.createdAt - a.createdAt);
    }
    add(rule) {
        const dup = this.rules.find((r) => r.agent === rule.agent &&
            r.tool.toLowerCase() === rule.tool.toLowerCase() &&
            r.matcher === rule.matcher &&
            r.scope === rule.scope &&
            normalizeCwd(r.cwd || '') === normalizeCwd(rule.cwd || ''));
        if (dup)
            return dup;
        this.rules.push(rule);
        this.save();
        return rule;
    }
    findMatchingRule(params) {
        return this.rules.find((r) => doesRuleMatch(r, params));
    }
    revoke(ruleId) {
        const before = this.rules.length;
        this.rules = this.rules.filter((r) => r.id !== ruleId);
        if (this.rules.length !== before) {
            this.save();
            return true;
        }
        return false;
    }
    clearAll() {
        this.rules = [];
        this.save();
    }
    load() {
        try {
            if (!node_fs_1.default.existsSync(this.filePath))
                return;
            const parsed = JSON.parse(node_fs_1.default.readFileSync(this.filePath, 'utf8'));
            if (Array.isArray(parsed))
                this.rules = parsed;
        }
        catch {
            this.rules = [];
        }
    }
    save() {
        (0, settingsStore_1.atomicWriteFileSync)(this.filePath, JSON.stringify(this.rules, null, 2) + '\n');
    }
}
exports.RuleStore = RuleStore;
