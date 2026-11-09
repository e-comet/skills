import { constants as zlibConstants, deflateRaw } from 'node:zlib';
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP_DEFLATE_METHOD = 8;
const ZIP_VERSION = 20;
const ZIP_VERSION_MADE_BY_UNIX = 0x0314;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021;
const REGULAR_FILE_ATTRIBUTES = 0x81a40000;
const CRC_CHUNK_BYTES = 64 * 1024;
const DEFLATE_OPTIONS = {
    level: 6,
    windowBits: 15,
    memLevel: 8,
    strategy: zlibConstants.Z_DEFAULT_STRATEGY,
};
const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    CRC32_TABLE[index] = value >>> 0;
}
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
const crc32 = async (bytes) => {
    let value = 0xffffffff;
    for (let offset = 0; offset < bytes.length; offset += CRC_CHUNK_BYTES) {
        const end = Math.min(bytes.length, offset + CRC_CHUNK_BYTES);
        for (let index = offset; index < end; index += 1) {
            value = (CRC32_TABLE[(value ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (value >>> 8);
        }
        // WHY: a maximum-sized transcript must not monopolize the MCP transport loop while its CRC is computed.
        if (end < bytes.length)
            await yieldToEventLoop();
    }
    return (value ^ 0xffffffff) >>> 0;
};
const deflateRawAsync = (bytes) => new Promise((resolve, reject) => {
    deflateRaw(bytes, DEFLATE_OPTIONS, (error, result) => {
        if (error)
            reject(error);
        else
            resolve(result);
    });
});
// Narrow read-only seams keep the two independent event-loop guarantees directly testable.
export const zipInternals = {
    crc32,
    deflateRaw: deflateRawAsync,
};
// The local and central headers of one entry; an archive adds them and one end record to its entry bytes.
export const zipEntryFramingBytes = (nameBytes) => 30 + nameBytes.length + 46 + nameBytes.length;
export const ZIP_END_RECORD_BYTES = 22;
const writeLocalHeader = ({ nameBytes, bytes, compressedBytes, method, crc }) => {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(ZIP_VERSION, 4);
    header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(FIXED_DOS_TIME, 10);
    header.writeUInt16LE(FIXED_DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressedBytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    return header;
};
const writeCentralHeader = ({ nameBytes, bytes, compressedBytes, method, crc, localOffset }) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(ZIP_VERSION_MADE_BY_UNIX, 4);
    header.writeUInt16LE(ZIP_VERSION, 6);
    header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(FIXED_DOS_TIME, 12);
    header.writeUInt16LE(FIXED_DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressedBytes.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(REGULAR_FILE_ATTRIBUTES, 38);
    header.writeUInt32LE(localOffset, 42);
    return header;
};
/** Writes entries in order, each deflated unless deflating expands it, with fixed times and no comment. */
export const writeZip = async (entries) => {
    const preparedEntries = [];
    for (const entry of entries) {
        const [deflated, crc] = await Promise.all([zipInternals.deflateRaw(entry.bytes), zipInternals.crc32(entry.bytes)]);
        // WHY: storing an expanding entry makes source bytes plus framing a hard archive bound,
        // so fitting complete transcript lines never need to be discarded for compression overhead.
        const store = deflated.length > entry.bytes.length;
        preparedEntries.push({
            ...entry,
            nameBytes: Buffer.from(entry.name, 'utf8'),
            compressedBytes: store ? entry.bytes : deflated,
            method: store ? ZIP_STORE_METHOD : ZIP_DEFLATE_METHOD,
            crc,
        });
    }
    let localOffset = 0;
    const localParts = [];
    const centralParts = [];
    for (const { bytes, compressedBytes, nameBytes, method, crc } of preparedEntries) {
        const localHeader = writeLocalHeader({ nameBytes, bytes, compressedBytes, method, crc });
        localParts.push(localHeader, nameBytes, compressedBytes);
        centralParts.push(writeCentralHeader({ nameBytes, bytes, compressedBytes, method, crc, localOffset }), nameBytes);
        localOffset += localHeader.length + nameBytes.length + compressedBytes.length;
    }
    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(localOffset, 16);
    end.writeUInt16LE(0, 20);
    const archive = Buffer.concat([...localParts, centralDirectory, end]);
    return archive;
};
