import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AgentId, NormalizedEvent } from '../../shared/types';
import type { RawHookEnvelope } from '../adapters/types';
import type { AppLogger } from './logger';
import type { SecureSecretStore } from './secureStore';
import { atomicWriteFileSync } from './settingsStore';

export interface ServerDiscoveryFile {
  address: string;
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export interface HookHandlingResult {
  ok: boolean;
  stdoutJson?: Record<string, unknown>;
  exitCode?: number;
  permissionStatus?: string;
}

export interface LocalServerOptions {
  dataDir: string;
  logger: AppLogger;
  secretStore: SecureSecretStore;
  normalizeHookEnvelope: (envelope: RawHookEnvelope) => NormalizedEvent | null;
  onNormalizedEvent: (
    event: NormalizedEvent,
    envelope: RawHookEnvelope,
    registerDisconnect: (cb: () => void) => void,
  ) => Promise<HookHandlingResult>;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class LocalServer {
  private server: http.Server | null = null;
  private token: string;
  private port = 0;
  private readonly serverJsonPath: string;

  constructor(private readonly options: LocalServerOptions) {
    this.serverJsonPath = path.join(options.dataDir, 'server.json');
    const existing = options.secretStore.getSecret('localServerToken');
    if (existing && existing.length >= 32) {
      this.token = existing;
    } else {
      this.token = crypto.randomBytes(32).toString('hex');
      options.secretStore.setSecret('localServerToken', this.token);
    }
  }

  getAddressInfo(): { address: string; port: number; token: string } {
    return { address: '127.0.0.1', port: this.port, token: this.token };
  }

  async start(): Promise<ServerDiscoveryFile> {
    if (this.server) {
      return {
        address: '127.0.0.1',
        port: this.port,
        token: this.token,
        pid: process.pid,
        startedAt: Date.now(),
      };
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
    });

    const discovery: ServerDiscoveryFile = {
      address: '127.0.0.1',
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt: Date.now(),
    };
    atomicWriteFileSync(this.serverJsonPath, JSON.stringify(discovery, null, 2) + '\n');
    try {
      fs.chmodSync(this.serverJsonPath, 0o600);
    } catch {
      // chmod may be a no-op on Windows.
    }
    this.options.logger.info('server', 'Local loopback server listening', { port: this.port });
    return discovery;
  }

  async stop(): Promise<void> {
    try {
      if (fs.existsSync(this.serverJsonPath)) {
        fs.unlinkSync(this.serverJsonPath);
      }
    } catch {
      // Ignore cleanup errors on exit.
    }
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Reject browser / non-local origins strictly (section 4.13).
    if (req.headers.origin) {
      this.sendJson(res, 403, { ok: false, error: 'Origin header forbidden' });
      return;
    }

    const remoteAddr = req.socket.remoteAddress || '';
    if (
      remoteAddr !== '127.0.0.1' &&
      remoteAddr !== '::1' &&
      remoteAddr !== '::ffff:127.0.0.1'
    ) {
      this.sendJson(res, 403, { ok: false, error: 'Non-loopback client rejected' });
      return;
    }

    const headerToken =
      typeof req.headers['x-agentwatch-token'] === 'string'
        ? req.headers['x-agentwatch-token']
        : typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
          ? req.headers.authorization.slice('Bearer '.length)
          : '';

    if (!safeTokenEqual(headerToken, this.token)) {
      this.sendJson(res, 401, { ok: false, error: 'Invalid or missing auth token' });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      this.sendJson(res, 200, { ok: true, pid: process.pid });
      return;
    }

    if (req.method === 'POST' && req.url === '/events') {
      try {
        const rawBody = await this.readBody(req);
        const parsed = JSON.parse(rawBody || '{}') as RawHookEnvelope & {
          normalizedEvent?: NormalizedEvent;
        };

        let normalized: NormalizedEvent | null = null;
        if (parsed.normalizedEvent && parsed.normalizedEvent.type) {
          normalized = parsed.normalizedEvent;
        } else {
          const agent: AgentId = parsed.agent === 'codex' ? 'codex' : 'claude_code';
          normalized = this.options.normalizeHookEnvelope({
            agent,
            hookEvent: parsed.hookEvent,
            payload: parsed.payload ?? {},
            argPayload: parsed.argPayload,
            ppid: parsed.ppid,
            pid: parsed.pid,
            sentAt: parsed.sentAt,
          });
        }

        if (!normalized) {
          this.sendJson(res, 200, { ok: true });
          return;
        }

        let disconnectHandler: (() => void) | null = null;
        res.on('close', () => {
          if (!res.writableEnded) {
            disconnectHandler?.();
          }
        });

        const result = await this.options.onNormalizedEvent(normalized, parsed, (cb) => {
          disconnectHandler = cb;
        });
        if (!res.writableEnded) {
          this.sendJson(res, 200, result);
        }
      } catch (err) {
        this.options.logger.warn('server', 'Failed to process /events request', String(err));
        this.sendJson(res, 400, { ok: false, error: 'Invalid event payload' });
      }
      return;
    }

    this.sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error('Body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(json);
  }
}

function safeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
