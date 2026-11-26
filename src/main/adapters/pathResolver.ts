import os from 'node:os';
import path from 'node:path';

export interface AgentPaths {
  claudeDir: string;
  claudeSettingsFile: string;
  claudeProjectsDir: string;
  claudeManagedInstructionsFile: string;
  codexHomeDir: string;
  codexConfigFile: string;
  codexHooksFile: string;
  codexSessionsDir: string;
  codexManagedInstructionsFile: string;
}

export interface PathResolverOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  wsl?: {
    enabled: boolean;
    distro: string;
    linuxUser?: string;
  };
}

/**
 * Resolves agent config and log locations cleanly for native Windows, macOS/Linux dev,
 * and optional WSL UNC paths (\\wsl.localhost\<distro>\home\<user>\... or \\wsl$\...).
 */
export function resolveAgentPaths(options: PathResolverOptions = {}): AgentPaths {
  const env = options.env ?? process.env;
  let homeDir = options.homeDir || env.USERPROFILE || env.HOME || os.homedir();

  if (options.wsl?.enabled && options.wsl.distro.trim()) {
    const distro = options.wsl.distro.trim();
    const user = (options.wsl.linuxUser || env.USER || env.USERNAME || 'user').trim();
    homeDir = `\\\\wsl$\\${distro}\\home\\${user}`;
  }

  const isWinStyle = homeDir.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(homeDir);
  const joiner = isWinStyle ? path.win32.join : path.join;

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
export function formatHookCommand(executablePath: string, args: string[]): string {
  const normalizedExe = process.platform === 'win32'
    ? executablePath
    : executablePath;
  const quotedExe = normalizedExe.includes(' ') || /["&|<>^()]/.test(normalizedExe)
    ? `"${normalizedExe.replace(/"/g, '\\"')}"`
    : normalizedExe;
  const escapedArgs = args.map((a) => (a.includes(' ') ? `"${a}"` : a));
  return [quotedExe, ...escapedArgs].join(' ');
}

export function getFolderNameFromCwd(cwd: string): string {
  if (!cwd) return 'unknown';
  const cleaned = cwd.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned || 'unknown';
}
