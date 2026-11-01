// Reads one key of a Chromium extension's chrome.storage.local straight from its LevelDB directory while the browser
// may be running. Standard library only, and read-only: files are opened for reading, never copied, locked, written
// or repaired. Only the write-ahead log (`*.log`) and the sorted tables (`*.ldb`, `*.sst`) are parsed; `CURRENT`, the
// manifest and `LOCK` are never opened, because the newest version of a key is the one with the highest sequence
// number, whichever file holds it. A record or block that fails its checksum never yields a value: log records are
// dropped and counted, a failing table block makes its file unusable. Keys match whole, not by prefix.
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { EXTENSION_LOG_LIMITS } from './config.mjs';

/**
 * @typedef {{
 *   state: 'found' | 'absent' | 'deleted' | 'unreadable' | 'format_unknown' | 'truncated',
 *   value?: Buffer,
 *   source?: 'log' | 'table',
 *   systemCode?: string,
 *   skippedRecords: number,
 * }} LevelDbReadResult
 */

// --- CRC32C (Castagnoli), as LevelDB masks it ---
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let crc = n;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0x82f63b78 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
});
export const crc32c = (/** @type {Buffer} */ buf) => {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};
const unmaskCrc = (/** @type {number} */ masked) => {
    const rotated = (masked - 0xa282ead8) >>> 0;
    return ((rotated >>> 17) | (rotated << 15)) >>> 0;
};

// LevelDB lengths and offsets are varint32 here: no file we read is near 4 GiB.
const readVarint = (/** @type {Buffer} */ buf, /** @type {number} */ start) => {
    let pos = start;
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
        if (pos >= buf.length) throw new RangeError('varint past the end');
        const byte = buf[pos++];
        value += (byte & 0x7f) * scale;
        if (byte < 0x80) {
            if (value > 0xffffffff) break;
            return /** @type {[number, number]} */ ([value, pos]);
        }
        scale *= 128;
    }
    throw new RangeError('varint too long');
};

// --- Snappy raw block format ---
export const decompressSnappy = (/** @type {Buffer} */ src) => {
    const [length, start] = readVarint(src, 0);
    // The densest tag expands 3 bytes to 64, so a larger claim is corruption, not a big block: never allocate for it.
    if (length > src.length * 22) throw new RangeError('snappy length is implausible');
    const out = Buffer.alloc(length);
    let pos = start;
    let o = 0;
    while (pos < src.length) {
        const tag = src[pos++];
        const kind = tag & 3;
        if (kind === 0) {
            let len = tag >>> 2;
            if (len >= 60) {
                const bytes = len - 59;
                if (pos + bytes > src.length) throw new RangeError('snappy literal length past the end');
                len = 0;
                for (let i = 0; i < bytes; i++) len += src[pos++] * 2 ** (8 * i);
            }
            len += 1;
            if (pos + len > src.length || o + len > length) throw new RangeError('snappy literal out of range');
            src.copy(out, o, pos, pos + len);
            pos += len;
            o += len;
        } else {
            let len;
            let offset;
            if (kind === 1) {
                if (pos + 1 > src.length) throw new RangeError('snappy copy past the end');
                len = ((tag >>> 2) & 7) + 4;
                offset = ((tag >>> 5) << 8) | src[pos++];
            } else if (kind === 2) {
                len = (tag >>> 2) + 1;
                offset = src.readUInt16LE(pos);
                pos += 2;
            } else {
                len = (tag >>> 2) + 1;
                offset = src.readUInt32LE(pos);
                pos += 4;
            }
            if (offset === 0 || offset > o || o + len > length) throw new RangeError('snappy copy out of range');
            // Byte by byte on purpose: a copy may overlap its own output.
            for (let i = 0; i < len; i++, o++) out[o] = out[o - offset];
        }
    }
    if (o !== length) throw new RangeError('snappy output shorter than declared');
    return out;
};

// --- write-ahead log: 32 KiB blocks of checksummed fragments that carry WriteBatches ---
const LOG_BLOCK_SIZE = 32768;
const LOG_HEADER_SIZE = 7;
const FRAGMENT_FULL = 1;
const FRAGMENT_FIRST = 2;
const FRAGMENT_MIDDLE = 3;
const FRAGMENT_LAST = 4;

/** @typedef {(userKey: Buffer, sequence: bigint, value: Buffer | null, source: 'log' | 'table') => void} Offer */

// Each operation of a batch takes the next sequence number. A record that cannot be parsed throws: it passed its
// checksum, so the format is not the one we know.
const readWriteBatch = (/** @type {Buffer} */ record, /** @type {Offer} */ offer) => {
    if (record.length < 12) throw new RangeError('write batch too short');
    let sequence = record.readBigUInt64LE(0);
    const count = record.readUInt32LE(8);
    let pos = 12;
    const slice = (/** @type {number} */ length) => {
        if (pos + length > record.length) throw new RangeError('write batch entry past the end');
        pos += length;
        return record.subarray(pos - length, pos);
    };
    for (let i = 0; i < count; i++, sequence++) {
        const type = record[pos++];
        if (type !== 0 && type !== 1) throw new RangeError('unknown write batch operation');
        let length;
        [length, pos] = readVarint(record, pos);
        const key = slice(length);
        let value = null;
        if (type === 1) {
            [length, pos] = readVarint(record, pos);
            value = slice(length);
        }
        offer(key, sequence, value, 'log');
    }
};

// A record the writer is still appending, a failed checksum and a fragment whose start was lost are dropped and
// counted, never thrown: a live log is expected to end in a torn record.
const readLog = (/** @type {Buffer} */ buf, /** @type {Offer} */ offer) => {
    let skipped = 0;
    let pos = 0;
    /** @type {Buffer[] | null} */
    let pending = null;
    while (pos + LOG_HEADER_SIZE <= buf.length) {
        const left = LOG_BLOCK_SIZE - (pos % LOG_BLOCK_SIZE);
        if (left < LOG_HEADER_SIZE) { pos += left; continue; } // zero padding at the end of a block
        const length = buf.readUInt16LE(pos + 4);
        const type = buf[pos + 6];
        if (type === 0 && length === 0) { pos += left; continue; } // zero padding or a preallocated tail
        if (LOG_HEADER_SIZE + length > left) { skipped++; pending = null; pos += left; continue; } // a fragment never crosses a block
        const end = pos + LOG_HEADER_SIZE + length;
        if (end > buf.length) { skipped++; pending = null; break; }
        const intact = crc32c(buf.subarray(pos + 6, end)) === unmaskCrc(buf.readUInt32LE(pos));
        const payload = buf.subarray(pos + LOG_HEADER_SIZE, end);
        pos = end;
        if (!intact) { skipped++; pending = null; continue; }
        if (type === FRAGMENT_FULL || type === FRAGMENT_FIRST) {
            if (pending) skipped++;
            pending = null;
            if (type === FRAGMENT_FULL) readWriteBatch(payload, offer);
            else pending = [payload];
        } else if ((type === FRAGMENT_MIDDLE || type === FRAGMENT_LAST) && pending) {
            pending.push(payload);
            if (type === FRAGMENT_LAST) {
                const record = Buffer.concat(pending);
                pending = null;
                readWriteBatch(record, offer);
            }
        } else {
            skipped++;
        }
    }
    if (pending) skipped++;
    return skipped;
};

// --- sorted table: footer -> index block -> data blocks of prefix-compressed entries ---
const TABLE_FOOTER_SIZE = 48;
const TABLE_MAGIC = 0xdb4775248b80fb57n;
const BLOCK_TRAILER_SIZE = 5; // compression type + masked checksum
const COMPRESSION_NONE = 0;
const COMPRESSION_SNAPPY = 1;

// Only the compression Chromium writes for this storage (none or snappy) is read; a table that uses another
// (zstd, newer LevelDB) fails here and becomes `format_unknown`. Add the decompressor when a real profile shows it.
const readTable = (/** @type {Buffer} */ buf, /** @type {Offer} */ offer) => {
    if (buf.length < TABLE_FOOTER_SIZE) throw new RangeError('table shorter than its footer');
    const footer = buf.subarray(buf.length - TABLE_FOOTER_SIZE);
    if (footer.readBigUInt64LE(40) !== TABLE_MAGIC) throw new RangeError('table magic mismatch');

    const readBlock = (/** @type {number} */ offset, /** @type {number} */ size) => {
        const end = offset + size;
        if (end + BLOCK_TRAILER_SIZE > buf.length) throw new RangeError('block past the end');
        if (crc32c(buf.subarray(offset, end + 1)) !== unmaskCrc(buf.readUInt32LE(end + 1))) throw new RangeError('block checksum mismatch');
        const compression = buf[end];
        if (compression === COMPRESSION_NONE) return buf.subarray(offset, end);
        if (compression === COMPRESSION_SNAPPY) return decompressSnappy(buf.subarray(offset, end));
        throw new RangeError('unsupported block compression');
    };
    // Entries share a key prefix with the one before; the restart array at the end is only needed for seeking.
    const readEntries = (/** @type {Buffer} */ block, /** @type {(key: Buffer, value: Buffer) => void} */ visit) => {
        if (block.length < 4) throw new RangeError('block too short');
        const end = block.length - 4 - 4 * block.readUInt32LE(block.length - 4);
        if (end < 0) throw new RangeError('block restart array past the start');
        let pos = 0;
        let key = Buffer.alloc(0);
        while (pos < end) {
            let shared;
            let unshared;
            let valueLength;
            [shared, pos] = readVarint(block, pos);
            [unshared, pos] = readVarint(block, pos);
            [valueLength, pos] = readVarint(block, pos);
            if (shared > key.length || pos + unshared + valueLength > end) throw new RangeError('block entry out of range');
            key = Buffer.concat([key.subarray(0, shared), block.subarray(pos, pos + unshared)]);
            pos += unshared;
            visit(key, block.subarray(pos, pos + valueLength));
            pos += valueLength;
        }
    };
    const readHandle = (/** @type {Buffer} */ from, /** @type {number} */ start) => {
        const [offset, afterOffset] = readVarint(from, start);
        const [size, next] = readVarint(from, afterOffset);
        return { offset, size, next };
    };

    const index = readHandle(footer, readHandle(footer, 0).next); // the first handle is the metaindex, not needed
    readEntries(readBlock(index.offset, index.size), (_lastKey, handle) => {
        const { offset, size } = readHandle(handle, 0);
        readEntries(readBlock(offset, size), (internalKey, value) => {
            if (internalKey.length < 8) throw new RangeError('internal key too short');
            // An internal key is the user key plus (sequence << 8 | type); type 0 is a deletion.
            const trailer = internalKey.readBigUInt64LE(internalKey.length - 8);
            offer(internalKey.subarray(0, internalKey.length - 8), trailer >> 8n, (trailer & 0xffn) === 1n ? value : null, 'table');
        });
    });
};

const systemCodeOf = (/** @type {any} */ error) =>
    typeof error?.code === 'string' && /^E[A-Z0-9]{2,15}$/.test(error.code) ? { systemCode: error.code } : {};
// File numbers grow with age, so the newest files come first; the total limit then drops the oldest.
const fileNumber = (/** @type {string} */ name) => Number.parseInt(name, 10) || 0;

/**
 * The newest version of each of `keys` in the LevelDB directory `dir`, in one pass over its files. A file that cannot be
 * used (unreadable, not a format we parse, over a limit) decides a key's state when no other file holds it, and turns a
 * version found in any other file into `truncated`: the unused file may hold a newer one, and file numbers do not tell,
 * since a compaction table is numbered after the live log that holds newer writes. A file that vanished since the
 * listing is one of those too: a live database removes a file only after a flush or a compaction wrote its content to a
 * file the listing did not see. A directory that does not exist holds no key. `maxTotalBytes` bounds the pass, whatever the
 * number of keys, and `deadline` (on `clock`) is checked before each file: past it the pass stops and every key is
 * `truncated`.
 *
 * @param {{
 *   dir: string,
 *   keys: string[],
 *   fileSystem?: typeof import('node:fs/promises'),
 *   maxFileBytes?: number,
 *   maxTotalBytes?: number,
 *   deadline?: number,
 *   clock?: () => number,
 * }} options
 * @returns {Promise<Record<string, LevelDbReadResult>>}
 */
export const readLevelDbValues = async ({
    dir,
    keys,
    fileSystem = fsPromises,
    maxFileBytes = EXTENSION_LOG_LIMITS.maxFileBytes,
    maxTotalBytes = EXTENSION_LOG_LIMITS.maxTotalBytes,
    deadline = Infinity,
    clock = () => performance.now(),
}) => {
    const every = (/** @type {LevelDbReadResult} */ result) => Object.fromEntries(keys.map((key) => [key, result]));
    let names;
    try {
        names = await fileSystem.readdir(dir);
    } catch (error) {
        return every(error?.code === 'ENOENT' ? { state: 'absent', skippedRecords: 0 } : { state: 'unreadable', ...systemCodeOf(error), skippedRecords: 0 });
    }

    const wanted = keys.map((key) => Buffer.from(key, 'utf8'));
    /** @type {Array<{ sequence: bigint, value: Buffer | null, source: 'log' | 'table' } | undefined>} */
    const newest = keys.map(() => undefined);
    /** @type {Offer} */
    const offer = (userKey, sequence, value, source) => {
        const index = wanted.findIndex((key) => userKey.equals(key));
        if (index >= 0 && (newest[index] === undefined || sequence > /** @type {any} */ (newest[index]).sequence)) newest[index] = { sequence, value, source };
    };

    let skippedRecords = 0;
    let totalBytes = 0;
    let overLimit = false;
    let unparsed = false;
    // Whether any file could not be used.
    let anyUnused = false;
    /** @type {{ systemCode?: string } | undefined} */
    let unreadable;
    const dataFiles = names.filter((name) => /\.(log|ldb|sst)$/.test(name)).sort((a, b) => fileNumber(b) - fileNumber(a));
    for (const name of dataFiles) {
        if (clock() > deadline) return every({ state: 'truncated', skippedRecords });
        const unused = () => { anyUnused = true; };
        let buf;
        try {
            const { size } = await fileSystem.stat(join(dir, name));
            if (size > maxFileBytes || totalBytes + size > maxTotalBytes) {
                overLimit = true;
                unused();
                continue;
            }
            buf = await fileSystem.readFile(join(dir, name));
        } catch (error) {
            // A vanished file leaves a key no other file holds absent, not unreadable.
            if (error?.code !== 'ENOENT') unreadable ??= systemCodeOf(error);
            unused();
            continue;
        }
        totalBytes += buf.length;
        try {
            if (name.endsWith('.log')) skippedRecords += readLog(buf, offer);
            else readTable(buf, offer);
        } catch {
            unparsed = true;
            unused();
        }
    }

    /** @returns {LevelDbReadResult} */
    const stateOf = (/** @type {typeof newest[number]} */ found) => {
        if (found === undefined) {
            const state = unreadable ? 'unreadable' : unparsed ? 'format_unknown' : overLimit ? 'truncated' : 'absent';
            return { state, ...unreadable, skippedRecords };
        }
        // Any unused file, even one that gave this version before it failed part-way, may hold a newer one.
        if (anyUnused) return { state: 'truncated', skippedRecords };
        if (found.value === null) return { state: 'deleted', skippedRecords };
        // Copy out: a view would keep the whole file buffer alive.
        return { state: 'found', value: Buffer.from(found.value), source: found.source, skippedRecords };
    };
    return Object.fromEntries(keys.map((key, index) => [key, stateOf(newest[index])]));
};

/**
 * The newest version of `key` in `dir`: `readLevelDbValues` for one key.
 * @param {{ dir: string, key: string, fileSystem?: typeof import('node:fs/promises'), maxFileBytes?: number, maxTotalBytes?: number,
 *   deadline?: number, clock?: () => number }} options
 * @returns {Promise<LevelDbReadResult>}
 */
export const readLevelDbValue = async ({ key, ...options }) => (await readLevelDbValues({ ...options, keys: [key] }))[key];
