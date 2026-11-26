"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalServer = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const settingsStore_1 = require("./settingsStore");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
class LocalServer {
    options;
    server = null;
    token;
    port = 0;
    serverJsonPath;
    constructor(options) {
        this.options = options;
        this.serverJsonPath = node_path_1.default.join(options.dataDir, 'server.json');
        const existing = options.secretStore.getSecret('localServerToken');
        if (existing && existing.length >= 32) {
            this.token = existing;
        }
        else {
            this.token = node_crypto_1.default.randomBytes(32).toString('hex');
            options.secretStore.setSecret('localServerToken', this.token);
        }
    }
    getAddressInfo() {
        return { address: '127.0.0.1', port: this.port, token: this.token };
    }
    async start() {
        if (this.server) {
            return {
                address: '127.0.0.1',
                port: this.port,
                token: this.token,
                pid: process.pid,
                startedAt: Date.now(),
            };
        }
        this.server = node_http_1.default.createServer((req, res) => {
            void this.handleRequest(req, res);
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                const addr = this.server.address();
                if (addr && typeof addr === 'object') {
                    this.port = addr.port;
                }
                resolve();
            });
        });
        const discovery = {
            address: '127.0.0.1',
            port: this.port,
            token: this.token,
            pid: process.pid,
            startedAt: Date.now(),
        };
        (0, settingsStore_1.atomicWriteFileSync)(this.serverJsonPath, JSON.stringify(discovery, null, 2) + '\n');
        try {
            node_fs_1.default.chmodSync(this.serverJsonPath, 0o600);
        }
        catch {
            // chmod may be a no-op on Windows.
        }
        this.options.logger.info('server', 'Local loopback server listening', { port: this.port });
        return discovery;
    }
    async stop() {
        try {
            if (node_fs_1.default.existsSync(this.serverJsonPath)) {
                node_fs_1.default.unlinkSync(this.serverJsonPath);
            }
        }
        catch {
            // Ignore cleanup errors on exit.
        }
        if (!this.server)
            return;
        await new Promise((resolve) => {
            this.server.close(() => resolve());
        });
        this.server = null;
    }
    async handleRequest(req, res) {
        // Reject browser / non-local origins strictly (section 4.13).
        if (req.headers.origin) {
            this.sendJson(res, 403, { ok: false, error: 'Origin header forbidden' });
            return;
        }
        const remoteAddr = req.socket.remoteAddress || '';
        if (remoteAddr !== '127.0.0.1' &&
            remoteAddr !== '::1' &&
            remoteAddr !== '::ffff:127.0.0.1') {
            this.sendJson(res, 403, { ok: false, error: 'Non-loopback client rejected' });
            return;
        }
        const headerToken = typeof req.headers['x-agentwatch-token'] === 'string'
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
                const parsed = JSON.parse(rawBody || '{}');
                let normalized = null;
                if (parsed.normalizedEvent && parsed.normalizedEvent.type) {
                    normalized = parsed.normalizedEvent;
                }
                else {
                    const agent = parsed.agent === 'codex' ? 'codex' : 'claude_code';
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
                let disconnectHandler = null;
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
            }
            catch (err) {
                this.options.logger.warn('server', 'Failed to process /events request', String(err));
                this.sendJson(res, 400, { ok: false, error: 'Invalid event payload' });
            }
            return;
        }
        this.sendJson(res, 404, { ok: false, error: 'Not found' });
    }
    readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let total = 0;
            req.on('data', (chunk) => {
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
    sendJson(res, status, body) {
        const json = JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        });
        res.end(json);
    }
}
exports.LocalServer = LocalServer;
function safeTokenEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length)
        return false;
    return node_crypto_1.default.timingSafeEqual(bufA, bufB);
}
