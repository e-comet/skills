import { sanitizeClientInfo } from '../client-info.mjs';
import { isOneOf, isRecord } from '../../shared/values.mjs';
import { LATEST_MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../transport/mcp/limits.mjs';
// What tools/list publishes of a contract, in today's field order.
export const listedTool = ({ name, description, inputSchema, outputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    outputSchema,
    annotations,
});
// JSON-RPC routing (spec §6.3): the router only routes. `call` runs a known tool; the dispatcher (dispatcher.mts)
// supplies it. `session` keeps the client facts of the last initialize.
export const createRouter = ({ contracts, instructions, serverInfo, now, send, sendError, onInitialized, call }) => {
    const session = { clientInfo: null, protocolVersion: null, observedAt: null };
    const tools = contracts.map(listedTool);
    // Parse boundary: the message is the JSON the client sent; the checks below narrow it.
    const route = async (message) => {
        if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            if (isRecord(message) && message.id !== undefined)
                sendError(message.id, -32600, 'Invalid Request');
            return;
        }
        const id = message.id, method = message.method;
        const params = isRecord(message.params) ? message.params : undefined;
        if (method === 'notifications/initialized' || id === undefined)
            return;
        if (method === 'initialize') {
            const requestedProtocolVersion = params?.protocolVersion;
            session.protocolVersion = isOneOf(SUPPORTED_MCP_PROTOCOL_VERSIONS, requestedProtocolVersion)
                ? requestedProtocolVersion
                : LATEST_MCP_PROTOCOL_VERSION;
            session.clientInfo = sanitizeClientInfo(params?.clientInfo);
            session.observedAt = new Date(now()).toISOString();
            send(id, {
                protocolVersion: session.protocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo,
                instructions,
            });
            onInitialized();
            return;
        }
        if (method === 'ping') {
            send(id, {});
            return;
        }
        if (method === 'tools/list') {
            send(id, { tools });
            return;
        }
        if (method !== 'tools/call') {
            sendError(id, -32601, `Method not found: ${method}`);
            return;
        }
        const name = params?.name;
        if (typeof name !== 'string' || !contracts.some((contract) => contract.name === name)) {
            sendError(id, -32602, `Unknown tool: ${String(name)}`);
            return;
        }
        await call(name, params?.arguments ?? {}, { id });
    };
    return { route, session };
};
