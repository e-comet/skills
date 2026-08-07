export const sendMcp = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
};

export const mcpResult = (id, result) => sendMcp({ jsonrpc: '2.0', id, result });

export const mcpError = (id, code, message) => sendMcp({ jsonrpc: '2.0', id, error: { code, message } });

export const textResult = (value, isError = false) => ({
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError,
});
