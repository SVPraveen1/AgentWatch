"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PosixDevPlatformDriver = exports.Win32PlatformDriver = void 0;
exports.resolveWin32HelperPath = resolveWin32HelperPath;
exports.createPlatformDriver = createPlatformDriver;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_util_1 = require("node:util");
const constants_1 = require("../../shared/constants");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
function resolveWin32HelperPath(appResourcesPath) {
    const archFolder = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
    const candidates = [
        appResourcesPath ? node_path_1.default.join(appResourcesPath, 'bin', archFolder, `${constants_1.WIN32_HELPER_NAME}.exe`) : '',
        node_path_1.default.resolve(process.cwd(), 'resources', 'bin', archFolder, `${constants_1.WIN32_HELPER_NAME}.exe`),
        node_path_1.default.resolve(__dirname, '..', '..', '..', 'resources', 'bin', archFolder, `${constants_1.WIN32_HELPER_NAME}.exe`),
    ].filter(Boolean);
    return candidates.find((c) => node_fs_1.default.existsSync(c)) ?? candidates[0];
}
class Win32PlatformDriver {
    helperExePath;
    constructor(helperExePath) {
        this.helperExePath = helperExePath;
    }
    async runHelper(args) {
        const { stdout } = await execFileAsync(this.helperExePath, args, {
            timeout: 4000,
            windowsHide: true,
        });
        return JSON.parse(stdout.trim() || '{}');
    }
    async listProcesses() {
        try {
            const list = await this.runHelper(['processes']);
            return Array.isArray(list) ? list : [];
        }
        catch {
            return [];
        }
    }
    async listTcpListeners() {
        try {
            const list = await this.runHelper(['tcp-listeners']);
            return Array.isArray(list) ? list : [];
        }
        catch {
            return [];
        }
    }
    async getCommandLinesForPids(pids) {
        const unique = Array.from(new Set(pids.filter((p) => p > 0)));
        if (unique.length === 0)
            return {};
        const filter = unique.map((p) => `ProcessId=${p}`).join(' OR ');
        const psCmd = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
        try {
            const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { timeout: 3500, windowsHide: true });
            const trimmed = stdout.trim();
            if (!trimmed)
                return {};
            const parsed = JSON.parse(trimmed);
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            const out = {};
            for (const row of rows) {
                if (row.ProcessId && row.CommandLine) {
                    out[row.ProcessId] = row.CommandLine;
                }
            }
            return out;
        }
        catch {
            return {};
        }
    }
    async resolveTerminalRef(pid) {
        try {
            const res = await this.runHelper(['resolve-terminal', '--pid', String(pid)]);
            if (!res.ok)
                return null;
            return {
                hwnd: res.hwnd,
                pid: res.pid,
                processName: res.processName,
                title: res.title,
            };
        }
        catch {
            return null;
        }
    }
    async focusTerminal(pid, ref) {
        const args = ['focus-terminal'];
        if (pid)
            args.push('--pid', String(pid));
        if (ref?.hwnd)
            args.push('--hwnd', ref.hwnd);
        if (!pid && !ref?.hwnd) {
            return { ok: false, error: 'No terminal process or window handle recorded for this session.' };
        }
        try {
            return await this.runHelper(args);
        }
        catch (err) {
            return { ok: false, error: `Could not focus terminal window: ${String(err)}` };
        }
    }
    async isForegroundFullscreen() {
        try {
            const res = await this.runHelper(['is-fullscreen']);
            return Boolean(res.fullscreen);
        }
        catch {
            return false;
        }
    }
    async killProcessTree(pid) {
        try {
            await this.runHelper(['kill-tree', '--pid', String(pid)]);
            return { ok: true };
        }
        catch (err) {
            return { ok: false, message: String(err) };
        }
    }
}
exports.Win32PlatformDriver = Win32PlatformDriver;
class PosixDevPlatformDriver {
    async listProcesses() {
        try {
            const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 2000 });
            const out = [];
            for (const line of stdout.split(/\r?\n/)) {
                const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
                if (!m)
                    continue;
                out.push({
                    pid: Number(m[1]),
                    ppid: Number(m[2]),
                    exeName: node_path_1.default.basename(m[3].trim()),
                });
            }
            return out;
        }
        catch {
            return [];
        }
    }
    async listTcpListeners() {
        try {
            const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P', '-F', 'pn'], {
                timeout: 2000,
            });
            const out = [];
            let currentPid = 0;
            for (const line of stdout.split(/\r?\n/)) {
                if (line.startsWith('p')) {
                    currentPid = Number(line.slice(1));
                }
                else if (line.startsWith('n') && currentPid > 0) {
                    const idx = line.lastIndexOf(':');
                    if (idx !== -1) {
                        const port = Number(line.slice(idx + 1));
                        const host = line.slice(1, idx) || '127.0.0.1';
                        if (port > 0)
                            out.push({ pid: currentPid, port, host });
                    }
                }
            }
            return out;
        }
        catch {
            return [];
        }
    }
    async getCommandLinesForPids(pids) {
        if (pids.length === 0)
            return {};
        try {
            const { stdout } = await execFileAsync('ps', ['-p', pids.join(','), '-o', 'pid=,args='], {
                timeout: 2000,
            });
            const out = {};
            for (const line of stdout.split(/\r?\n/)) {
                const m = line.trim().match(/^(\d+)\s+(.+)$/);
                if (m)
                    out[Number(m[1])] = m[2].trim();
            }
            return out;
        }
        catch {
            return {};
        }
    }
    async resolveTerminalRef(pid) {
        return pid > 0 ? { pid, processName: 'Terminal' } : null;
    }
    async focusTerminal(pid) {
        if (!pid) {
            return { ok: false, error: 'No terminal PID recorded for this session.' };
        }
        return {
            ok: false,
            pid,
            error: 'Win32 terminal focusing runs natively on Windows (simulated environment on macOS/Linux).',
        };
    }
    async isForegroundFullscreen() {
        return false;
    }
    async killProcessTree(pid) {
        try {
            const procs = await this.listProcesses();
            const childrenByParent = new Map();
            for (const p of procs) {
                const list = childrenByParent.get(p.ppid) ?? [];
                list.push(p.pid);
                childrenByParent.set(p.ppid, list);
            }
            const toKill = [];
            const stack = [pid];
            while (stack.length > 0) {
                const cur = stack.pop();
                toKill.push(cur);
                for (const ch of childrenByParent.get(cur) ?? []) {
                    stack.push(ch);
                }
            }
            for (const target of toKill.reverse()) {
                try {
                    process.kill(target, 'SIGTERM');
                }
                catch {
                    // Ignore exited processes.
                }
            }
            return { ok: true };
        }
        catch (err) {
            return { ok: false, message: String(err) };
        }
    }
}
exports.PosixDevPlatformDriver = PosixDevPlatformDriver;
function createPlatformDriver(appResourcesPath) {
    if (process.platform === 'win32') {
        return new Win32PlatformDriver(resolveWin32HelperPath(appResourcesPath));
    }
    return new PosixDevPlatformDriver();
}
