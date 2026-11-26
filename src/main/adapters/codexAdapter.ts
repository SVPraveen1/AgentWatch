import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { AgentConnectionStatus, NormalizedEvent } from '../../shared/types';
import { atomicWriteFileSync } from '../core/settingsStore';
import { SUMMARY_CONTEXT_INSTRUCTION } from '../summaries/summaryPipeline';
import { extractToolCommandOrAction, isAgentWatchHookCommand } from './claudeCodeAdapter';
import { formatHookCommand, getFolderNameFromCwd, type AgentPaths } from './pathResolver';
import { hasCodexConfigHook, patchCodexConfigToml, unpatchCodexConfigToml } from './tomlPatcher';
import type { AgentAdapter, ConnectOptions, RawHookEnvelope } from './types';

const execFileAsync = promisify(execFile);

const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
] as const;

interface CodexHookCommandItem {
  type?: string;
  command?: string;
  commandWindows?: string;
  timeout?: number;
  [k: string]: unknown;
}

interface CodexHookGroup {
  matcher?: string;
  hooks?: CodexHookCommandItem[];
  [k: string]: unknown;
}

function backupIfMissing(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const bak = `${filePath}.agentwatch.bak`;
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(filePath, bak);
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  readonly supportsBlockingPermissions = false;
  readonly limitationNote =
    'Codex CLI permissions on Windows fall back to read-only "Needs you in terminal" alerts unless interactive hooks are enabled & trusted in Codex.';

  private async detectInstalled(paths: AgentPaths): Promise<{ installed: boolean; details: string }> {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    try {
      const { stdout } = await execFileAsync(whichCmd, ['codex'], { timeout: 1500 });
      const bin = stdout.split(/\r?\n/)[0]?.trim();
      if (bin) {
        return { installed: true, details: `Found at ${bin}` };
      }
    } catch {
      // Fallback to checking ~/.codex or CODEX_HOME
    }
    if (fs.existsSync(paths.codexHomeDir)) {
      return { installed: true, details: `Codex home present at ${paths.codexHomeDir}` };
    }
    return {
      installed: false,
      details: 'Codex CLI not found on PATH and ~/.codex / CODEX_HOME does not exist yet.',
    };
  }

  async getStatus(paths: AgentPaths): Promise<AgentConnectionStatus> {
    const install = await this.detectInstalled(paths);
    const now = Date.now();
    try {
      const configRaw = fs.existsSync(paths.codexConfigFile)
        ? fs.readFileSync(paths.codexConfigFile, 'utf8')
        : '';
      const hasNotify = hasCodexConfigHook(configRaw);
      const hasHooksJson = this.hasHooksJsonEntry(paths.codexHooksFile);
      const hookPresent = hasNotify || hasHooksJson;

      return {
        agent: this.id,
        displayName: this.displayName,
        installed: install.installed,
        installDetails: install.details,
        state: hookPresent ? 'connected' : install.installed ? 'not_connected' : 'not_installed',
        configPath: paths.codexConfigFile,
        hookPresent,
        supportsBlockingPermissions: false,
        limitationNote: this.limitationNote,
        lastCheckedAt: now,
      };
    } catch (err) {
      return {
        agent: this.id,
        displayName: this.displayName,
        installed: install.installed,
        installDetails: install.details,
        state: 'error',
        configPath: paths.codexConfigFile,
        hookPresent: false,
        supportsBlockingPermissions: false,
        limitationNote: this.limitationNote,
        lastCheckedAt: now,
        error: `Failed to inspect Codex config: ${String(err)}`,
      };
    }
  }

  async connect(paths: AgentPaths, options: ConnectOptions): Promise<AgentConnectionStatus> {
    fs.mkdirSync(paths.codexHomeDir, { recursive: true });
    backupIfMissing(paths.codexConfigFile);
    backupIfMissing(paths.codexHooksFile);

    const existingToml = fs.existsSync(paths.codexConfigFile)
      ? fs.readFileSync(paths.codexConfigFile, 'utf8')
      : '';
    const patchedToml = patchCodexConfigToml(
      existingToml,
      [options.hookExecutablePath, '--agent', 'codex', '--event', 'notify'],
      true,
    );
    atomicWriteFileSync(paths.codexConfigFile, patchedToml);

    this.connectHooksJson(paths.codexHooksFile, options);
    syncCodexManagedInstructions(paths.codexManagedInstructionsFile, options.askAgentsForSummaries);
    return this.getStatus(paths);
  }

  async disconnect(paths: AgentPaths): Promise<AgentConnectionStatus> {
    if (fs.existsSync(paths.codexConfigFile)) {
      backupIfMissing(paths.codexConfigFile);
      const existingToml = fs.readFileSync(paths.codexConfigFile, 'utf8');
      const restored = unpatchCodexConfigToml(existingToml);
      atomicWriteFileSync(paths.codexConfigFile, restored);
    }
    this.disconnectHooksJson(paths.codexHooksFile);
    syncCodexManagedInstructions(paths.codexManagedInstructionsFile, false);
    return this.getStatus(paths);
  }

  private hasHooksJsonEntry(hooksPath: string): boolean {
    if (!fs.existsSync(hooksPath)) return false;
    const raw = fs.readFileSync(hooksPath, 'utf8').trim();
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hooksObj = (parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : parsed) as Record<
      string,
      unknown
    >;
    for (const val of Object.values(hooksObj)) {
      if (!Array.isArray(val)) continue;
      for (const grp of val as CodexHookGroup[]) {
        if (grp?.hooks?.some((h) => isAgentWatchHookCommand(h?.command) || isAgentWatchHookCommand(h?.commandWindows))) {
          return true;
        }
      }
    }
    return false;
  }

  private connectHooksJson(hooksPath: string, options: ConnectOptions): void {
    let root: Record<string, unknown> = {};
    let hadHooksFile = false;
    if (fs.existsSync(hooksPath)) {
      hadHooksFile = true;
      const raw = fs.readFileSync(hooksPath, 'utf8').trim();
      if (raw) {
        root = JSON.parse(raw) as Record<string, unknown>;
      }
    }
    this.stripHooksJson(root);

    const hooksObj =
      root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
        ? (root.hooks as Record<string, unknown>)
        : {};

    for (const eventName of CODEX_HOOK_EVENTS) {
      const existing = Array.isArray(hooksObj[eventName]) ? (hooksObj[eventName] as CodexHookGroup[]) : [];
      const isBlocking = eventName === 'PermissionRequest';
      const args = ['--agent', 'codex', '--event', eventName];
      if (isBlocking) {
        args.push('--wait', '--wait-seconds', String(options.permissionTimeoutSeconds + 30));
      }
      const cmd = formatHookCommand(options.hookExecutablePath, args);
      const entry: CodexHookGroup = {
        matcher: eventName === 'PreToolUse' || eventName === 'PostToolUse' ? '.*' : undefined,
        hooks: [
          {
            type: 'command',
            command: cmd,
            timeout: isBlocking ? options.permissionTimeoutSeconds + 35 : 5,
          },
        ],
      };
      if (entry.matcher === undefined) {
        delete entry.matcher;
      }
      hooksObj[eventName] = [...existing, entry];
    }

    if (!hadHooksFile || Object.keys(root).length === 0 || root.hooks !== undefined) {
      root.hooks = hooksObj;
    }
    atomicWriteFileSync(hooksPath, JSON.stringify(root, null, 2) + '\n');
  }

  private disconnectHooksJson(hooksPath: string): void {
    if (!fs.existsSync(hooksPath)) return;
    const raw = fs.readFileSync(hooksPath, 'utf8').trim();
    if (!raw) return;
    const root = JSON.parse(raw) as Record<string, unknown>;
    this.stripHooksJson(root);
    if (Object.keys(root).length === 0 && !fs.existsSync(`${hooksPath}.agentwatch.bak`)) {
      fs.unlinkSync(hooksPath);
    } else {
      atomicWriteFileSync(hooksPath, JSON.stringify(root, null, 2) + '\n');
    }
  }

  private stripHooksJson(root: Record<string, unknown>): void {
    const hooksObj =
      root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
        ? (root.hooks as Record<string, unknown>)
        : root;

    for (const [key, val] of Object.entries(hooksObj)) {
      if (!Array.isArray(val)) continue;
      const kept: CodexHookGroup[] = [];
      for (const grp of val as CodexHookGroup[]) {
        if (!grp || !Array.isArray(grp.hooks)) {
          kept.push(grp);
          continue;
        }
        const rem = grp.hooks.filter(
          (h) => !isAgentWatchHookCommand(h?.command) && !isAgentWatchHookCommand(h?.commandWindows),
        );
        if (rem.length > 0) {
          kept.push({ ...grp, hooks: rem });
        }
      }
      if (kept.length > 0) {
        hooksObj[key] = kept;
      } else {
        delete hooksObj[key];
      }
    }

    if (root.hooks && typeof root.hooks === 'object' && Object.keys(root.hooks as object).length === 0) {
      delete root.hooks;
    }
  }

  normalizeHookEvent(envelope: RawHookEnvelope): NormalizedEvent | null {
    const p = envelope.payload ?? {};
    const eventType = String(p.hook_event_name || p.type || envelope.hookEvent || '');
    const sessionId = String(p.session_id || p['thread-id'] || p.thread_id || 'codex-unknown');
    const cwd = String(p.cwd || '');
    const folderName = getFolderNameFromCwd(cwd);
    const timestamp = envelope.sentAt || Date.now();
    const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : undefined;

    const base = {
      id: crypto.randomUUID(),
      agent: this.id,
      sessionId,
      timestamp,
      cwd,
      folderName,
      pid: envelope.ppid,
      transcriptPath,
      rawPayload: p,
    };

    // Handle `notify` payloads from config.toml
    if (eventType === 'agent-turn-complete' || (eventType === 'notify' && p.type === 'agent-turn-complete')) {
      const lastMsg =
        typeof p['last-assistant-message'] === 'string'
          ? p['last-assistant-message']
          : typeof p.last_assistant_message === 'string'
            ? p.last_assistant_message
            : undefined;
      const inputMsgs = Array.isArray(p['input-messages']) ? p['input-messages'] : [];
      const firstPrompt = typeof inputMsgs[0] === 'string' ? inputMsgs[0].slice(0, 64) : undefined;
      return {
        ...base,
        type: 'turn_finished',
        title: firstPrompt,
        lastAssistantMessage: lastMsg,
      };
    }

    if (eventType === 'approval-requested' || (eventType === 'notify' && p.type === 'approval-requested')) {
      return {
        ...base,
        type: 'permission_requested',
        requestId: crypto.randomUUID(),
        toolName: String(p.tool_name || 'Codex Approval'),
        commandOrAction: String(p.command || p.reason || 'Approval requested in Codex terminal'),
        rawInput: p,
        readOnlyInTerminal: true,
      };
    }

    const toolName = typeof p.tool_name === 'string' ? p.tool_name : undefined;
    const rawInput =
      p.tool_input && typeof p.tool_input === 'object' && !Array.isArray(p.tool_input)
        ? (p.tool_input as Record<string, unknown>)
        : {};
    const commandOrAction = toolName ? extractToolCommandOrAction(toolName, rawInput) : undefined;

    switch (eventType) {
      case 'SessionStart':
        return { ...base, type: 'session_started', title: folderName };
      case 'UserPromptSubmit': {
        const prompt = typeof p.prompt === 'string' ? p.prompt.trim() : '';
        return {
          ...base,
          type: 'prompt_submitted',
          title: prompt ? prompt.split(/\r?\n/)[0].slice(0, 64) : undefined,
        };
      }
      case 'PreToolUse':
      case 'PostToolUse':
        return {
          ...base,
          type: 'working',
          toolName: toolName || 'Codex Tool',
          commandOrAction,
          rawInput,
        };
      case 'PermissionRequest':
        return {
          ...base,
          type: 'permission_requested',
          requestId: crypto.randomUUID(),
          toolName: toolName || 'Codex Tool',
          commandOrAction: commandOrAction || toolName || 'Action',
          rawInput,
          readOnlyInTerminal: false,
        };
      case 'Stop':
        return {
          ...base,
          type: 'turn_finished',
          lastAssistantMessage:
            typeof p.last_assistant_message === 'string' ? p.last_assistant_message : undefined,
        };
      case 'SessionEnd':
        return { ...base, type: 'session_ended' };
      default:
        return null;
    }
  }
}

const AGENTS_START_MARKER = '<!-- AGENTWATCH_SUMMARY_START -->';
const AGENTS_END_MARKER = '<!-- AGENTWATCH_SUMMARY_END -->';

export function syncCodexManagedInstructions(filePath: string, enabled: boolean): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const blockRegex = new RegExp(
    `\\r?\\n?${AGENTS_START_MARKER}[\\s\\S]*?${AGENTS_END_MARKER}\\r?\\n?`,
    'g',
  );
  const stripped = existing.replace(blockRegex, '').trim();

  if (!enabled) {
    if (!fs.existsSync(filePath)) return;
    if (!stripped && !fs.existsSync(`${filePath}.agentwatch.bak`)) {
      fs.unlinkSync(filePath);
    } else {
      atomicWriteFileSync(filePath, stripped ? stripped + '\n' : '');
    }
    return;
  }

  if (existing) backupIfMissing(filePath);
  const block = [
    AGENTS_START_MARKER,
    SUMMARY_CONTEXT_INSTRUCTION,
    AGENTS_END_MARKER,
  ].join('\n');
  const next = stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
  atomicWriteFileSync(filePath, next);
}
