const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    CRC32_TABLE[index] = value >>> 0;
}
// Byte-at-a-time CRC and the pre-bounds zip64 extra read moved verbatim from the previous home; both
// are slower than necessary with no user-visible difference: accepted residual, see docs/architecture/residuals/storage.md.
export const crc32 = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes)
        value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
};
export const hasZip64Extra = (bytes, offset, length) => {
    const end = offset + length;
    while (offset < end) {
        if (offset + 4 > end)
            return true;
        const identifier = bytes.readUInt16LE(offset);
        const size = bytes.readUInt16LE(offset + 2);
        offset += 4;
        if (offset + size > end || identifier === 0x0001)
            return true;
        offset += size;
    }
    return false;
};
export const findZipEnd = (bytes) => {
    const minimum = Math.max(0, bytes.length - 65_557);
    for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
        if (bytes.readUInt32LE(offset) === 0x06054b50)
            return offset;
    }
    return -1;
};
