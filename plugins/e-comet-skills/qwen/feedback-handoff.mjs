#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isMainModule } from './entry-point.mjs';
import { processHookEvent, prepareInputWithTrustedTranscript } from '../hooks/feedback-handoff.mjs';
import { FEEDBACK_ARTIFACT_RETENTION_MS, MAX_MCP_MESSAGE_BYTES } from '../mcp/src/config.mjs';
import { sweepExpired } from '../mcp/src/file-retention.mjs';
import { loadHookSecret, verifyHookSignature } from '../mcp/src/hook-signature.mjs';
import { resolveQwenRuntimeEnv } from './runtime-env.mjs';

const PREPARE = 'prepare_e_comet_feedback';
const PREPARE_NAME = `mcp__e-comet-local__${PREPARE}`;
// Shared signatures admit a 4096-byte path; JSON can escape each byte to six
// characters. Reserve the fixed signature/session/time envelope as well.
const CONTEXT_MAX_BYTES = 6 * 4096 + 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashSession = session => {
    if (typeof session !== 'string' || !session.trim() || Buffer.byteLength(session) > 512) throw new Error('invalid native session');
    return createHash('sha256').update(session).digest('hex');
};
const contextDirectory = env => join(resolve(env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA), 'qwen-feedback-context-v1');
const contextFile = (env, session) => join(contextDirectory(env), `${hashSession(session)}.json`);
const denied = () => ({ exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: 'deny', permissionDecisionReason: 'FEEDBACK_QWEN_CONTEXT_UNAVAILABLE: The native Qwen feedback context could not be verified. No history was read or feedback sent. Check the Qwen plugin hooks before preparing this report again.' } }), stderr: '' });

async function stageContext(env, session, updated, nowMs) {
    const directory = contextDirectory(env);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('invalid context directory');
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    // Path provenance has the same useful lifetime as a prepared report. This is bounded
    // private-file retention, not a fresh-call authorization window or human-consent claim.
    await sweepExpired({ directory, ownName: name => /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name),
        retentionMs: FEEDBACK_ARTIFACT_RETENTION_MS, now: nowMs });
    const path = contextFile(env, session), temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify({ createdAt: nowMs, transcriptPath: updated.transcriptPath,
            feedbackSession: updated.feedbackSession, feedbackClaim: updated.feedbackClaim }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
}

async function readContext(env, session, nowMs) {
    const path = contextFile(env, session);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > CONTEXT_MAX_BYTES) throw new Error('invalid context');
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > CONTEXT_MAX_BYTES) throw new Error('oversized context');
    const value = JSON.parse(raw);
    if (!object(value) || Object.keys(value).sort().join(',') !== 'createdAt,feedbackClaim,feedbackSession,transcriptPath'
        || value.feedbackSession !== hashSession(session) || !Number.isSafeInteger(value.createdAt)
        || value.createdAt > nowMs + 5000 || nowMs - value.createdAt > FEEDBACK_ARTIFACT_RETENTION_MS) throw new Error('invalid context binding');
    const secret = await loadHookSecret({ env, create: false });
    if (!verifyHookSignature({ secret, tool: PREPARE, sessionHash: value.feedbackSession,
        fields: { transcriptPath: value.transcriptPath }, signature: value.feedbackClaim })) throw new Error('invalid context signature');
    return value.transcriptPath;
}

// The host hook attests only its native session's path. No report text, grant, prompt ID,
// or claim of exact-call/human-consent provenance is stored here. Qwen's hook prompt ID
// and MCP prompt ID differ; the shared signature intentionally has session scope.
export const processQwenFeedbackEvent = async (event, options = {}) => {
    const env = resolveQwenRuntimeEnv(options.env), nowMs = options.nowMs ?? Date.now();
    if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== PREPARE_NAME) {
        return processHookEvent(event, { ...options, env });
    }
    try {
        await rm(contextFile(env, event.session_id), { force: true });
        const normalized = { ...event,
            ...(event.transcript_path === '' ? { transcript_path: null } : {}),
            ...(event.transcriptPath === '' ? { transcriptPath: null } : {}) };
        prepareInputWithTrustedTranscript(normalized);
        const noHistory = normalized.tool_input.includeTranscript === false;
        const result = await processHookEvent(noHistory
            ? { ...normalized, transcript_path: undefined, transcriptPath: undefined } : normalized, { ...options, env });
        const output = result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : undefined;
        if (result.exitCode !== 0 || output?.permissionDecision !== 'allow') return result;
        if (!noHistory) await stageContext(env, event.session_id, output.updatedInput, nowMs);
        // Stock 0.25 drops updatedInput. Keep trusted fields private and let the proxy
        // call the shared handler with current authored arguments and verified context.
        return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }), stderr: '' };
    } catch { return denied(); }
};

export const prepareQwenFeedbackCall = async (event, options = {}) => {
    const env = resolveQwenRuntimeEnv(options.env), nowMs = options.nowMs ?? Date.now();
    if (event.tool_name !== PREPARE_NAME || event.tool_input?.includeTranscript !== true) {
        return processHookEvent(event, { ...options, env });
    }
    try {
        const transcript_path = await readContext(env, event.session_id, nowMs);
        return processHookEvent({ ...event, transcript_path }, { ...options, env });
    } catch { return denied(); }
};

if (isMainModule(import.meta.url)) {
    let result;
    try {
        const chunks = []; let bytes = 0;
        for await (const chunk of process.stdin) {
            bytes += chunk.length;
            if (bytes > 2 * MAX_MCP_MESSAGE_BYTES + 256 * 1024) throw new Error('oversized hook event');
            chunks.push(chunk);
        }
        result = await processQwenFeedbackEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { result = denied(); }
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
}
