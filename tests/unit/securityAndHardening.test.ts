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
import { RuleStore } from '../../src/main/permissions/ruleMatcher';
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
});
