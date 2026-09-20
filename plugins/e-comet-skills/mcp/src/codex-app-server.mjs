import { spawn } from 'node:child_process';

const MAX_PROTOCOL_BYTES = 1024 * 1024;
const inspectionError = (reason, phase) => Object.assign(new Error('Codex configuration inspection failed.'), {
    code: 'CODEX_APP_SERVER_INSPECTION', reason, phase,
});
const processFailureReason = (/** @type {any} */ error) => error?.code === 'ENOENT' ? 'process_missing'
    : ['EACCES', 'EPERM'].includes(error?.code) ? 'permission_denied' : 'protocol_error';
const startupError = (error) => inspectionError(processFailureReason(error), 'startup');

// A bounded JSON-RPC request. Each query owns and closes its inspector process.
export const queryCodexAppServer = ({ args, method, params, timeoutMs, spawnProcess = spawn, clientName }) => new Promise((resolve, reject) => {
    let child;
    // The direct spawn resolves only native executables on Windows; the supported hosts put one on the
    // child PATH. See the accepted residual "Codex CLI reachable only through an npm shell shim".
    try { child = spawnProcess('codex', ['app-server', ...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
    catch (error) { reject(startupError(error)); return; }
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch { /* best effort */ }
        if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(inspectionError('timeout', 'response')), timeoutMs);
    child.on('error', (error) => {
        const reason = processFailureReason(error);
        finish(inspectionError(reason, reason === 'protocol_error' ? 'transport' : 'startup'));
    });
    child.stdin.on('error', () => finish(inspectionError('protocol_error', 'transport')));
    child.stdout.on('error', () => finish(inspectionError('protocol_error', 'transport')));
    child.on('close', () => finish(inspectionError('process_closed', 'response')));
    // Decode before concatenating: a multibyte sequence split across reads would otherwise become U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        if (settled) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_PROTOCOL_BYTES) { finish(inspectionError('response_too_large', 'response')); return; }
        for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0 || settled) break;
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            let response;
            try { response = JSON.parse(line); } catch { continue; }
            if (response.id === 1) {
                if (response.error) { finish(inspectionError('protocol_error', 'initialize')); return; }
                child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
                child.stdin.write(`${JSON.stringify({ id: 2, method, params })}\n`);
            } else if (response.id === 2) {
                if (response.error) finish(inspectionError('protocol_error', 'request'));
                else finish(undefined, response.result);
            }
        }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {
        clientInfo: { name: clientName, version: '1' }, capabilities: { experimentalApi: true },
    } })}\n`);
});
