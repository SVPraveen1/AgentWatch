import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../../src/main/adapters/codexAdapter';
import { resolveAgentPaths } from '../../src/main/adapters/pathResolver';
import { parse as parseToml } from 'smol-toml';
import fixtures from '../fixtures/codex-hooks.json';

describe('CodexAdapter and comment-preserving TOML round-trip', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('respects CODEX_HOME, preserves TOML comments/formatting, and restores original on disconnect', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-codex-'));
    dirs.push(tmpRoot);
    const customCodexHome = path.join(tmpRoot, 'custom-codex-home');
    fs.mkdirSync(customCodexHome, { recursive: true });

    const originalToml = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'codex-config.toml'),
      'utf8',
    );
    const paths = resolveAgentPaths({
      homeDir: tmpRoot,
      env: { CODEX_HOME: customCodexHome },
    });
    expect(paths.codexConfigFile).toBe(path.join(customCodexHome, 'config.toml'));

    fs.writeFileSync(paths.codexConfigFile, originalToml, 'utf8');
    const existingHooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo user-codex-guard' }],
          },
        ],
      },
    };
    fs.writeFileSync(paths.codexHooksFile, JSON.stringify(existingHooks, null, 2) + '\n', 'utf8');

    const adapter = new CodexAdapter();
    const hookExe = 'C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\AgentWatch\\resources\\bin\\agentwatch-hook.exe';
    const status = await adapter.connect(paths, {
      hookExecutablePath: hookExe,
      askAgentsForSummaries: true,
      permissionTimeoutSeconds: 300,
    });

    expect(status.state).toBe('connected');
    expect(status.supportsBlockingPermissions).toBe(false);

    const patchedToml = fs.readFileSync(paths.codexConfigFile, 'utf8');
    expect(patchedToml).toContain('# User Codex configuration with comments that must survive round-trip');
    expect(patchedToml).toContain('# keep inline comment');
    const parsedPatched = parseToml(patchedToml) as Record<string, any>;
    expect(parsedPatched.notify[0]).toBe(hookExe);
    expect(parsedPatched.features.hooks).toBe(true);

    const patchedHooks = JSON.parse(fs.readFileSync(paths.codexHooksFile, 'utf8'));
    expect(patchedHooks.hooks.PreToolUse[0].hooks[0].command).toBe('echo user-codex-guard');
    expect(patchedHooks.hooks.PreToolUse.length).toBe(2);

    const disconnected = await adapter.disconnect(paths);
    expect(disconnected.hookPresent).toBe(false);

    const afterToml = fs.readFileSync(paths.codexConfigFile, 'utf8');
    expect(afterToml).toBe(originalToml);

    const afterHooks = JSON.parse(fs.readFileSync(paths.codexHooksFile, 'utf8'));
    expect(afterHooks).toEqual(existingHooks);
  });

  it('normalizes Codex notify and hook payloads cleanly', () => {
    const adapter = new CodexAdapter();
    const turn = adapter.normalizeHookEvent({
      agent: 'codex',
      hookEvent: 'notify',
      payload: fixtures.notifyTurnComplete,
      sentAt: 1000,
    });
    expect(turn?.type).toBe('turn_finished');
    expect(turn?.folderName).toBe('api-gateway');
    expect(turn?.lastAssistantMessage).toContain('AGENTWATCH_SUMMARY:');

    const tool = adapter.normalizeHookEvent({
      agent: 'codex',
      payload: fixtures.hookPreToolUse,
      sentAt: 1100,
    });
    expect(tool?.type).toBe('working');
    expect(tool?.commandOrAction).toBe('cargo test');

    const approval = adapter.normalizeHookEvent({
      agent: 'codex',
      hookEvent: 'notify',
      payload: {
        type: 'approval-requested',
        'thread-id': 't-9',
        cwd: 'C:\\repo\\web',
        command: 'pnpm db:push',
      },
      sentAt: 1200,
    });
    expect(approval?.type).toBe('permission_requested');
    expect(approval?.readOnlyInTerminal).toBe(true);
  });
});
