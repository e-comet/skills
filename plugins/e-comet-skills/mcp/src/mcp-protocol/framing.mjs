export const sendMcp = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
};
export const mcpResult = (id, result) => sendMcp({ jsonrpc: '2.0', id, result });
export const mcpError = (id, code, message) => sendMcp({ jsonrpc: '2.0', id, error: { code, message } });
