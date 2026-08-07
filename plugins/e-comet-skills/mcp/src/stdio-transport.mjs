import { MAX_MCP_MESSAGE_BYTES } from './config.mjs';

export const attachStdioTransport = ({
    input = process.stdin,
    handleMessage,
    sendError,
    onClose = () => undefined,
    maxMessageBytes = MAX_MCP_MESSAGE_BYTES,
}) => {
    let buffer = '';
    let discardingOversizedLine = false;
    let closed = false;

    input.setEncoding('utf8');
    const onData = (incomingChunk) => {
        let chunk = incomingChunk;
        if (discardingOversizedLine) {
            const newlineIndex = chunk.indexOf('\n');
            if (newlineIndex < 0) return;
            discardingOversizedLine = false;
            chunk = chunk.slice(newlineIndex + 1);
        }

        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > maxMessageBytes && !buffer.includes('\n')) {
            buffer = '';
            discardingOversizedLine = true;
            sendError(null, -32600, `MCP message exceeds ${maxMessageBytes} bytes`);
            return;
        }

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
            const rawLine = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (Buffer.byteLength(rawLine, 'utf8') > maxMessageBytes) {
                sendError(null, -32600, `MCP message exceeds ${maxMessageBytes} bytes`);
                continue;
            }
            const line = rawLine.trim();
            if (!line) continue;
            try {
                const message = JSON.parse(line);
                void Promise.resolve(handleMessage(message)).catch(() => {
                    try {
                        sendError(message?.id ?? null, -32603, 'Internal error');
                    } catch {
                        // The host may have already closed STDIO; there is no remaining response channel.
                    }
                });
            } catch {
                sendError(null, -32700, 'Parse error');
            }
        }
    };

    const handleClose = () => {
        if (closed) return;
        closed = true;
        onClose();
    };

    input.on('data', onData);
    input.on('end', handleClose);
    input.on('close', handleClose);
    return () => {
        closed = true;
        input.off('data', onData);
        input.off('end', handleClose);
        input.off('close', handleClose);
    };
};
