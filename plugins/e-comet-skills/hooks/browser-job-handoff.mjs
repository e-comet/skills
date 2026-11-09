import { moduleNameOf } from '../mcp/src/composition/module-names.composition.mjs';
import { failedEventResult, readBrowserJobEvent, runBrowserJobHook } from '../mcp/src/handoff/browser-job.mjs';
import { handlerVersionReader } from '../mcp/src/handoff/diagnostics.mjs';
import { createFileGrantStore } from '../mcp/src/handoff/grants/file-store.mjs';
import { isHookEntry, writeHookResult } from '../mcp/src/handoff/hook-io.mjs';
import { useModuleNames } from '../mcp/src/transport/failures/evidence.mjs';
useModuleNames(moduleNameOf);
const handlerVersion = handlerVersionReader(new URL('../.codex-plugin/plugin.json', import.meta.url));
// The hook's whole flow with the file grant store of the host's plugin data.
export const processHookEvent = (event, { env = process.env, ...options } = {}) => runBrowserJobHook(event, { store: createFileGrantStore({ env }), env, handlerVersion, ...options });
const main = async () => {
    let result;
    try {
        result = await processHookEvent(await readBrowserJobEvent(process.stdin));
    }
    catch (error) {
        result = failedEventResult(error);
    }
    writeHookResult(result);
};
if (isHookEntry(import.meta.url))
    await main();
