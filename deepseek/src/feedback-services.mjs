import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { serializeSessionLog } from '@deepseek-ai/dsh-session-log-export';
import { retryTransientFileOperation } from '../../plugins/e-comet-skills/hooks/transient-file-operation.mjs';
import { extractPreparedMetadata } from '../../plugins/e-comet-skills/hooks/feedback-handoff.mjs';
import { FEEDBACK_ARTIFACT_RETENTION_MS } from '../../plugins/e-comet-skills/mcp/src/config.mjs';
import { feedbackDiagnostics } from '../../plugins/e-comet-skills/mcp/src/feedback-diagnostics.mjs';

const unavailable = message => Object.assign(new Error(`FEEDBACK_TRANSCRIPT_UNAVAILABLE: ${message}`), { code: 'FEEDBACK_TRANSCRIPT_UNAVAILABLE' });

/** Human approval and current-session history are host services, never model-authored transport data. */
export function createNativeFeedbackServices(ctx, { dataDirectory }) {
  const root = resolve(dataDirectory, 'native-feedback-snapshots');
  const removeSnapshot = async directory => {
    if (!resolve(directory).startsWith(root + sep)) throw unavailable('The snapshot cleanup path is invalid.');
    try { await retryTransientFileOperation(() => rm(directory, { recursive: true, force: true })); }
    catch (error) {
      // Cleanup must preserve completed work. Retain only this owned snapshot on refusal;
      // no cross-session sweep: docs/local-agent-architecture.md#accepted-residuals.
      const logger = ctx.logger ?? console;
      logger.warn(`FEEDBACK_SNAPSHOT_CLEANUP_PENDING: The owned chat snapshot could not be removed. ${JSON.stringify(feedbackDiagnostics(error, 'transcript_read'))}`);
    }
  };
  const observe = async exec => {
    const query = ctx.get('sessionQuery');
    if (!query) throw unavailable('The native session reader is unavailable.');
    exec.signal.throwIfAborted();
    const header = exec.agent.session.header;
    let observation;
    try { observation = await query.observeSession(header.id, { signal: exec.signal, projectionMode: 'none' }); }
    catch {
      // The backend error can name session storage; denial reasons enter durable tool history.
      exec.signal.throwIfAborted();
      throw unavailable('The native session reader failed.');
    }
    if (observation.source !== 'live' || !isDeepStrictEqual(observation.header, header)) {
      observation[Symbol.dispose]();
      throw unavailable('The native snapshot does not match the current chat.');
    }
    return observation;
  };
  return {
    async prepared(exec) {
      // Recovery owns current-session receipts and arguments; diagnostic pairing excludes feedback
      // and authored arguments. Keep these boundaries separate: docs/local-agent-architecture.md#accepted-residuals.
      const observation = await observe(exec);
      const pending = new Map();
      let latest;
      try {
        const inherited = observation.inheritedEventCount ?? 0;
        if (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > observation.events.length) throw unavailable('The native session boundary is unavailable.');
        // A fork's inherited messages belong to its logical history, but its parent's
        // prepared artifact and approval never authorize the new child session.
        for (const record of observation.events.slice(inherited)) {
          exec.signal.throwIfAborted();
          const data = record.data;
          if (!data || typeof data !== 'object') continue;
          const direct = record.type === 'tool/call';
          const nested = record.type === 'tool/ptc-dispatch-start';
          if ((direct || nested) && data.name === 'mcp__e-comet-local__prepare_e_comet_feedback') {
            const id = direct ? data.callId : data.subCallId;
            if (typeof id !== 'string') continue;
            try { pending.set(`${direct ? 'direct' : 'ptc'}:${id}`, typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments); } catch { /* malformed history is not recovery evidence */ }
            continue;
          }
          const message = record.type === 'tool/result' ? data.message : record.type === 'tool/ptc-dispatch' ? data : undefined;
          if (!message || (record.type === 'tool/result' && message.role !== 'tool')
            || (record.type === 'tool/ptc-dispatch' && message.name !== 'mcp__e-comet-local__prepare_e_comet_feedback')) continue;
          const key = `${record.type === 'tool/result' ? 'direct' : 'ptc'}:${message.toolCallId ?? message.subCallId}`;
          const input = pending.get(key);
          pending.delete(key);
          if (!input || message.isError === true || !Number.isSafeInteger(record.time)
            || record.time > Date.now() + 5000 || Date.now() - record.time > FEEDBACK_ARTIFACT_RETENTION_MS) continue;
          try {
            const response = { content: message.content };
            const metadata = extractPreparedMetadata(response);
            if (metadata.kind === input.kind && metadata.transcriptIncluded === input.includeTranscript) latest = { metadata, input, response };
          } catch { /* only a committed successful prepared receipt qualifies */ }
        }
        return latest;
      } finally { observation[Symbol.dispose](); }
    },
    async requestConsent(exec, phase, includeTranscript) {
      const approval = ctx.get('approval');
      if (!approval) return 'unavailable';
      const history = includeTranscript ? 'с полной историей только этого чата, включая вызовы инструментов' : 'без истории чата';
      const english = includeTranscript ? 'with the complete history of this chat, including tool calls' : 'without chat history';
      const ru = phase === 'prepare' ? `Подготовить отчёт для поддержки e-Comet ${history}? Отправка потребует отдельного подтверждения.`
        : `Отправить подготовленный отчёт в поддержку e-Comet ${history}?`;
      // Capture the policy used by this request, before an answerer can change it.
      const policy = approval.overrideOf?.(exec.agent.session) ?? approval.config?.policy ?? 'ask';
      let outcome;
      try {
        outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
          reason: `e-Comet feedback ${phase}; includeTranscript=${includeTranscript}`,
          displayReason: { ru, en: phase === 'prepare' ? `Prepare an e-Comet support report ${english}? Sending requires separate approval.`
            : `Send the prepared report to e-Comet support ${english}?` } });
      } catch {
        // The backend error can name host storage; a failed request is the same as no approval service.
        exec.signal.throwIfAborted();
        return 'unavailable';
      }
      return outcome === 'rejected' && policy === 'never' ? 'policy-blocked' : outcome;
    },
    async snapshot(exec) {
      const observation = await observe(exec);
      let directory;
      try {
        // Require the current live object’s identity, not a caller-chosen filename or another stored chat.
        exec.signal.throwIfAborted();
        await mkdir(root, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(join(root, 'snapshot-'));
        const path = join(directory, 'session.jsonl');
        // Preserve original host records. The shared collector applies its documented complete-record tail budget.
        // Full export cost is accepted separately from the collector's tail bound:
        // docs/local-agent-architecture.md#accepted-residuals, "Native feedback full-session export cost".
        await writeFile(path, serializeSessionLog(observation.header, observation.events), { mode: 0o600 });
        exec.signal.throwIfAborted();
        return { path, async dispose() { await removeSnapshot(directory); } };
      } catch (error) {
        if (directory) await removeSnapshot(directory);
        if (exec.signal.aborted) throw exec.signal.reason;
        throw unavailable(error?.code === 'FEEDBACK_TRANSCRIPT_UNAVAILABLE' ? 'The native snapshot does not match the current chat.' : 'The current chat could not be read.');
      } finally {
        observation[Symbol.dispose]();
      }
    },
  };
}
