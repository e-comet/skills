import { constants as zlibConstants, deflateRaw } from 'node:zlib';

import { FEEDBACK_MAX_BYTES } from './config.mjs';

const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP_DEFLATE_METHOD = 8;
const ZIP_VERSION = 20;
const ZIP_VERSION_MADE_BY_UNIX = 0x0314;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021;
const REGULAR_FILE_ATTRIBUTES = 0x81a40000;
const CRC_CHUNK_BYTES = 64 * 1024;
const DEFLATE_OPTIONS = Object.freeze({
    level: 6,
    windowBits: 15,
    memLevel: 8,
    strategy: zlibConstants.Z_DEFAULT_STRATEGY,
});

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    CRC32_TABLE[index] = value >>> 0;
}

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

const crc32 = async (bytes) => {
    let value = 0xffffffff;
    for (let offset = 0; offset < bytes.length; offset += CRC_CHUNK_BYTES) {
        const end = Math.min(bytes.length, offset + CRC_CHUNK_BYTES);
        for (let index = offset; index < end; index += 1) {
            value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
        }
        // WHY: a maximum-sized transcript must not monopolize the MCP transport loop while its CRC is computed.
        if (end < bytes.length) await yieldToEventLoop();
    }
    return (value ^ 0xffffffff) >>> 0;
};

const deflateRawAsync = (bytes) => new Promise((resolve, reject) => {
    deflateRaw(bytes, DEFLATE_OPTIONS, (error, result) => {
        if (error) reject(error);
        else resolve(result);
    });
});

// Narrow read-only seams keep the two independent event-loop guarantees directly testable.
export const feedbackZipInternals = Object.freeze({
    crc32,
    deflateRaw: deflateRawAsync,
});

const assertBytes = (value, name, { allowEmpty = true } = {}) => {
    if (!Buffer.isBuffer(value)) throw new TypeError(`Feedback ${name} bytes must be a Buffer`);
    if (!allowEmpty && value.length === 0) throw new RangeError(`Feedback ${name} bytes must not be empty`);
};

const entryFramingBytes = (nameBytes) => 30 + nameBytes.length + 46 + nameBytes.length;
const entryNames = (includeTranscript) => [
    'report.md',
    'metadata.json',
    ...(includeTranscript ? ['transcript.jsonl'] : []),
];

/** The fixed entry list, in order, that `createFeedbackZip` frames for this transcript choice. */
export const feedbackZipEntryLayout = ({ includeTranscript = false } = {}) => entryNames(includeTranscript);

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_END_BYTES = 22;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_LOCAL_HEADER_BYTES = 30;
const MAX_FEEDBACK_ZIP_ENTRIES = 3;
const malformedZip = (cause = undefined) => new RangeError(
    'Feedback archive is not a well-formed feedback ZIP package',
    cause === undefined ? undefined : { cause },
);

const readCentralEntry = (bytes, offset, endOffset, decoder) => {
    if (offset + ZIP_CENTRAL_HEADER_BYTES > endOffset || bytes.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) throw malformedZip();
    const nameOffset = offset + ZIP_CENTRAL_HEADER_BYTES;
    const nameLength = bytes.readUInt16LE(offset + 28);
    const entry = {
        flags: bytes.readUInt16LE(offset + 8),
        method: bytes.readUInt16LE(offset + 10),
        crc: bytes.readUInt32LE(offset + 16),
        compressedSize: bytes.readUInt32LE(offset + 20),
        uncompressedSize: bytes.readUInt32LE(offset + 24),
        localOffset: bytes.readUInt32LE(offset + 42),
        nameBytes: bytes.subarray(nameOffset, nameOffset + nameLength),
        nextOffset: nameOffset + nameLength,
    };
    if (
        nameLength === 0 ||
        entry.nextOffset > endOffset ||
        // The writer emits no extra field, entry comment, disk number or internal attributes, and
        // exactly the UTF-8 flag: a data descriptor or any other flag is not an archive it wrote.
        bytes.readUInt16LE(offset + 30) !== 0 ||
        bytes.readUInt16LE(offset + 32) !== 0 ||
        bytes.readUInt16LE(offset + 34) !== 0 ||
        bytes.readUInt16LE(offset + 36) !== 0 ||
        entry.flags !== ZIP_UTF8_FLAG ||
        ![ZIP_STORE_METHOD, ZIP_DEFLATE_METHOD].includes(entry.method) ||
        (entry.method === ZIP_STORE_METHOD && entry.compressedSize !== entry.uncompressedSize)
    ) {
        throw malformedZip();
    }
    try {
        entry.name = decoder.decode(entry.nameBytes);
    } catch (error) {
        throw malformedZip(error);
    }
    return entry;
};

/**
 * Walks the stored entries from the first byte, in central-directory order, and requires each local
 * header to agree with its central record and to abut the next one. Nothing outside the entries, the
 * central directory and the end record may exist, so an archive cannot smuggle a differently named
 * local entry or slack bytes past the listing the caller checks.
 */
const assertLocalEntriesMatch = (bytes, entries, centralOffset) => {
    let cursor = 0;
    for (const entry of entries) {
        const nameLength = entry.nameBytes.length;
        const dataOffset = cursor + ZIP_LOCAL_HEADER_BYTES + nameLength;
        if (
            entry.localOffset !== cursor ||
            dataOffset + entry.compressedSize > centralOffset ||
            bytes.readUInt32LE(cursor) !== ZIP_LOCAL_SIGNATURE ||
            bytes.readUInt16LE(cursor + 6) !== entry.flags ||
            bytes.readUInt16LE(cursor + 8) !== entry.method ||
            bytes.readUInt32LE(cursor + 14) !== entry.crc ||
            bytes.readUInt32LE(cursor + 18) !== entry.compressedSize ||
            bytes.readUInt32LE(cursor + 22) !== entry.uncompressedSize ||
            bytes.readUInt16LE(cursor + 26) !== nameLength ||
            bytes.readUInt16LE(cursor + 28) !== 0 ||
            !bytes.subarray(cursor + ZIP_LOCAL_HEADER_BYTES, dataOffset).equals(entry.nameBytes)
        ) {
            throw malformedZip();
        }
        cursor = dataOffset + entry.compressedSize;
    }
    if (cursor !== centralOffset) throw malformedZip();
};

/**
 * Validates that `bytes` is framed exactly as `createFeedbackZip` frames a feedback archive and lists
 * the entry names it declares. The end record, the central directory and every local header are read;
 * no entry body is inflated, so the check stays cheap on the cloud upload path. Entry contents are
 * therefore not inspected beyond the sizes and CRC-32 the two headers agree on.
 * @param {Buffer} bytes @returns {string[]}
 */
export const feedbackZipEntryNames = (bytes) => {
    if (!Buffer.isBuffer(bytes) || bytes.length < ZIP_END_BYTES) throw malformedZip();
    const endOffset = bytes.length - ZIP_END_BYTES;
    const totalEntries = bytes.readUInt16LE(endOffset + 10);
    const centralSize = bytes.readUInt32LE(endOffset + 12);
    const centralOffset = bytes.readUInt32LE(endOffset + 16);
    if (
        bytes.readUInt32LE(endOffset) !== ZIP_END_SIGNATURE ||
        bytes.readUInt16LE(endOffset + 4) !== 0 ||
        bytes.readUInt16LE(endOffset + 6) !== 0 ||
        bytes.readUInt16LE(endOffset + 8) !== totalEntries ||
        bytes.readUInt16LE(endOffset + 20) !== 0 ||
        totalEntries < 1 ||
        totalEntries > MAX_FEEDBACK_ZIP_ENTRIES ||
        centralOffset + centralSize !== endOffset
    ) {
        throw malformedZip();
    }
    // ignoreBOM keeps a leading U+FEFF in the decoded name: stripping it would let three invisible
    // bytes into the stored entry name while the listing check saw a clean one.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const entries = [];
    let offset = centralOffset;
    for (let index = 0; index < totalEntries; index += 1) {
        const entry = readCentralEntry(bytes, offset, endOffset, decoder);
        entries.push(entry);
        offset = entry.nextOffset;
    }
    if (offset !== endOffset) throw malformedZip();
    const names = entries.map((entry) => entry.name);
    // Only the two listings this writer produces are a feedback archive; the caller still decides
    // which of them the delivered transcript consent allows.
    const declaresFeedbackLayout = [false, true].some((includeTranscript) => {
        const expected = entryNames(includeTranscript);
        return names.length === expected.length && names.every((name, index) => name === expected[index]);
    });
    if (!declaresFeedbackLayout) throw malformedZip();
    assertLocalEntriesMatch(bytes, entries, centralOffset);
    return names;
};

export const feedbackZipFramingBytes = ({ includeTranscript = false } = {}) =>
    entryNames(includeTranscript)
        .map((name) => Buffer.from(name, 'utf8'))
        .reduce((total, nameBytes) => total + entryFramingBytes(nameBytes), 22);

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

/** @param {{ reportBytes?: Buffer, metadataBytes?: Buffer, transcriptBytes?: Buffer }} input @param {{ maxBytes?: number }} options */
export const createFeedbackZip = async ({ reportBytes, metadataBytes, transcriptBytes } = {}, options = {}) => {
    const { maxBytes = FEEDBACK_MAX_BYTES } = options;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Feedback package byte limit must be a positive safe integer');
    assertBytes(reportBytes, 'report', { allowEmpty: false });
    assertBytes(metadataBytes, 'metadata', { allowEmpty: false });
    if (transcriptBytes !== undefined) assertBytes(transcriptBytes, 'transcript');
    const entries = [
        { name: 'report.md', bytes: reportBytes },
        { name: 'metadata.json', bytes: metadataBytes },
        ...(transcriptBytes === undefined ? [] : [{ name: 'transcript.jsonl', bytes: transcriptBytes }]),
    ];
    const framingBytes = feedbackZipFramingBytes({ includeTranscript: transcriptBytes !== undefined });
    const totalEntryBytes = entries.reduce((total, entry) => total + entry.bytes.length, 0);
    if (totalEntryBytes + framingBytes > maxBytes) {
        throw new RangeError(`Feedback combined entries and ZIP framing exceed the ${maxBytes}-byte package limit`);
    }

    const preparedEntries = [];
    for (const entry of entries) {
        const [deflated, crc] = await Promise.all([
            feedbackZipInternals.deflateRaw(entry.bytes),
            feedbackZipInternals.crc32(entry.bytes),
        ]);
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
