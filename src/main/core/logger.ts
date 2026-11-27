import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from '../../shared/types';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB limit before rotation

export class AppLogger {
  readonly logsDir: string;
  private readonly logFile: string;
  private readonly backupFile: string;
  private level: LogLevel;

  constructor(dataDir: string, initialLevel: LogLevel = 'info') {
    this.logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(this.logsDir, { recursive: true });
    this.logFile = path.join(this.logsDir, 'agentwatch.log');
    this.backupFile = path.join(this.logsDir, 'agentwatch.log.1');
    this.level = initialLevel;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(scope: string, message: string, meta?: unknown): void {
    this.write('debug', scope, message, meta);
  }

  info(scope: string, message: string, meta?: unknown): void {
    this.write('info', scope, message, meta);
  }

  warn(scope: string, message: string, meta?: unknown): void {
    this.write('warn', scope, message, meta);
  }

  error(scope: string, message: string, meta?: unknown): void {
    this.write('error', scope, message, meta);
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.logFile)) return;
      const stats = fs.statSync(this.logFile);
      if (stats.size >= MAX_LOG_SIZE) {
        if (fs.existsSync(this.backupFile)) {
          fs.unlinkSync(this.backupFile);
        }
        fs.renameSync(this.logFile, this.backupFile);
      }
    } catch {
      // Never crash if rotation fails
    }
  }

  private write(level: LogLevel, scope: string, message: string, meta?: unknown): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) {
      return;
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      ...(meta !== undefined ? { meta } : {}),
    });
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.logFile, line + '\n', 'utf8');
    } catch {
      // Never crash app on logging failure.
    }
  }
}
