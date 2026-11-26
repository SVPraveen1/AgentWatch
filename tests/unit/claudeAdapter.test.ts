import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../../src/main/adapters/claudeCodeAdapter';
import { resolveAgentPaths } from '../../src/main/adapters/pathResolver';
import fixtures from '../fixtures/claude-hooks.json';

describe('ClaudeCodeAdapter', () => {
  it('merges hooks safely and restores original config functionally on disconnect', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-claude-home-'));
    try {
      const paths = resolveAgentPaths({ homeDir: tmpHome, env: {} });
      fs.mkdirSync(paths.claudeDir, { recursive: true });
      const original = {
        model: 'claude-sonnet-4-5',
        permissions: { allow: ['Read'] },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write',
              hooks: [{ type: 'command', command: 'echo user-hook' }],
            },
          ],
        },
      };
      fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify(original, null, 2) + '\n', 'utf8');

      const adapter = new ClaudeCodeAdapter();
      const hookPath = 'C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\AgentWatch\\resources\\bin\\agentwatch-hook.exe';
      const connected = await adapter.connect(paths, {
        hookExecutablePath: hookPath,
        askAgentsForSummaries: true,
        permissionTimeoutSeconds: 300,
      });

      expect(connected.state).toBe('connected');
      expect(connected.hookPresent).toBe(true);

      const merged = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8'));
      // Existing user hooks preserved
      expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe('echo user-hook');
      // AgentWatch hook added with quoted path containing spaces
      const awHook = merged.hooks.PermissionRequest[0].hooks[0];
      expect(awHook.command).toContain(`"${hookPath}"`);
      expect(awHook.timeout).toBe(335);

      // Backup was created before modification
      expect(fs.existsSync(`${paths.claudeSettingsFile}.agentwatch.bak`)).toBe(true);

      const disconnected = await adapter.disconnect(paths);
      expect(disconnected.hookPresent).toBe(false);
      const afterDisconnect = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8'));
      expect(afterDisconnect).toEqual(original);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('normalizes official Claude Code hook payloads accurately', () => {
    const adapter = new ClaudeCodeAdapter();
    const start = adapter.normalizeHookEvent({
      agent: 'claude_code',
      payload: fixtures.sessionStart,
      ppid: 4242,
      sentAt: 1000,
    });
    expect(start?.type).toBe('session_started');
    expect(start?.folderName).toBe('billing');
    expect(start?.pid).toBe(4242);

    const prompt = adapter.normalizeHookEvent({
      agent: 'claude_code',
      payload: fixtures.userPromptSubmit,
      sentAt: 1100,
    });
    expect(prompt?.type).toBe('prompt_submitted');
    expect(prompt?.title).toContain('Switch billing');

    const tool = adapter.normalizeHookEvent({
      agent: 'claude_code',
      payload: fixtures.preToolUse,
      sentAt: 1200,
    });
    expect(tool?.type).toBe('working');
    expect(tool?.commandOrAction).toBe('pnpm test');

    const perm = adapter.normalizeHookEvent({
      agent: 'claude_code',
      payload: fixtures.permissionRequest,
      sentAt: 1300,
    });
    expect(perm?.type).toBe('permission_requested');
    expect(perm?.commandOrAction).toBe('pnpm prisma migrate deploy');

    const stop = adapter.normalizeHookEvent({
      agent: 'claude_code',
      payload: fixtures.stop,
      sentAt: 1400,
    });
    expect(stop?.type).toBe('turn_finished');
    expect(stop?.lastAssistantMessage).toContain('AGENTWATCH_SUMMARY:');

    const fail = adapter.normalizeHookEvent({
      agent: 'claude_code',
      payload: fixtures.stopFailure,
      sentAt: 1500,
    });
    expect(fail?.type).toBe('error');
    expect(fail?.errorMessage).toBe('Rate limit exceeded');

    const end = adapter.normalizeHookEvent({
      agent: 'claude_code',
      payload: fixtures.sessionEnd,
      sentAt: 1600,
    });
    expect(end?.type).toBe('session_ended');
  });
});
