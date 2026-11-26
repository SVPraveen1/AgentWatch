"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUMMARY_MAX_CHARS = exports.SUMMARY_MARKER_PREFIX = exports.DEFAULT_TURN_EXPAND_MS = exports.DEFAULT_PERMISSION_TIMEOUT_SECONDS = exports.DEFAULT_IDLE_TIMEOUT_MINUTES = exports.DEFAULT_RETENTION_DAYS = exports.FEATURE_FLAGS = exports.WIN32_HELPER_NAME = exports.HOOK_BINARY_NAME = exports.APP_ID = exports.APP_NAME = void 0;
/** Single constant for application branding so the app can be renamed cleanly. */
exports.APP_NAME = 'AgentWatch';
exports.APP_ID = 'com.agentwatch.desktop';
exports.HOOK_BINARY_NAME = 'agentwatch-hook';
exports.WIN32_HELPER_NAME = 'agentwatch-win32';
exports.FEATURE_FLAGS = {
    /** Dollar cost calculation and monetization UI are deferred for v1. */
    showCost: false,
};
exports.DEFAULT_RETENTION_DAYS = 90;
exports.DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
exports.DEFAULT_PERMISSION_TIMEOUT_SECONDS = 300;
exports.DEFAULT_TURN_EXPAND_MS = 6000;
exports.SUMMARY_MARKER_PREFIX = 'AGENTWATCH_SUMMARY:';
exports.SUMMARY_MAX_CHARS = 140;
