import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// A refusal of the browser-job handoff: a closed code, a safe message, and the recovery its denial names.
export class HandoffError extends Error {
    constructor(code, message, recovery) {
        super(message);
        this.name = 'HandoffError';
        this.code = code;
        this.recovery = recovery;
    }
}
// The host hands one event as JSON on stdin; a larger or malformed one is refused with the flow's own error.
export const readHookEvent = async (input, { maxBytes, tooLarge, invalid }) => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of input) {
        bytes += chunk.length;
        if (bytes > maxBytes)
            throw tooLarge();
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
        return JSON.parse(text);
    }
    catch {
        throw invalid();
    }
};
// Claude and Codex send snake_case fields; some hosts send camelCase.
export const eventNameOf = (event) => event.hook_event_name ?? event.hookEventName;
export const toolNameOf = (event) => event.tool_name ?? event.toolName;
export const toolInputOf = (event) => event.tool_input ?? event.toolInput;
export const toolResponseOf = (event) => event.tool_response ?? event.toolResponse;
export const preToolUseOutput = (updatedInput) => JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput,
    },
});
export const writeHookResult = (result) => {
    if (result.stdout)
        process.stdout.write(`${result.stdout}\n`);
    if (result.stderr)
        process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
};
// True when the module at `moduleUrl` is the script the host started.
export const isHookEntry = (moduleUrl) => {
    const entry = process.argv[1];
    return entry ? pathToFileURL(resolve(entry)).href === moduleUrl : false;
};
