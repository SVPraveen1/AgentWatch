"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAgentPaths = resolveAgentPaths;
exports.formatHookCommand = formatHookCommand;
exports.getFolderNameFromCwd = getFolderNameFromCwd;
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * Resolves agent config and log locations cleanly for native Windows, macOS/Linux dev,
 * and optional WSL UNC paths (\\wsl.localhost\<distro>\home\<user>\... or \\wsl$\...).
 */
function resolveAgentPaths(options = {}) {
    const env = options.env ?? process.env;
    let homeDir = options.homeDir || env.USERPROFILE || env.HOME || node_os_1.default.homedir();
    if (options.wsl?.enabled && options.wsl.distro.trim()) {
        const distro = options.wsl.distro.trim();
        const user = (options.wsl.linuxUser || env.USER || env.USERNAME || 'user').trim();
        homeDir = `\\\\wsl$\\${distro}\\home\\${user}`;
    }
    const isWinStyle = homeDir.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(homeDir);
    const joiner = isWinStyle ? node_path_1.default.win32.join : node_path_1.default.join;
    const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || joiner(homeDir, '.claude');
    const codexHomeDir = env.CODEX_HOME?.trim() || joiner(homeDir, '.codex');
    return {
        claudeDir,
        claudeSettingsFile: joiner(claudeDir, 'settings.json'),
        claudeProjectsDir: joiner(claudeDir, 'projects'),
        claudeManagedInstructionsFile: joiner(claudeDir, 'CLAUDE.md'),
        codexHomeDir,
        codexConfigFile: joiner(codexHomeDir, 'config.toml'),
        codexHooksFile: joiner(codexHomeDir, 'hooks.json'),
        codexSessionsDir: joiner(codexHomeDir, 'sessions'),
        codexManagedInstructionsFile: joiner(codexHomeDir, 'AGENTS.md'),
    };
}
/**
 * Formats an executable path + arguments safely for Windows shells and paths with spaces.
 */
function formatHookCommand(executablePath, args) {
    const normalizedExe = process.platform === 'win32'
        ? executablePath
        : executablePath;
    const quotedExe = normalizedExe.includes(' ') || /["&|<>^()]/.test(normalizedExe)
        ? `"${normalizedExe.replace(/"/g, '\\"')}"`
        : normalizedExe;
    const escapedArgs = args.map((a) => (a.includes(' ') ? `"${a}"` : a));
    return [quotedExe, ...escapedArgs].join(' ');
}
function getFolderNameFromCwd(cwd) {
    if (!cwd)
        return 'unknown';
    const cleaned = cwd.replace(/[\\/]+$/, '');
    const parts = cleaned.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || cleaned || 'unknown';
}
