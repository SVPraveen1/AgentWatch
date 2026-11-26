"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppLogger = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const LEVEL_PRIORITY = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
class AppLogger {
    logsDir;
    logFile;
    level;
    constructor(dataDir, initialLevel = 'info') {
        this.logsDir = node_path_1.default.join(dataDir, 'logs');
        node_fs_1.default.mkdirSync(this.logsDir, { recursive: true });
        this.logFile = node_path_1.default.join(this.logsDir, 'agentwatch.log');
        this.level = initialLevel;
    }
    setLevel(level) {
        this.level = level;
    }
    debug(scope, message, meta) {
        this.write('debug', scope, message, meta);
    }
    info(scope, message, meta) {
        this.write('info', scope, message, meta);
    }
    warn(scope, message, meta) {
        this.write('warn', scope, message, meta);
    }
    error(scope, message, meta) {
        this.write('error', scope, message, meta);
    }
    write(level, scope, message, meta) {
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
            node_fs_1.default.appendFileSync(this.logFile, line + '\n', 'utf8');
        }
        catch {
            // Never crash app on logging failure.
        }
    }
}
exports.AppLogger = AppLogger;
