"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_http_1 = __importDefault(require("node:http"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
function resolveDataDir() {
    if (process.env.AGENTWATCH_DATA_DIR)
        return process.env.AGENTWATCH_DATA_DIR;
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || node_path_1.default.join(node_os_1.default.homedir(), 'AppData', 'Roaming');
        return node_path_1.default.join(appData, 'AgentWatch');
    }
    if (process.platform === 'darwin') {
        return node_path_1.default.join(node_os_1.default.homedir(), 'Library', 'Application Support', 'AgentWatch');
    }
    return node_path_1.default.join(process.env.XDG_CONFIG_HOME || node_path_1.default.join(node_os_1.default.homedir(), '.config'), 'AgentWatch');
}
function readServerInfo() {
    const file = node_path_1.default.join(resolveDataDir(), 'server.json');
    if (!node_fs_1.default.existsSync(file)) {
        throw new Error(`AgentWatch is not running (missing ${file})`);
    }
    return JSON.parse(node_fs_1.default.readFileSync(file, 'utf8'));
}
async function postHook(info, agent, hookEvent, payload, waitMs = 5000) {
    const body = JSON.stringify({
        agent,
        hookEvent,
        payload,
        ppid: process.pid,
        pid: process.pid,
        sentAt: Date.now(),
    });
    return new Promise((resolve, reject) => {
        const req = node_http_1.default.request({
            host: info.address,
            port: info.port,
            path: '/events',
            method: 'POST',
            timeout: waitMs,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'X-AgentWatch-Token': info.token,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
                }
                catch {
                    resolve({});
                }
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('Request timed out'));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function run() {
    const args = process.argv.slice(2);
    const getArg = (name, fallback) => {
        const idx = args.indexOf(name);
        return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
    };
    const agent = (getArg('--agent', 'claude_code') === 'codex' ? 'codex' : 'claude_code');
    const scenario = getArg('--scenario', 'demo');
    const cwd = getArg('--cwd', process.platform === 'win32' ? 'C:\\Users\\dev\\billing' : '/tmp/demo-billing');
    const sessionId = getArg('--session', `sim-${agent}-${Date.now()}`);
    const info = readServerInfo();
    console.log(`[agentwatch-sim] Connecting to ${info.address}:${info.port} (agent=${agent}, scenario=${scenario})`);
    if (scenario === 'permission') {
        await postHook(info, agent, 'SessionStart', { session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' });
        await postHook(info, agent, 'UserPromptSubmit', { session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'Run database tests in billing' });
        console.log('[agentwatch-sim] Waiting for user permission decision in overlay (up to 60s)...');
        const decision = await postHook(info, agent, 'PermissionRequest', {
            session_id: sessionId,
            cwd,
            hook_event_name: 'PermissionRequest',
            tool_name: 'Bash',
            tool_input: { command: 'pnpm test --filter billing' },
        }, 65000);
        console.log('[agentwatch-sim] Permission response:', JSON.stringify(decision));
        await postHook(info, agent, 'Stop', {
            session_id: sessionId,
            cwd,
            hook_event_name: 'Stop',
            last_assistant_message: 'Tests executed.\nAGENTWATCH_SUMMARY: Ran billing test suite after approval and verified all checks pass.',
        });
        return;
    }
    if (scenario === 'error') {
        await postHook(info, agent, 'SessionStart', { session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' });
        await postHook(info, agent, 'StopFailure', {
            session_id: sessionId,
            cwd,
            hook_event_name: 'StopFailure',
            error_type: 'rate_limit',
            error_message: '429 Rate limit reached while analyzing workspace',
        });
        return;
    }
    // Default multi-step demo stream
    await postHook(info, agent, 'SessionStart', { session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' });
    await postHook(info, agent, 'UserPromptSubmit', { session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'Migrate billing plans and run tests' });
    await sleep(600);
    await postHook(info, agent, 'PreToolUse', {
        session_id: sessionId,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
    });
    await sleep(900);
    await postHook(info, agent, 'Stop', {
        session_id: sessionId,
        cwd,
        hook_event_name: 'Stop',
        last_assistant_message: 'Migration complete.\nAGENTWATCH_SUMMARY: Billing is on usage-based plans. Two migrations applied and all 38 tests pass.',
    });
    console.log('[agentwatch-sim] Demo scenario completed.');
}
run().catch((err) => {
    console.error('[agentwatch-sim] Failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
