import { inflateRawSync } from 'node:zlib';
import { isRecord } from '../../shared/values.mjs';
import { assertXlsxPackage } from './xlsx.mjs';
import { crc32, findZipEnd, hasZip64Extra } from './zip-read.mjs';
const DATA_DESCRIPTOR_FLAG = 0x0008;
const UTF8_FLAG = 0x0800;
const DEFLATE_OPTION_FLAGS = 0x0006;
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;
const invalidArchive = (cause) => Object.assign(new Error('Artifact is not a valid single-workbook comparison ZIP', { cause }), { artifactClass: 'format' });
const isRegularEntry = (hostSystem, attributes) => {
    const dosDirectoryOrVolume = (attributes & 0x18) !== 0;
    const unixOrMac = hostSystem === 3 || hostSystem === 19;
    const fileType = attributes >>> 28;
    return !dosDirectoryOrVolume && (!unixOrMac || fileType === 0 || fileType === 8);
};
const assertWorkbookName = (bytes, flags) => {
    let name;
    try {
        // The only character-level checks use ASCII, which also covers the ZIP legacy encoding.
        name = flags & UTF8_FLAG ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('latin1');
    }
    catch (error) {
        throw invalidArchive(error);
    }
    if (!name.toLowerCase().endsWith('.xlsx') || /[\x00-\x1f\x7f]/.test(name))
        throw invalidArchive();
};
export const extractComparisonWorkbook = (archive, maxFileBytes) => {
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0)
        throw new Error('Comparison workbook limit must be a positive integer');
    const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
    const end = findZipEnd(bytes);
    if (end < 0 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)
        throw invalidArchive();
    const centralOffset = bytes.readUInt32LE(end + 16);
    const centralSize = bytes.readUInt32LE(end + 12);
    if (bytes.readUInt32LE(end + 4) !== 0 ||
        bytes.readUInt16LE(end + 8) !== 1 ||
        bytes.readUInt16LE(end + 10) !== 1 ||
        centralOffset < 30 ||
        centralSize < 46 ||
        centralOffset + centralSize !== end ||
        bytes.readUInt32LE(centralOffset) !== 0x02014b50 ||
        bytes.readUInt32LE(0) !== 0x04034b50) {
        throw invalidArchive();
    }
    const version = bytes.readUInt16LE(centralOffset + 6);
    const flags = bytes.readUInt16LE(centralOffset + 8);
    const method = bytes.readUInt16LE(centralOffset + 10);
    const crc = bytes.readUInt32LE(centralOffset + 16);
    const compressedSize = bytes.readUInt32LE(centralOffset + 20);
    const uncompressedSize = bytes.readUInt32LE(centralOffset + 24);
    const nameLength = bytes.readUInt16LE(centralOffset + 28);
    const extraLength = bytes.readUInt16LE(centralOffset + 30);
    const commentLength = bytes.readUInt16LE(centralOffset + 32);
    const allowedFlags = UTF8_FLAG | DATA_DESCRIPTOR_FLAG | (method === DEFLATE_METHOD ? DEFLATE_OPTION_FLAGS : 0);
    const nameOffset = centralOffset + 46;
    if (version >= 45 ||
        (flags & ~allowedFlags) !== 0 ||
        (method !== STORE_METHOD && method !== DEFLATE_METHOD) ||
        (method === STORE_METHOD && compressedSize !== uncompressedSize) ||
        compressedSize === 0 ||
        uncompressedSize === 0 ||
        uncompressedSize === 0xffffffff ||
        nameLength === 0 ||
        46 + nameLength + extraLength + commentLength !== centralSize ||
        bytes.readUInt16LE(centralOffset + 34) !== 0 ||
        bytes.readUInt32LE(centralOffset + 42) !== 0 ||
        !isRegularEntry(bytes.readUInt8(centralOffset + 5), bytes.readUInt32LE(centralOffset + 38)) ||
        hasZip64Extra(bytes, nameOffset + nameLength, extraLength)) {
        throw invalidArchive();
    }
    const localNameLength = bytes.readUInt16LE(26);
    const localExtraLength = bytes.readUInt16LE(28);
    const dataOffset = 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    const entryName = bytes.subarray(nameOffset, nameOffset + nameLength);
    if (dataEnd > centralOffset ||
        bytes.readUInt16LE(4) !== version ||
        bytes.readUInt16LE(6) !== flags ||
        bytes.readUInt16LE(8) !== method ||
        localNameLength !== nameLength ||
        !bytes.subarray(30, 30 + localNameLength).equals(entryName) ||
        hasZip64Extra(bytes, 30 + localNameLength, localExtraLength)) {
        throw invalidArchive();
    }
    assertWorkbookName(entryName, flags);
    const descriptorLength = centralOffset - dataEnd;
    if ((flags & DATA_DESCRIPTOR_FLAG) !== 0) {
        // With one entry the central directory bounds its descriptor exactly, even if a signatureless CRC matches the signature.
        const fields = centralOffset - 12;
        if ((descriptorLength !== 12 && descriptorLength !== 16) ||
            (descriptorLength === 16 && bytes.readUInt32LE(dataEnd) !== 0x08074b50) ||
            bytes.readUInt32LE(14) !== 0 ||
            bytes.readUInt32LE(18) !== 0 ||
            bytes.readUInt32LE(22) !== 0 ||
            bytes.readUInt32LE(fields) !== crc ||
            bytes.readUInt32LE(fields + 4) !== compressedSize ||
            bytes.readUInt32LE(fields + 8) !== uncompressedSize) {
            throw invalidArchive();
        }
    }
    else if (descriptorLength !== 0 ||
        bytes.readUInt32LE(14) !== crc ||
        bytes.readUInt32LE(18) !== compressedSize ||
        bytes.readUInt32LE(22) !== uncompressedSize) {
        throw invalidArchive();
    }
    if (uncompressedSize > maxFileBytes) {
        throw Object.assign(new Error('Comparison workbook exceeds the per-file limit'), { artifactClass: 'limit' });
    }
    try {
        const compressed = bytes.subarray(dataOffset, dataEnd);
        let workbook = compressed;
        if (method === DEFLATE_METHOD) {
            // Node's type declaration omits the return shape selected by the documented info option.
            const result = inflateRawSync(compressed, { info: true, maxOutputLength: uncompressedSize });
            if (!isRecord(result) || !Buffer.isBuffer(result.buffer) || !isRecord(result.engine))
                throw invalidArchive();
            if (result.engine.bytesWritten !== compressedSize)
                throw invalidArchive();
            workbook = result.buffer;
        }
        if (workbook.length !== uncompressedSize || crc32(workbook) !== crc)
            throw invalidArchive();
        assertXlsxPackage(workbook, { maxFileBytes });
        return workbook;
    }
    catch (error) {
        throw invalidArchive(error);
    }
};
