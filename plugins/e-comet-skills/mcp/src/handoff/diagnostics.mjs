import { readFileSync } from 'node:fs';
import { isOneOf, isRecord } from '../shared/values.mjs';
const CAUSES = [
    'invalid_event',
    'invalid_input',
    'invalid_state',
    'state_missing',
    'storage_unavailable',
    'permission_denied',
    'expired',
    'missing',
    'ambiguous',
    'unsupported',
    'io_error',
    'internal_error',
    'unknown',
];
const SYSTEM_CODES = ['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOSPC', 'EDQUOT', 'EEXIST', 'EBUSY'];
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
// The installed plugin version from the manifest a hook root names, read once and only for a denial.
export const handlerVersionReader = (manifestUrl) => {
    let installedVersion;
    return () => {
        if (installedVersion === undefined) {
            try {
                const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
                const version = isRecord(manifest) ? manifest.version : undefined;
                installedVersion = typeof version === 'string' && version.length <= 64 && VERSION.test(version) ? version : null;
            }
            catch {
                installedVersion = null;
            }
        }
        return installedVersion ?? undefined;
    };
};
// What a denial adds to its record: its closed cause, the filesystem code behind it, and the installed handler version.
export const denialEvidence = (cause, systemCode, handlerVersion) => {
    const version = handlerVersion?.();
    return {
        ...(isOneOf(CAUSES, cause) ? { cause } : {}),
        ...(isOneOf(SYSTEM_CODES, systemCode) ? { systemCode } : {}),
        ...(version ? { handlerVersion: version } : {}),
    };
};
// The record in its fixed field order.
const projectEvidence = (evidence) => ({
    type: 'e_comet_hook_diagnostic',
    schemaVersion: 1,
    event: evidence.event,
    toolFamily: evidence.toolFamily,
    handler: evidence.handler,
    stage: evidence.stage,
    outcome: evidence.outcome,
    observedAt: evidence.observedAt,
    executionPlane: evidence.executionPlane,
    ...(evidence.cause === undefined ? {} : { cause: evidence.cause }),
    ...(evidence.systemCode === undefined ? {} : { systemCode: evidence.systemCode }),
    ...(evidence.handlerVersion === undefined ? {} : { handlerVersion: evidence.handlerVersion }),
});
// This is presentation-only evidence. It neither stores a receipt nor changes the
// authoritative decision, rewrite, replacement, exit status, or stderr channel.
// `evidence` is the record or a function that builds it, called only when the result can carry it.
export const withHookDiagnostic = (authoritativeResult, evidence) => {
    try {
        if (!authoritativeResult || authoritativeResult.exitCode !== 0 || authoritativeResult.stderr !== '')
            return authoritativeResult;
        const observed = typeof evidence === 'function' ? evidence() : evidence;
        const projected = projectEvidence(observed);
        const event = observed.event;
        const diagnostic = JSON.stringify(projected);
        let output = {};
        let hookSpecificOutput;
        if (authoritativeResult.stdout === '')
            hookSpecificOutput = { hookEventName: event };
        else {
            const parsed = JSON.parse(authoritativeResult.stdout);
            if (!isRecord(parsed) || !isRecord(parsed.hookSpecificOutput))
                return authoritativeResult;
            output = parsed;
            hookSpecificOutput = { ...parsed.hookSpecificOutput };
        }
        const prior = hookSpecificOutput.additionalContext;
        if (prior !== undefined && typeof prior !== 'string')
            return authoritativeResult;
        hookSpecificOutput.additionalContext = prior === undefined ? diagnostic : `${prior}\n${diagnostic}`;
        return { ...authoritativeResult, stdout: JSON.stringify({ ...output, hookSpecificOutput }) };
    }
    catch {
        return authoritativeResult;
    }
};
