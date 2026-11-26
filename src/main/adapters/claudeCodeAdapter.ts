import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOOK_BINARY_NAME } from '../../shared/constants';
import type { AgentConnectionStatus, NormalizedEvent } from '../../shared/types';
import { atomicWriteFileSync } from '../core/settingsStore';
import { formatHookCommand, getFolderNameFromCwd, type AgentPaths } from './pathResolver';
import type { AgentAdapter, ConnectOptions, RawHookEnvelope } from './types';

const execFileAsync = promisify(execFile);

const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

interface HookCommandItem {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  [k: string]: unknown;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks?: HookCommandItem[];
  [k: string]: unknown;
}

export function isAgentWatchHookCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.toLowerCase().includes(HOOK_BINARY_NAME);
}

function createBackupIfMissing(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const bakPath = `${filePath}.agentwatch.bak`;
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(filePath, bakPath);
  }
}

export function extractToolCommandOrAction(toolName: string, toolInput: Record<string, unknown>): string {
  if (typeof toolInput.command === 'string' && toolInput.command.trim()) {
    return toolInput.command.trim();
  }
  if (typeof toolInput.file_path === 'string' && toolInput.file_path.trim()) {
    return `${toolName} ${toolInput.file_path.trim()}`;
  }
  if (typeof toolInput.path === 'string' && toolInput.path.trim()) {
    return `${toolName} ${toolInput.path.trim()}`;
  }
  if (typeof toolInput.pattern === 'string' && toolInput.pattern.trim()) {
    return `${toolName} ${toolInput.pattern.trim()}`;
  }
  if (typeof toolInput.url === 'string' && toolInput.url.trim()) {
    return toolInput.url.trim();
  }
  return toolName;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude_code' as const;
  readonly displayName = 'Claude Code';
  readonly supportsBlockingPermissions = true;

  private async detectInstalled(paths: AgentPaths): Promise<{ installed: boolean; details: string }> {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    try {
      const { stdout } = await execFileAsync(whichCmd, ['claude'], { timeout: 1500 });
      const bin = stdout.split(/\r?\n/)[0]?.trim();
      if (bin) {
        return { installed: true, details: `Found at ${bin}` };
      }
    } catch {
      // Fallback to checking ~/.claude directory
    }
    if (fs.existsSync(paths.claudeDir)) {
      return { installed: true, details: `Config folder present at ${paths.claudeDir}` };
    }
    return {
      installed: false,
      details: 'Claude Code CLI not found on PATH and ~/.claude does not exist yet.',
    };
  }

  async getStatus(paths: AgentPaths): Promise<AgentConnectionStatus> {
    const install = await this.detectInstalled(paths);
    const now = Date.now();
    try {
      if (!fs.existsSync(paths.claudeSettingsFile)) {
        return {
          agent: this.id,
          displayName: this.displayName,
          installed: install.installed,
          installDetails: install.details,
          state: install.installed ? 'not_connected' : 'not_installed',
          configPath: paths.claudeSettingsFile,
          hookPresent: false,
          supportsBlockingPermissions: true,
          lastCheckedAt: now,
        };
      }
      const parsed = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8')) as Record<string, unknown>;
      const hookPresent = this.hasOurHooks(parsed);
      return {
        agent: this.id,
        displayName: this.displayName,
        installed: install.installed,
        installDetails: install.details,
        state: hookPresent ? 'connected' : install.installed ? 'not_connected' : 'not_installed',
        configPath: paths.claudeSettingsFile,
        hookPresent,
        supportsBlockingPermissions: true,
        lastCheckedAt: now,
      };
    } catch (err) {
      return {
        agent: this.id,
        displayName: this.displayName,
        installed: install.installed,
        installDetails: install.details,
        state: 'error',
        configPath: paths.claudeSettingsFile,
        hookPresent: false,
        supportsBlockingPermissions: true,
        lastCheckedAt: now,
        error: `Could not read ${paths.claudeSettingsFile}: ${String(err)}`,
      };
    }
  }

  async connect(paths: AgentPaths, options: ConnectOptions): Promise<AgentConnectionStatus> {
    fs.mkdirSync(paths.claudeDir, { recursive: true });
    createBackupIfMissing(paths.claudeSettingsFile);

    let root: Record<string, unknown> = {};
    if (fs.existsSync(paths.claudeSettingsFile)) {
      const raw = fs.readFileSync(paths.claudeSettingsFile, 'utf8').trim();
      if (raw) {
        root = JSON.parse(raw) as Record<string, unknown>;
      }
    }

    // Remove stale AgentWatch hooks first so re-connecting is idempotent and updates paths/timeouts.
    this.stripOurHooks(root);

    const hooksObj =
      root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
        ? (root.hooks as Record<string, unknown>)
        : {};

    for (const eventName of CLAUDE_HOOK_EVENTS) {
      const existingList = Array.isArray(hooksObj[eventName])
        ? (hooksObj[eventName] as HookMatcherGroup[])
        : [];
      const isBlocking = eventName === 'PermissionRequest';
      const args = ['--agent', 'claude_code', '--event', eventName];
      if (isBlocking) {
        args.push('--wait', '--wait-seconds', String(options.permissionTimeoutSeconds + 30));
      }
      const command = formatHookCommand(options.hookExecutablePath, args);
      const entry: HookMatcherGroup = {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command,
            timeout: isBlocking ? options.permissionTimeoutSeconds + 35 : 5,
          },
        ],
      };
      hooksObj[eventName] = [...existingList, entry];
    }

    root.hooks = hooksObj;

    // Optional opt-in StatusLine bridge (never clobber existing user statusLine unless wrapped)
    if (options.enableClaudeStatusLineBridge && options.statusLineCacheFile) {
      this.attachStatusLineBridge(root, options.hookExecutablePath, options.statusLineCacheFile);
    }

    atomicWriteFileSync(paths.claudeSettingsFile, JSON.stringify(root, null, 2) + '\n');
    return this.getStatus(paths);
  }

  async disconnect(paths: AgentPaths): Promise<AgentConnectionStatus> {
    if (!fs.existsSync(paths.claudeSettingsFile)) {
      return this.getStatus(paths);
    }
    createBackupIfMissing(paths.claudeSettingsFile);
    const raw = fs.readFileSync(paths.claudeSettingsFile, 'utf8').trim();
    if (!raw) return this.getStatus(paths);

    const root = JSON.parse(raw) as Record<string, unknown>;
    this.stripOurHooks(root);
    this.detachStatusLineBridge(root);
    atomicWriteFileSync(paths.claudeSettingsFile, JSON.stringify(root, null, 2) + '\n');
    return this.getStatus(paths);
  }

  private attachStatusLineBridge(
    root: Record<string, unknown>,
    hookExecutablePath: string,
    cacheFile: string,
  ): void {
    const existing = root.statusLine as Record<string, unknown> | undefined;
    const args = ['--agent', 'claude_code', '--event', 'StatusLine', '--cache-file', cacheFile];
    if (existing && typeof existing.command === 'string' && !isAgentWatchHookCommand(existing.command)) {
      args.push('--chain-statusline', existing.command);
    }
    root.statusLine = {
      type: 'command',
      command: formatHookCommand(hookExecutablePath, args),
    };
  }

  private detachStatusLineBridge(root: Record<string, unknown>): void {
    const existing = root.statusLine as Record<string, unknown> | undefined;
    if (!existing || !isAgentWatchHookCommand(existing.command)) return;
    const cmd = String(existing.command);
    const chainIdx = cmd.indexOf('--chain-statusline ');
    if (chainIdx !== -1) {
      const original = cmd.slice(chainIdx + '--chain-statusline '.length).replace(/^"(.*)"$/, '$1');
      root.statusLine = { type: 'command', command: original };
    } else {
      delete root.statusLine;
    }
  }

  private hasOurHooks(root: Record<string, unknown>): boolean {
    const hooks = root.hooks;
    if (!hooks || typeof hooks !== 'object') return false;
    for (const val of Object.values(hooks as Record<string, unknown>)) {
      if (!Array.isArray(val)) continue;
      for (const group of val as HookMatcherGroup[]) {
        if (!group || !Array.isArray(group.hooks)) continue;
        if (group.hooks.some((h) => isAgentWatchHookCommand(h?.command))) {
          return true;
        }
      }
    }
    return false;
  }

  private stripOurHooks(root: Record<string, unknown>): void {
    const hooks = root.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;
    const hooksMap = hooks as Record<string, unknown>;
    for (const [eventName, groups] of Object.entries(hooksMap)) {
      if (!Array.isArray(groups)) continue;
      const filteredGroups: HookMatcherGroup[] = [];
      for (const group of groups as HookMatcherGroup[]) {
        if (!group || !Array.isArray(group.hooks)) {
          filteredGroups.push(group);
          continue;
        }
        const remainingHooks = group.hooks.filter((h) => !isAgentWatchHookCommand(h?.command));
        if (remainingHooks.length > 0) {
          filteredGroups.push({ ...group, hooks: remainingHooks });
        }
      }
      if (filteredGroups.length > 0) {
        hooksMap[eventName] = filteredGroups;
      } else {
        delete hooksMap[eventName];
      }
    }
    if (Object.keys(hooksMap).length === 0) {
      delete root.hooks;
    }
  }

  normalizeHookEvent(envelope: RawHookEnvelope): NormalizedEvent | null {
    const p = envelope.payload ?? {};
    const hookEvent = String(p.hook_event_name || envelope.hookEvent || '');
    const sessionId = String(p.session_id || 'claude-unknown');
    const cwd = String(p.cwd || '');
    const folderName = getFolderNameFromCwd(cwd);
    const timestamp = envelope.sentAt || Date.now();
    const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : undefined;
    const toolName = typeof p.tool_name === 'string' ? p.tool_name : undefined;
    const rawInput =
      p.tool_input && typeof p.tool_input === 'object' && !Array.isArray(p.tool_input)
        ? (p.tool_input as Record<string, unknown>)
        : {};
    const commandOrAction = toolName ? extractToolCommandOrAction(toolName, rawInput) : undefined;

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

    switch (hookEvent) {
      case 'SessionStart':
        return {
          ...base,
          type: 'session_started',
          title: folderName,
        };
      case 'UserPromptSubmit': {
        const prompt = typeof p.prompt === 'string' ? p.prompt.trim() : '';
        const title = prompt ? prompt.split(/\r?\n/)[0].slice(0, 64) : undefined;
        return {
          ...base,
          type: 'prompt_submitted',
          title,
        };
      }
      case 'PreToolUse':
        return {
          ...base,
          type: 'working',
          toolName: toolName || 'Tool',
          commandOrAction,
          rawInput,
        };
      case 'PermissionRequest':
        return {
          ...base,
          type: 'permission_requested',
          requestId: crypto.randomUUID(),
          toolName: toolName || 'Tool',
          commandOrAction: commandOrAction || toolName || 'Action',
          rawInput,
          readOnlyInTerminal: false,
        };
      case 'Notification': {
        const nType = String(p.notification_type || '');
        const msg = typeof p.message === 'string' ? p.message : undefined;
        if (nType === 'auth_success') return null;
        if (nType === 'permission_prompt') {
          // PermissionRequest hook handles interactive approval; ignore duplicate notification unless needed.
          return null;
        }
        return {
          ...base,
          type: 'needs_input',
          summary: msg,
        };
      }
      case 'Stop':
        return {
          ...base,
          type: 'turn_finished',
          lastAssistantMessage:
            typeof p.last_assistant_message === 'string' ? p.last_assistant_message : undefined,
        };
      case 'StopFailure':
        return {
          ...base,
          type: 'error',
          errorMessage:
            String(p.error_message || p.error || p.error_type || 'Turn failed with API error'),
        };
      case 'SessionEnd':
        return {
          ...base,
          type: 'session_ended',
        };
      default:
        return null;
    }
  }
}

export function resolveHookBinaryPath(appResourcesPath?: string): string {
  const isWin = process.platform === 'win32';
  const archFolder = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
  const binName = isWin ? `${HOOK_BINARY_NAME}.exe` : HOOK_BINARY_NAME;

  const candidates = [
    appResourcesPath ? path.join(appResourcesPath, 'bin', isWin ? archFolder : '', binName) : '',
    path.resolve(process.cwd(), 'resources', 'bin', isWin ? archFolder : '', binName),
    path.resolve(__dirname, '..', '..', '..', 'resources', 'bin', isWin ? archFolder : '', binName),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}
