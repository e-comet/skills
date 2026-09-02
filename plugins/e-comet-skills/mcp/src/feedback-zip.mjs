import { constants as zlibConstants, deflateRawSync } from 'node:zlib';

import {
    FEEDBACK_MAX_ARCHIVE_BYTES,
    FEEDBACK_MAX_METADATA_BYTES,
    FEEDBACK_MAX_REPORT_BYTES,
    FEEDBACK_MAX_TOTAL_ENTRY_BYTES,
    FEEDBACK_MAX_TRANSCRIPT_BYTES,
} from './config.mjs';

const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DEFLATE_METHOD = 8;
const ZIP_VERSION = 20;
const ZIP_VERSION_MADE_BY_UNIX = 0x0314;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021;
const REGULAR_FILE_ATTRIBUTES = 0x81a40000;
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

const crc32 = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
};

const assertBytes = (value, name, maximum, { allowEmpty = true } = {}) => {
    if (!Buffer.isBuffer(value)) throw new TypeError(`Feedback ${name} bytes must be a Buffer`);
    if (!allowEmpty && value.length === 0) throw new RangeError(`Feedback ${name} bytes must not be empty`);
    if (value.length > maximum) throw new RangeError(`Feedback ${name} exceeds the ${maximum}-byte limit`);
};

const writeLocalHeader = ({ nameBytes, bytes, compressedBytes, crc }) => {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(ZIP_VERSION, 4);
    header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    header.writeUInt16LE(ZIP_DEFLATE_METHOD, 8);
    header.writeUInt16LE(FIXED_DOS_TIME, 10);
    header.writeUInt16LE(FIXED_DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressedBytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    return header;
};

const writeCentralHeader = ({ nameBytes, bytes, compressedBytes, crc, localOffset }) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(ZIP_VERSION_MADE_BY_UNIX, 4);
    header.writeUInt16LE(ZIP_VERSION, 6);
    header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    header.writeUInt16LE(ZIP_DEFLATE_METHOD, 10);
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

/** @param {{ reportBytes?: Buffer, metadataBytes?: Buffer, transcriptBytes?: Buffer }} input */
export const createFeedbackZip = ({ reportBytes, metadataBytes, transcriptBytes } = {}) => {
    assertBytes(reportBytes, 'report', FEEDBACK_MAX_REPORT_BYTES, { allowEmpty: false });
    assertBytes(metadataBytes, 'metadata', FEEDBACK_MAX_METADATA_BYTES, { allowEmpty: false });
    if (transcriptBytes !== undefined) assertBytes(transcriptBytes, 'transcript', FEEDBACK_MAX_TRANSCRIPT_BYTES);
    const entries = [
        { name: 'report.md', bytes: reportBytes },
        { name: 'metadata.json', bytes: metadataBytes },
        ...(transcriptBytes === undefined ? [] : [{ name: 'transcript.jsonl', bytes: transcriptBytes }]),
    ];
    const totalEntryBytes = entries.reduce((total, entry) => total + entry.bytes.length, 0);
    if (totalEntryBytes > FEEDBACK_MAX_TOTAL_ENTRY_BYTES) {
        throw new RangeError(`Feedback combined entries exceed the ${FEEDBACK_MAX_TOTAL_ENTRY_BYTES}-byte limit`);
    }

    const preparedEntries = entries.map((entry) => ({
        ...entry,
        nameBytes: Buffer.from(entry.name, 'utf8'),
        compressedBytes: deflateRawSync(entry.bytes, DEFLATE_OPTIONS),
    }));
    const localBytes = preparedEntries.reduce((total, entry) => total + 30 + entry.nameBytes.length + entry.compressedBytes.length, 0);
    const centralBytes = preparedEntries.reduce((total, entry) => total + 46 + entry.nameBytes.length, 0);
    if (localBytes + centralBytes + 22 > FEEDBACK_MAX_ARCHIVE_BYTES) {
        throw Object.assign(new RangeError(`Feedback archive exceeds the ${FEEDBACK_MAX_ARCHIVE_BYTES}-byte limit`), {
            code: 'FEEDBACK_ARCHIVE_TOO_LARGE',
        });
    }

    let localOffset = 0;
    const localParts = [];
    const centralParts = [];
    for (const { bytes, compressedBytes, nameBytes } of preparedEntries) {
        const crc = crc32(bytes);
        const localHeader = writeLocalHeader({ nameBytes, bytes, compressedBytes, crc });
        localParts.push(localHeader, nameBytes, compressedBytes);
        centralParts.push(writeCentralHeader({ nameBytes, bytes, compressedBytes, crc, localOffset }), nameBytes);
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
