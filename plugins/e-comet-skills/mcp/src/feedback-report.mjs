import { FEEDBACK_KINDS } from './config.mjs';
import { FeedbackPreparationError } from './feedback-errors.mjs';
import { selectFeedbackDeviceSnapshot } from './feedback-device-diagnostics.mjs';
import { isFeedbackCallTimestamp, isFeedbackToolName, isFeedbackToolOutcome } from './feedback-tool-calls.mjs';

const FEEDBACK_KIND_SET = new Set(FEEDBACK_KINDS);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// How the device prepared the archive: signed by a trusted hook, or unsigned where no hook can change the call (Cowork).
// The device is the same either way, so this line is what tells the two hosts apart in a report.
const ROUTES = new Set(['native', 'unsigned']);
// The newest calls are the ones around the failure. One line is at most a timestamp, a 256-character
// name and a short outcome.
export const FEEDBACK_TOOL_CALLS_MAX = 100;
const TOOL_CALL_KEYS = new Set(['name', 'at', 'outcome']);

/**
 * The canonical line-ending fold every feedback report goes through before redaction. The trusted
 * hooks import it so a projection they measure cannot drift from the text the archive will hold:
 * measuring lone-CR text unfolded collapses a whole report into one header line.
 */
export const foldFeedbackLineEndings = (value) => value.replace(/\r\n?/g, '\n');

const normalizeText = (value) => {
    if (typeof value !== 'string') throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    const normalized = foldFeedbackLineEndings(value);
    if (CONTROL_CHARACTERS.test(normalized)) throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    return normalized;
};

const redactCookieValues = (value) =>
    value.replace(/\b(set-cookie|cookie)\s*:\s*([^\n]*)/gi, (_match, header, cookieText) => {
        const redacted = cookieText
            .split(';')
            .map((segment) => {
                const delimiter = segment.indexOf('=');
                return delimiter === -1 ? '[REDACTED]' : `${segment.slice(0, delimiter).trim()}=[REDACTED]`;
            })
            .join('; ');
        return `${header}: ${redacted}`;
    });

// Field and header names whose whole value is a credential.
const CREDENTIAL_NAMES = String.raw`authorization|proxy-authorization|(?:x-)?api[_-]?key|cookie|set-cookie`;
const JSON_CREDENTIAL_VALUE = new RegExp(String.raw`("(?:${CREDENTIAL_NAMES})"\s*:\s*)"(?:\\.|[^"\\])*"`, 'gi');
const CREDENTIAL_NAME = new RegExp(String.raw`^(?:${CREDENTIAL_NAMES})$`, 'i');
export const isCredentialName = (/** @type {string} */ name) => CREDENTIAL_NAME.test(name);

const redactJsonCredentialValues = (value) => value.replace(JSON_CREDENTIAL_VALUE, '$1"[REDACTED]"');

const redactAuthorizationHeaders = (value) =>
    value.replace(/\b(proxy-authorization|authorization)\s*:\s*([^\n]*)/gi, (_match, header, headerValue) =>
        /^bearer\s+/i.test(headerValue) ? `${header}: Bearer [REDACTED]` : `${header}: [REDACTED]`,
    );

export const redactFeedbackText = (value) => {
    if (typeof value !== 'string') throw new TypeError('Feedback text must be a string');
    return redactAuthorizationHeaders(redactCookieValues(redactJsonCredentialValues(value)))
        .replace(/\bbearer\s+[^\s;,]+/gi, 'Bearer [REDACTED]')
        // The already-redacted alternative comes first so a second pass cannot match ]-terminated
        // placeholder text as a fresh secret and append another bracket. This protects API-key
        // placeholders; wire fitting measures the next redaction pass without assuming global idempotence.
        .replace(/\b(?:x-)?api[_-]?key\s*([:=])\s*(?:\[REDACTED\]|[^\s;,&}\]]+)/gi, (_match, delimiter) => `api_key${delimiter}[REDACTED]`)
        .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
};

export const selectFeedbackDiagnostics = selectFeedbackDeviceSnapshot;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeToolCall = (entry) => {
    const call = typeof entry === 'string' ? { name: entry } : entry;
    if (!isRecord(call) || !isFeedbackToolName(call.name) || Object.keys(call).some((key) => !TOOL_CALL_KEYS.has(key))) {
        throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    }
    if (call.at !== undefined && !isFeedbackCallTimestamp(call.at)) throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    if (call.outcome !== undefined && !isFeedbackToolOutcome(call.outcome)) throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    return { name: redactFeedbackText(normalizeText(call.name)), at: call.at, outcome: call.outcome };
};

const normalizeToolCalls = (toolCalls) => {
    if (toolCalls === undefined) return [];
    if (!Array.isArray(toolCalls)) throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    return toolCalls.map(normalizeToolCall);
};

// A call whose result carried no closed field says so: a line that read like a healthy call would
// hide exactly the failures this list exists to show. `is_error` is the host's own flag on the result.
// The rendered outcome stays within 256 bytes: the fields go in this order and one that no longer fits is
// left out whole, so the cloud archive reserve for a hundred lines still holds.
const OUTCOME_FIELDS = ['status', 'isError', 'code', 'stage', 'cause', 'reason', 'bridgeCode', 'refusalCode', 'systemCode', 'marketplaceErrorCode',
    'stopReason', 'itemCode', 'itemStage'];
const MAX_OUTCOME_BYTES = 256;
const renderOutcome = (outcome) => {
    if (!outcome) return ': outcome unknown';
    let rendered = outcome.ok === undefined ? ':' : `: ok=${outcome.ok}`;
    for (const field of OUTCOME_FIELDS) {
        if (outcome[field] === undefined) continue;
        const part = field === 'isError' ? 'is_error' : `${field}=${outcome[field]}`;
        const next = `${rendered}${rendered === ':' ? ' ' : ', '}${part}`;
        if (Buffer.byteLength(next, 'utf8') <= MAX_OUTCOME_BYTES) rendered = next;
    }
    return rendered;
};

const renderToolCalls = (toolCalls, toolCallsTruncated) => {
    const omitted = Math.max(0, toolCalls.length - FEEDBACK_TOOL_CALLS_MAX);
    return [
        // Preparation reads a session bounded by the feedback package budget, so an oversized
        // session leaves only its newest records. Say so before anything else, including the
        // observation that the window held no recognized calls at all.
        ...(toolCallsTruncated === true ? ['Only the newest part of the session was read; earlier tool calls are not listed.'] : []),
        ...(omitted > 0 ? [`Only the newest ${FEEDBACK_TOOL_CALLS_MAX} tool calls are listed; ${omitted} earlier calls are omitted.`] : []),
        ...(toolCalls.length === 0
            ? ['No tool calls were available.']
            : toolCalls.slice(omitted).map(({ name, at, outcome }, index) => `${index + 1}. ${at ? `${at} ` : ''}${name}${renderOutcome(outcome)}`)),
    ];
};

// The client name, version and host runtime version are host-authored text entering the archive: they
// pass the same redaction as every authored string, before the diagnostics block and the host line alike.
const redactClientFacts = (selectedDiagnostics) => {
    const facts = selectedDiagnostics.diagnostics?.client?.facts;
    if (!facts) return selectedDiagnostics;
    const client = { ...selectedDiagnostics.diagnostics.client, facts: { ...facts,
        ...(facts.name === undefined ? {} : { name: redactFeedbackText(facts.name) }),
        ...(facts.version === undefined ? {} : { version: redactFeedbackText(facts.version) }),
        ...(facts.hostRuntimeVersion === undefined ? {} : { hostRuntimeVersion: redactFeedbackText(facts.hostRuntimeVersion) }) } };
    return { ...selectedDiagnostics, diagnostics: { ...selectedDiagnostics.diagnostics, client } };
};

const renderClient = (selectedDiagnostics) => {
    const facts = selectedDiagnostics.diagnostics?.client?.facts;
    if (!facts?.name) return 'client: unknown';
    return `client: ${facts.name}${facts.version ? ` ${facts.version}` : ''}${facts.hostRuntimeVersion ? ` (host runtime ${facts.hostRuntimeVersion})` : ''}`;
};

/** @param {{ kind?: string, summary?: string, details?: string, diagnostics?: unknown, includeTranscript?: boolean, route?: 'native' | 'unsigned', toolCalls?: Array<string | { name: string, at?: string, outcome?: object }>, toolCallsTruncated?: boolean }} input */
export const renderFeedbackReport = ({ kind, summary, details, diagnostics, includeTranscript, route = 'native', toolCalls, toolCallsTruncated } = {}) => {
    // WHY: report validation owns this safe category before transcript or artifact I/O can begin.
    if (!FEEDBACK_KIND_SET.has(kind)) throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    if (typeof includeTranscript !== 'boolean') throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    if (!ROUTES.has(route)) throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    const normalizedSummary = redactFeedbackText(normalizeText(summary));
    const normalizedDetails = redactFeedbackText(normalizeText(details));
    const selectedDiagnostics = redactClientFacts(selectFeedbackDiagnostics(diagnostics));
    const normalizedToolCalls = normalizeToolCalls(toolCalls);
    const report = [
        '<!-- e-comet-feedback:v1 -->',
        '# e-Comet issue report',
        '',
        '## Kind',
        kind,
        '',
        '## Summary',
        normalizedSummary,
        '',
        '## Details',
        normalizedDetails,
        '',
        '## Host',
        `route: ${route}`,
        renderClient(selectedDiagnostics),
        '',
        '## Current diagnostics',
        '```json',
        JSON.stringify(selectedDiagnostics),
        '```',
        '',
        '## Tool calls',
        ...renderToolCalls(normalizedToolCalls, toolCallsTruncated),
        '',
        '## Privacy',
        `Transcript: ${includeTranscript ? 'included' : 'not included'}`,
        '',
    ].join('\n');
    return Buffer.from(report, 'utf8');
};
