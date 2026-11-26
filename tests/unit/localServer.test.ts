import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../../src/main/adapters/claudeCodeAdapter';
import { AdapterRegistry } from '../../src/main/adapters/registry';
import { LocalServer } from '../../src/main/core/localServer';
import { AppLogger } from '../../src/main/core/logger';
import { SecureSecretStore } from '../../src/main/core/secureStore';
import { SessionStore } from '../../src/main/core/sessionStore';

function request(
  port: number,
  pathName: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathName, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('LocalServer security and SessionStore', () => {
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

  it('enforces loopback, auth token, and rejects Origin headers while recording events', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-srv-'));
    dirs.push(tmp);
    const logger = new AppLogger(tmp, 'error');
    const secretStore = new SecureSecretStore(tmp);
    const sessions = new SessionStore(tmp);
    const registry = new AdapterRegistry();
    registry.register(new ClaudeCodeAdapter());

    activeServer = new LocalServer({
      dataDir: tmp,
      logger,
      secretStore,
      normalizeHookEnvelope: (env) => registry.normalize(env),
      onNormalizedEvent: async (ev) => {
        sessions.applyEvent(ev);
        return { ok: true };
      },
    });

    const discovery = await activeServer.start();
    expect(discovery.address).toBe('127.0.0.1');
    expect(fs.existsSync(path.join(tmp, 'server.json'))).toBe(true);

    // Missing token -> 401
    const unauth = await request(discovery.port, '/health', 'GET', {});
    expect(unauth.status).toBe(401);

    // Browser Origin header -> 403 even with valid token
    const withOrigin = await request(discovery.port, '/health', 'GET', {
      'X-AgentWatch-Token': discovery.token,
      Origin: 'http://evil.example',
    });
    expect(withOrigin.status).toBe(403);

    // Valid token -> ingests event and updates SessionStore
    const payload = JSON.stringify({
      agent: 'claude_code',
      hookEvent: 'Stop',
      payload: {
        session_id: 's-123',
        cwd: '/Users/dev/billing',
        hook_event_name: 'Stop',
        last_assistant_message: 'Done',
      },
    });
    const okRes = await request(
      discovery.port,
      '/events',
      'POST',
      {
        'Content-Type': 'application/json',
        'X-AgentWatch-Token': discovery.token,
      },
      payload,
    );
    expect(okRes.status).toBe(200);
    expect(sessions.getSessions()).toHaveLength(1);
    expect(sessions.getSessions()[0].state).toBe('done');
    expect(sessions.getSessions()[0].folderName).toBe('billing');
  });
});
