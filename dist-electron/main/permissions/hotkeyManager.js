"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionHotkeyManager = void 0;
exports.detectHotkeyConflicts = detectHotkeyConflicts;
const KNOWN_EDITOR_CONFLICTS = {
    'control+y': 'Conflicts with Redo (VS Code / Notepad / Word) and Yank in many editors.',
    'commandorcontrol+y': 'Conflicts with Redo in editors.',
    'control+shift+y': 'Conflicts with VS Code Debug Console shortcut.',
    'commandorcontrol+shift+y': 'Conflicts with VS Code Debug Console shortcut.',
    'control+n': 'Conflicts with New File / New Window in editors and browsers.',
    'commandorcontrol+n': 'Conflicts with New File / New Window in editors and browsers.',
    'control+c': 'Conflicts with Copy / SIGINT!',
    'control+v': 'Conflicts with Paste!',
    'control+s': 'Conflicts with Save!',
    'control+z': 'Conflicts with Undo!',
};
function detectHotkeyConflicts(hotkeys) {
    const warnings = [];
    const entries = [
        ['Allow', hotkeys.allow],
        ['Always Allow', hotkeys.alwaysAllow],
        ['Deny', hotkeys.deny],
    ];
    const seen = new Map();
    for (const [label, accel] of entries) {
        const norm = accel.trim().toLowerCase().replace(/\s+/g, '');
        if (!norm) {
            warnings.push(`${label} hotkey is empty.`);
            continue;
        }
        const prev = seen.get(norm);
        if (prev) {
            warnings.push(`${label} uses the same shortcut (${accel}) as ${prev}.`);
        }
        else {
            seen.set(norm, label);
        }
        if (KNOWN_EDITOR_CONFLICTS[norm]) {
            warnings.push(`${label} (${accel}): ${KNOWN_EDITOR_CONFLICTS[norm]}`);
        }
    }
    return warnings;
}
function getGlobalShortcut() {
    if (!process.versions.electron)
        return null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electronMod = require('electron');
        return electronMod.globalShortcut ?? null;
    }
    catch {
        return null;
    }
}
class PermissionHotkeyManager {
    logger;
    activeAccelerators = [];
    constructor(logger) {
        this.logger = logger;
    }
    sync(hasInteractivePending, hotkeys, handlers) {
        this.unregisterAll();
        if (!hasInteractivePending) {
            return;
        }
        const gs = getGlobalShortcut();
        if (!gs)
            return;
        const bindings = [
            [hotkeys.allow, handlers.onAllow],
            [hotkeys.alwaysAllow, handlers.onAlwaysAllow],
            [hotkeys.deny, handlers.onDeny],
        ];
        for (const [accel, fn] of bindings) {
            if (!accel.trim())
                continue;
            try {
                const ok = gs.register(accel, fn);
                if (ok) {
                    this.activeAccelerators.push(accel);
                }
                else {
                    this.logger.warn('hotkeys', `Global shortcut already claimed by another app: ${accel}`);
                }
            }
            catch (err) {
                this.logger.warn('hotkeys', `Invalid global shortcut: ${accel}`, String(err));
            }
        }
    }
    unregisterAll() {
        const gs = getGlobalShortcut();
        if (!gs) {
            this.activeAccelerators = [];
            return;
        }
        for (const accel of this.activeAccelerators) {
            try {
                gs.unregister(accel);
            }
            catch {
                // Ignore cleanup errors.
            }
        }
        this.activeAccelerators = [];
    }
}
exports.PermissionHotkeyManager = PermissionHotkeyManager;
