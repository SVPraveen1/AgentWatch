import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../../src/main/adapters/claudeCodeAdapter';
import { CodexAdapter } from '../../src/main/adapters/codexAdapter';
import { resolveAgentPaths } from '../../src/main/adapters/pathResolver';
import { AdapterRegistry } from '../../src/main/adapters/registry';
import { TokenAnalyticsEngine } from '../../src/main/analytics/tokenAnalytics';
import { LocalServer } from '../../src/main/core/localServer';
import { AppLogger } from '../../src/main/core/logger';
import { SecureSecretStore } from '../../src/main/core/secureStore';
import { SessionStore } from '../../src/main/core/sessionStore';
import { PermissionManager } from '../../src/main/permissions/permissionManager';
import { checkDestructiveCommand, RuleStore } from '../../src/main/permissions/ruleMatcher';
import { redactSecrets } from '../../src/main/summaries/sanitizer';
import { SettingsStore } from '../../src/main/core/settingsStore';
import { SUMMARY_CONTEXT_INSTRUCTION, SummaryPipeline } from '../../src/main/summaries/summaryPipeline';
import { computeOverlayBounds } from '../../src/main/windows/overlayGeometry';

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|go)$/.test(ent.name) && !ent.name.endsWith('_test.go')) out.push(full);
  }
  return out;
}

describe('M9 Hardening, security, spaces-in-path hook E2E, WSL, and multi-monitor', () => {
  const dirs: string[] = [];
  let activeServer: LocalServer | null = null;

  afterEach(async () => {
    if (activeServer) {
      await activeServer.stop();
      activeServer = null;
    }
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('contains zero outbound network URLs or telemetry calls in source', () => {
    const srcFiles = [
      ...listSourceFiles(path.resolve(__dirname, '..', '..', 'src')),
      ...listSourceFiles(path.resolve(__dirname, '..', '..', 'cmd')),
    ];
    for (const file of srcFiles) {
      const text = fs.readFileSync(file, 'utf8');
      // Only localhost / 127.0.0.1 URLs are allowed in runtime source.
      const urls = text.match(/https?:\/\/[^\s"'`)]+/gi) ?? [];
      for (const u of urls) {
        expect(u).toMatch(/^https?:\/\/(?:127\.0\.0\.1|localhost|\$\{?)/i);
      }
      expect(text).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it('resolves WSL UNC paths and computes multi-monitor / negative-coordinate overlay bounds', () => {
    const wslPaths = resolveAgentPaths({
      env: { USER: 'alice' },
      wsl: { enabled: true, distro: 'Ubuntu-24.04' },
    });
    expect(wslPaths.claudeSettingsFile).toBe('\\\\wsl$\\Ubuntu-24.04\\home\\alice\\.claude\\settings.json');
    expect(wslPaths.codexConfigFile).toBe('\\\\wsl$\\Ubuntu-24.04\\home\\alice\\.codex\\config.toml');

    const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
    const leftMonitor = { id: 2, bounds: { x: -2560, y: 120, width: 2560, height: 1440 } };
    const bounds = computeOverlayBounds({
      displays: [primary, leftMonitor],
      primaryDisplay: primary,
      monitorId: 2,
      offsetTop: 8,
      width: 440,
      height: 400,
    });
    expect(bounds).toEqual({
      x: -2560 + (2560 - 440) / 2,
      y: 128,
      width: 440,
      height: 400,
    });
  });

  it('parses 10,000-line JSONL with malformed lines cleanly via incremental cache', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-perf-'));
    dirs.push(tmp);
    const dataDir = path.join(tmp, 'data');
    const homeDir = path.join(tmp, 'home');
    const paths = resolveAgentPaths({ homeDir, env: {} });
    const proj = path.join(paths.claudeProjectsDir, 'C--big-repo');
    fs.mkdirSync(proj, { recursive: true });

    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      if (i % 50 === 0) {
        lines.push('{broken-json-line');
      } else {
        lines.push(
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-11-26T08:00:00.000Z',
            message: {
              id: `msg-${i}`,
              model: 'claude-sonnet-4-5',
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          }),
        );
      }
    }
    fs.writeFileSync(path.join(proj, 'huge.jsonl'), lines.join('\n') + '\n', 'utf8');

    const engine = new TokenAnalyticsEngine(dataDir);
    const nowMs = Date.parse('2026-11-26T12:00:00.000Z');
    const r1 = engine.buildReport(paths, 'this_month', nowMs);
    expect(r1.totalTokens).toBe(9800 * 15);
    // Second read hits mtime+size cache cleanly
    const r2 = engine.buildReport(paths, 'this_month', nowMs);
    expect(r2.totalTokens).toBe(9800 * 15);
  });

  it('runs compiled Go agentwatch-hook from a path containing spaces through blocking permission & summary pipeline', async () => {
    const hookSrc = path.resolve(__dirname, '..', '..', 'resources', 'bin', 'agentwatch-hook');
    if (!fs.existsSync(hookSrc)) {
      return;
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-e2e-'));
    dirs.push(tmp);
    const spacedDir = path.join(tmp, 'Program Files With Spaces', 'bin');
    fs.mkdirSync(spacedDir, { recursive: true });
    const spacedHook = path.join(spacedDir, 'agentwatch-hook');
    fs.copyFileSync(hookSrc, spacedHook);
    fs.chmodSync(spacedHook, 0o755);

    const dataDir = path.join(tmp, 'app data');
    fs.mkdirSync(dataDir, { recursive: true });
    const logger = new AppLogger(dataDir, 'error');
    const secretStore = new SecureSecretStore(dataDir);
    const sessions = new SessionStore(dataDir);
    const rules = new RuleStore(dataDir);
    const summaries = new SummaryPipeline();
    const registry = new AdapterRegistry();
    registry.register(new ClaudeCodeAdapter());
    registry.register(new CodexAdapter());

    const pm = new PermissionManager(rules, logger, {
      onQueueChanged: () => {},
      onResolved: () => {},
    });

    activeServer = new LocalServer({
      dataDir,
      logger,
      secretStore,
      normalizeHookEnvelope: (env) => registry.normalize(env),
      onNormalizedEvent: async (event, _env, registerDisconnect) => {
        if (event.type === 'turn_finished' || event.type === 'permission_requested') {
          event.summary = await summaries.generateSummary(event, {
            askAgents: true,
            llmSummarizerEnabled: false,
          });
        }
        sessions.applyEvent(event);
        if (event.type === 'prompt_submitted') {
          return {
            ok: true,
            stdoutJson: {
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: SUMMARY_CONTEXT_INSTRUCTION,
              },
            },
          };
        }
        if (event.type === 'permission_requested') {
          const { promise, cancelOnDisconnect } = pm.enqueue({
            requestId: event.requestId!,
            sessionId: event.sessionId,
            agent: event.agent,
            toolName: event.toolName!,
            commandOrAction: event.commandOrAction!,
            rawInput: event.rawInput ?? {},
            cwd: event.cwd,
            folderName: event.folderName,
            timeoutSeconds: 10,
          });
          registerDisconnect(cancelOnDisconnect);
          setTimeout(() => {
            pm.resolveTop('allow', false);
          }, 80);
          return promise;
        }
        return { ok: true };
      },
    });
    await activeServer.start();

    const runHook = (args: string[], stdinJson: object) =>
      new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn(spacedHook, args, {
          env: { ...process.env, AGENTWATCH_DATA_DIR: dataDir },
        });
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString('utf8');
        });
        child.on('close', (code) => resolve({ code, stdout: stdout.trim() }));
        child.stdin.write(JSON.stringify(stdinJson));
        child.stdin.end();
      });

    // 1. UserPromptSubmit returns Tier 1 summary injection context
    const promptOut = await runHook(['--agent', 'claude_code', '--event', 'UserPromptSubmit'], {
      session_id: 'e2e-1',
      cwd: '/repo/billing',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Fix tests',
    });
    expect(promptOut.code).toBe(0);
    expect(JSON.parse(promptOut.stdout).hookSpecificOutput.additionalContext).toContain('AGENTWATCH_SUMMARY:');

    // 2. PermissionRequest blocks until resolved, returns allow JSON
    const permOut = await runHook(['--agent', 'claude_code', '--event', 'PermissionRequest', '--wait'], {
      session_id: 'e2e-1',
      cwd: '/repo/billing',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
    });
    expect(permOut.code).toBe(0);
    expect(JSON.parse(permOut.stdout).hookSpecificOutput.decision.behavior).toBe('allow');

    // 3. Stop extracts AGENTWATCH_SUMMARY and strips secrets
    const stopOut = await runHook(['--agent', 'claude_code', '--event', 'Stop'], {
      session_id: 'e2e-1',
      cwd: '/repo/billing',
      hook_event_name: 'Stop',
      last_assistant_message: 'Done.\nAGENTWATCH_SUMMARY: Fixed tests without leaking sk-ant-secret1234567890123.',
    });
    expect(stopOut.code).toBe(0);
    const saved = sessions.getSession('e2e-1');
    expect(saved?.state).toBe('done');
    expect(saved?.summary).toContain('[REDACTED]');
    expect(saved?.summary).not.toContain('sk-ant-');
  });

  it('detects advanced destructive command patterns, split flags, and subshell wrappers', () => {
    // Split flags
    expect(checkDestructiveCommand('Bash', 'rm -r /some/dir -f').destructive).toBe(true);
    expect(checkDestructiveCommand('Bash', 'rm -f /some/dir -r').destructive).toBe(true);
    expect(checkDestructiveCommand('Bash', 'rm -R /some/dir').destructive).toBe(true);
    expect(checkDestructiveCommand('Bash', 'rm --recursive /dir --force').destructive).toBe(true);

    // PowerShell aliases and flags
    expect(checkDestructiveCommand('powershell', 'ri -r -fo C:\\Temp').destructive).toBe(true);
    expect(checkDestructiveCommand('powershell', 'Remove-Item -Recurse C:\\Temp').destructive).toBe(true);

    // Subshells and find
    expect(checkDestructiveCommand('Bash', 'bash -c "rm -rf /"').destructive).toBe(true);
    expect(checkDestructiveCommand('Bash', 'find . -name "*.log" -delete').destructive).toBe(true);

    // Dangerous git operations
    expect(checkDestructiveCommand('Bash', 'git checkout -f main').destructive).toBe(true);
    expect(checkDestructiveCommand('Bash', 'git branch -D feature').destructive).toBe(true);

    // Secret and auth file modifications
    expect(checkDestructiveCommand('Bash', 'echo "KEY=1" > .env').destructive).toBe(true);
    expect(checkDestructiveCommand('Bash', 'cat key.pub >> ~/.ssh/authorized_keys').destructive).toBe(true);
    expect(checkDestructiveCommand('Edit', 'Edit ~/.ssh/id_rsa').destructive).toBe(true);

    // Benign commands
    expect(checkDestructiveCommand('Bash', 'pnpm test').destructive).toBe(false);
    expect(checkDestructiveCommand('Bash', 'git status').destructive).toBe(false);
    expect(checkDestructiveCommand('Bash', 'npm run build').destructive).toBe(false);
  });

  it('redacts expanded secret types including Gemini, HuggingFace, private keys, and DB passwords', () => {
    const raw = [
      'Gemini key: AIzaSyD9x8K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y',
      'HF token: hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'Database: postgres://app_user:super_secret_pw123@db.prod.internal:5432/main',
      'Key: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain('AIzaSyD9x8K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y');
    expect(redacted).not.toContain('hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(redacted).not.toContain('super_secret_pw123');
    expect(redacted).not.toContain('MIIEowIBAAKCAQEA0');
    expect(redacted).toContain('postgres://app_user:[REDACTED]@db.prod.internal:5432/main');
  });

  it('sanitizes and bounds settings updates to prevent corruption', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-settings-sec-'));
    dirs.push(tmp);
    const store = new SettingsStore(tmp);

    // Attempt invalid/extreme values
    store.update({
      data: { retentionDays: -999 as unknown as number, logLevel: 'malicious' as unknown as any },
      permissions: { timeoutSeconds: 9999999 },
      overlay: { offsetTop: 9999 },
      wsl: { distro: 'Ubuntu; rm -rf /' },
    });

    const current = store.get();
    expect(current.data.retentionDays).toBe(1); // Clamped to min 1
    expect(current.data.logLevel).toBe('info'); // Fallback to safe default
    expect(current.permissions.timeoutSeconds).toBe(3600); // Clamped to max 3600
    expect(current.overlay.offsetTop).toBe(500); // Clamped to max 500
    expect(current.wsl.distro).toBe('Ubunturm-rf'); // Sanitized, no shell metacharacters
  });

  it('allows manual dismissal of active and ended sessions', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dismiss-'));
    dirs.push(tmp);
    const store = new SessionStore(tmp);

    store.applyEvent({
      id: 'ev-1',
      agent: 'claude_code',
      sessionId: 'sess-to-dismiss',
      timestamp: Date.now(),
      cwd: '/workspace/test',
      folderName: 'test',
      title: 'Session to dismiss',
      type: 'session_started',
    });

    expect(store.getSession('sess-to-dismiss')).toBeDefined();
    expect(store.getSessions().length).toBe(1);

    const dismissed = store.dismissSession('sess-to-dismiss');
    expect(dismissed).toBe(true);
    expect(store.getSession('sess-to-dismiss')).toBeUndefined();
    expect(store.getSessions().length).toBe(0);

    // Dismissing nonexistent session returns false cleanly
    expect(store.dismissSession('nonexistent')).toBe(false);
  });

  it('rotates log file when size threshold is reached', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-log-rot-'));
    dirs.push(tmp);
    const logger = new AppLogger(tmp, 'info');

    const logFile = path.join(logger.logsDir, 'agentwatch.log');
    const backupFile = path.join(logger.logsDir, 'agentwatch.log.1');

    // Create a 10MB dummy log file to trigger rotation on next write
    const bigChunk = Buffer.alloc(10 * 1024 * 1024, 'a');
    fs.writeFileSync(logFile, bigChunk);

    expect(fs.existsSync(backupFile)).toBe(false);
    expect(fs.statSync(logFile).size).toBeGreaterThanOrEqual(10 * 1024 * 1024);

    // Write next log line
    logger.info('test', 'Hello rotation');

    // Now backupFile should exist and logFile should be small
    expect(fs.existsSync(backupFile)).toBe(true);
    expect(fs.statSync(logFile).size).toBeLessThan(1024);
  });
});
