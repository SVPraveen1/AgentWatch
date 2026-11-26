"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.patchCodexConfigToml = patchCodexConfigToml;
exports.unpatchCodexConfigToml = unpatchCodexConfigToml;
exports.hasCodexConfigHook = hasCodexConfigHook;
const smol_toml_1 = require("smol-toml");
const MANAGED_TAG = '# agentwatch-managed';
const SAVED_NOTIFY_PREFIX = '# agentwatch-saved-notify:';
const FEATURES_CREATED_TAG = '# agentwatch-section';
function escapeTomlBasicString(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function formatTomlStringArray(items) {
    return `[${items.map((item) => `"${escapeTomlBasicString(item)}"`).join(', ')}]`;
}
function splitLinesPreserveNewlines(content) {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.length === 0 ? [] : content.split(/\r?\n/);
    // Remove trailing empty element produced by trailing newline so joins stay clean.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return { lines, eol };
}
/**
 * Finds the extent of a single or multi-line top-level `notify = [...]` statement before any [table].
 */
function findTopLevelNotifyRange(lines) {
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        if (trimmed.startsWith('[')) {
            // Top-level keys cannot appear after the first table header.
            return null;
        }
        if (/^notify\s*=/.test(trimmed)) {
            let depth = countBracketsOutsideStrings(lines[i]);
            let end = i;
            while (depth > 0 && end + 1 < lines.length) {
                end++;
                depth += countBracketsOutsideStrings(lines[end]);
            }
            return { start: i, end };
        }
    }
    return null;
}
function countBracketsOutsideStrings(line) {
    let depth = 0;
    let inDouble = false;
    let inSingle = false;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\' && inDouble) {
            escaped = true;
            continue;
        }
        if (!inSingle && ch === '"') {
            inDouble = !inDouble;
            continue;
        }
        if (!inDouble && ch === "'") {
            inSingle = !inSingle;
            continue;
        }
        if (inDouble || inSingle)
            continue;
        if (ch === '#')
            break;
        if (ch === '[')
            depth++;
        else if (ch === ']')
            depth--;
    }
    return depth;
}
function patchCodexConfigToml(originalContent, notifyCommandArgv, enableHooksFeature) {
    // First strip any prior AgentWatch edits so re-connecting is idempotent.
    const cleaned = unpatchCodexConfigToml(originalContent);
    const { lines, eol } = splitLinesPreserveNewlines(cleaned);
    const notifyLine = `notify = ${formatTomlStringArray(notifyCommandArgv)} ${MANAGED_TAG}`;
    const existingNotify = findTopLevelNotifyRange(lines);
    if (existingNotify) {
        const replacedBlock = lines.slice(existingNotify.start, existingNotify.end + 1).join('\n');
        const encoded = Buffer.from(replacedBlock, 'utf8').toString('base64');
        lines.splice(existingNotify.start, existingNotify.end - existingNotify.start + 1, `${SAVED_NOTIFY_PREFIX} ${encoded}`, notifyLine);
    }
    else {
        const firstTableIdx = lines.findIndex((l) => /^\s*\[/.test(l));
        if (firstTableIdx === -1) {
            lines.push(notifyLine);
        }
        else {
            lines.splice(firstTableIdx, 0, notifyLine, '');
        }
    }
    if (enableHooksFeature) {
        let featuresStart = -1;
        let featuresEnd = lines.length;
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed === '[features]' || trimmed.startsWith('[features] ')) {
                featuresStart = i;
                for (let j = i + 1; j < lines.length; j++) {
                    if (/^\s*\[/.test(lines[j])) {
                        featuresEnd = j;
                        break;
                    }
                }
                break;
            }
        }
        if (featuresStart === -1) {
            if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
                lines.push('');
            }
            lines.push(`[features] ${FEATURES_CREATED_TAG}`);
            lines.push(`hooks = true ${MANAGED_TAG}`);
        }
        else {
            let hasHooksKey = false;
            for (let i = featuresStart + 1; i < featuresEnd; i++) {
                const trimmed = lines[i].trim();
                if (!trimmed || trimmed.startsWith('#'))
                    continue;
                if (/^(?:hooks|codex_hooks)\s*=/.test(trimmed)) {
                    hasHooksKey = true;
                    break;
                }
            }
            if (!hasHooksKey) {
                lines.splice(featuresStart + 1, 0, `hooks = true ${MANAGED_TAG}`);
            }
        }
    }
    const out = lines.join(eol) + (lines.length > 0 ? eol : '');
    // Validate TOML syntax before returning so we never corrupt config.toml.
    (0, smol_toml_1.parse)(out);
    return out;
}
function unpatchCodexConfigToml(content) {
    const { lines, eol } = splitLinesPreserveNewlines(content);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith(SAVED_NOTIFY_PREFIX)) {
            const b64 = trimmed.slice(SAVED_NOTIFY_PREFIX.length).trim();
            try {
                const restored = Buffer.from(b64, 'base64').toString('utf8');
                out.push(...restored.split('\n'));
            }
            catch {
                // Ignore malformed backup comment.
            }
            continue;
        }
        if (line.includes(MANAGED_TAG)) {
            // Remove extra blank line we inserted after top-level notify before first [table]
            if (/^notify\s*=/.test(trimmed) &&
                i + 1 < lines.length &&
                lines[i + 1].trim() === '' &&
                i + 2 < lines.length &&
                /^\s*\[/.test(lines[i + 2])) {
                i++;
            }
            continue;
        }
        if (line.includes(FEATURES_CREATED_TAG)) {
            // Remove preceding blank line we added before created [features] block
            if (out.length > 0 && out[out.length - 1].trim() === '') {
                out.pop();
            }
            continue;
        }
        out.push(line);
    }
    const result = out.length > 0 ? out.join(eol) + eol : '';
    if (result.trim()) {
        (0, smol_toml_1.parse)(result);
    }
    return result;
}
function hasCodexConfigHook(content) {
    if (!content.trim())
        return false;
    try {
        const parsed = (0, smol_toml_1.parse)(content);
        const notify = parsed.notify;
        if (Array.isArray(notify) && notify.some((item) => String(item).toLowerCase().includes('agentwatch-hook'))) {
            return true;
        }
    }
    catch {
        return content.toLowerCase().includes('agentwatch-hook');
    }
    return false;
}
