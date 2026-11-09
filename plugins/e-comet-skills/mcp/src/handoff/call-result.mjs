import { HandoffError } from './hook-io.mjs';
import { ToolExecutionError } from '../shared/coded-error.mjs';
import { isRecord } from '../shared/values.mjs';
import { MAX_BROWSER_JOB_TOKEN_BYTES } from '../transport/mcp/limits.mjs';
const MAX_TRIGGER_URL_BYTES = 131072;
const byteLength = (value) => Buffer.byteLength(value, 'utf8');
export const validateTriggerUrl = (triggerUrl) => {
    if (typeof triggerUrl !== 'string' || byteLength(triggerUrl) < 1 || byteLength(triggerUrl) > MAX_TRIGGER_URL_BYTES) {
        throw new HandoffError('HANDOFF_INVALID_TOKEN', 'The browser authorization result is invalid.');
    }
    return triggerUrl;
};
// Parse boundary: a host-handed tool result of any shape.
const collectTriggerUrlCandidates = (toolResponse) => {
    if (typeof toolResponse === 'string') {
        let parsed;
        try {
            parsed = JSON.parse(toolResponse);
        }
        catch {
            return [];
        }
        if (!isRecord(parsed))
            return [];
        return typeof parsed.trigger_url === 'string' ? [parsed.trigger_url] : [];
    }
    // Claude hands over a result of several blocks, and Cowork since 2026-10-31 also one of a single block, as the bare
    // block array.
    if (Array.isArray(toolResponse))
        return collectTriggerUrlCandidates({ content: toolResponse });
    if (!isRecord(toolResponse) || toolResponse.isError === true)
        return [];
    const candidates = [];
    for (const structured of [toolResponse.structuredContent, toolResponse.structured_content]) {
        if (isRecord(structured) && typeof structured.trigger_url === 'string') {
            candidates.push(structured.trigger_url);
        }
    }
    if (Array.isArray(toolResponse.content)) {
        for (const item of toolResponse.content) {
            if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string')
                continue;
            let parsed;
            try {
                parsed = JSON.parse(item.text);
            }
            catch {
                continue;
            }
            if (isRecord(parsed) && typeof parsed.trigger_url === 'string') {
                candidates.push(parsed.trigger_url);
            }
        }
    }
    return candidates;
};
// The form the host handed over when no token was found: types, field names and lengths, never a value.
// Parse boundary: describes any value without reading its content.
export const responseShape = (value, depth = 0) => {
    if (Array.isArray(value)) {
        return depth > 2
            ? `array[${value.length}]`
            : `array[${value.length}](${value
                .slice(0, 3)
                .map((item) => responseShape(item, depth + 1))
                .join(',')})`;
    }
    if (isRecord(value)) {
        const keys = Object.keys(value);
        if (depth > 2)
            return `object{${keys.length}}`;
        return `{${keys
            .slice(0, 12)
            .map((key) => (/^[A-Za-z_]{1,40}$/.test(key) ? `${key}:${responseShape(value[key], depth + 1)}` : '?'))
            .join(',')}}`;
    }
    return value === null ? 'null' : typeof value === 'string' ? `string(${value.length})` : typeof value;
};
export const extractTriggerUrl = (toolResponse) => {
    const candidates = collectTriggerUrlCandidates(toolResponse);
    if (candidates.length === 0)
        return null;
    const unique = [...new Set(candidates)];
    if (unique.length !== 1) {
        throw new HandoffError('HANDOFF_AMBIGUOUS_TOKEN', 'The browser authorization result is ambiguous.');
    }
    return validateTriggerUrl(unique[0]);
};
// A trigger URL that is not a browser job is the same failed handoff as a missing one (spec 7.2).
const unusableTriggerUrl = (what = 'not a usable browser job') => new ToolExecutionError('BROWSER_JOB_HANDOFF_REQUIRED', `Browser authorization handoff is required: the trigger URL the tool received is ${what}. Do not repeat browser_job; ` +
    'check the host hook handoff (e-comet-doctor), then let the user decide.', 'handoff', false);
export const extractBrowserJobToken = (value) => {
    if (typeof value !== 'string')
        throw unusableTriggerUrl();
    const input = value.trim();
    if (!input)
        throw unusableTriggerUrl();
    if (Buffer.byteLength(input, 'utf8') > MAX_BROWSER_JOB_TOKEN_BYTES)
        throw unusableTriggerUrl('too large to be a browser job');
    if (!input.includes('__agent_job')) {
        if (input.split('.').length !== 3)
            throw unusableTriggerUrl();
        return input;
    }
    const hashIndex = input.indexOf('#');
    const hash = hashIndex >= 0 ? input.slice(hashIndex + 1) : input.replace(/^#/, '');
    const token = new URLSearchParams(hash).get('__agent_job');
    if (!token || token.split('.').length !== 3)
        throw unusableTriggerUrl();
    return token;
};
// The host hook failed, not the marketplace: another browser_job only spends one more authorization the same way.
export const missingHandoff = () => new ToolExecutionError('BROWSER_JOB_HANDOFF_REQUIRED', 'Browser authorization handoff is required: the host plugin hook did not pass the signed authorization to this tool. ' +
    'In Codex this usually means the e-Comet hooks await approval again after a plugin update. ' +
    'For an mcp__remote-devices__ tool, pass trigger_url from the same browser_job result, unchanged, as triggerUrl and call this tool once more. ' +
    'Do not repeat browser_job until that is resolved.', 'handoff', false);
/** Scrub canonical results and their JSON text projections with caller-owned privacy rules. */
export function scrubPrivateResult(value, secrets, privateKeys, label) {
    const retained = secrets.filter((secret) => typeof secret === 'string' && secret !== '');
    function visit(item) {
        if (typeof item === 'string') {
            // Scalar text can be an identifier: parsing it would lose formatting or precision.
            // Containers and quoted JSON still need decoding to find escaped private values.
            if (/^\s*(?:\{|\[|")/u.test(item)) {
                try {
                    return JSON.stringify(visit(JSON.parse(item)));
                }
                catch {
                    /* Scrub malformed JSON as text. */
                }
            }
            // Prose embedding an escaped copy stays literal-only: "Escaped authorization inside prose"
            // in docs/architecture/residuals/signed-flow.md.
            return retained.reduce((text, secret) => text.split(secret).join(label), item);
        }
        if (Array.isArray(item))
            return item.map(visit);
        if (item === null || typeof item !== 'object')
            return item;
        return Object.fromEntries(Object.entries(item)
            .filter(([key]) => !privateKeys.has(key))
            .map(([key, entry]) => [key, visit(entry)]));
    }
    return visit(value);
}
