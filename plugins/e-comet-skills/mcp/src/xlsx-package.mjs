import { inflateRawSync } from 'node:zlib';

const XLSX_REQUIRED_PARTS = new Set(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml']);
const MAX_XLSX_METADATA_PART_BYTES = 1024 * 1024;
const MAX_XLSX_ZIP_ENTRIES = 4096;
const MAX_XLSX_ZIP_METADATA_BYTES = 4 * 1024 * 1024;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_FLAG_UTF8 = 0x0800;
const SUPPORTED_ZIP_FLAGS = ZIP_FLAG_DATA_DESCRIPTOR | ZIP_FLAG_UTF8;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_DATA_DESCRIPTOR_BYTES = 16;
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_DOCUMENT_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const MAX_XML_DEPTH = 128;
const MAX_XML_NODES = 8192;
const MAX_XML_ATTRIBUTES = 8192;
const MAX_XML_ATTRIBUTES_PER_ELEMENT = 256;
const MAX_XML_NAMESPACE_DECLARATIONS = 128;
const MAX_XML_TEXT_CODE_UNITS = 512 * 1024;
const MAX_XML_NAME_CODE_UNITS = 64 * 1024;
const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    CRC32_TABLE[index] = value >>> 0;
}
// Byte-at-a-time CRC and the pre-bounds zip64 extra read moved verbatim from the previous home; both
// are slower than necessary with no user-visible difference: accepted residual, see docs/local-agent-architecture.md#accepted-residuals.
const crc32 = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
};
const hasZip64Extra = (bytes, offset, length) => {
    const end = offset + length;
    while (offset < end) {
        if (offset + 4 > end) return true;
        const identifier = bytes.readUInt16LE(offset);
        const size = bytes.readUInt16LE(offset + 2);
        offset += 4;
        if (offset + size > end || identifier === 0x0001) return true;
        offset += size;
    }
    return false;
};
const findZipEnd = (bytes) => {
    const minimum = Math.max(0, bytes.length - 65_557);
    for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
        if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
    }
    return -1;
};
const isXmlNameStart = (code) =>
    (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x3a;
const isXmlNameContinuation = (code) =>
    isXmlNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2e || code === 0x2d;
const isXmlNcName = (value) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
const splitXmlName = (name) => {
    const colon = name.indexOf(':');
    if (colon === 0 || colon !== name.lastIndexOf(':')) throw new Error('Invalid qualified XML name');
    const prefix = colon < 0 ? '' : name.slice(0, colon);
    const localName = colon < 0 ? name : name.slice(colon + 1);
    if ((prefix && !isXmlNcName(prefix)) || !isXmlNcName(localName)) throw new Error('Invalid qualified XML name');
    return { prefix, localName };
};
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const isXmlScalar = (code) =>
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
const scanXmlReferences = (value, decode = false) => {
    const output = decode ? [] : undefined;
    let cursor = 0;
    let plainStart = 0;
    while (cursor < value.length) {
        if (value.charCodeAt(cursor) !== 0x26) {
            cursor += 1;
            continue;
        }
        if (output && plainStart < cursor) output.push(value.slice(plainStart, cursor));
        const referenceStart = cursor + 1;
        let decoded;
        if (value.startsWith('amp;', referenceStart)) {
            decoded = '&';
            cursor = referenceStart + 4;
        } else if (value.startsWith('lt;', referenceStart)) {
            decoded = '<';
            cursor = referenceStart + 3;
        } else if (value.startsWith('gt;', referenceStart)) {
            decoded = '>';
            cursor = referenceStart + 3;
        } else if (value.startsWith('quot;', referenceStart)) {
            decoded = '"';
            cursor = referenceStart + 5;
        } else if (value.startsWith('apos;', referenceStart)) {
            decoded = "'";
            cursor = referenceStart + 5;
        } else if (value.charCodeAt(referenceStart) === 0x23) {
            let digitCursor = referenceStart + 1;
            let radix = 10;
            if (value[digitCursor] === 'x') {
                radix = 16;
                digitCursor += 1;
            }
            const firstDigit = digitCursor;
            let numeric = 0;
            while (digitCursor < value.length && value[digitCursor] !== ';') {
                const code = value.charCodeAt(digitCursor);
                const digit =
                    code >= 0x30 && code <= 0x39
                        ? code - 0x30
                        : radix === 16 && code >= 0x41 && code <= 0x46
                          ? code - 0x41 + 10
                          : radix === 16 && code >= 0x61 && code <= 0x66
                            ? code - 0x61 + 10
                            : -1;
                if (digit < 0 || digit >= radix) throw new Error('Invalid XML character reference');
                numeric = numeric * radix + digit;
                if (numeric > 0x10ffff) throw new Error('Invalid XML character reference');
                digitCursor += 1;
            }
            if (digitCursor === firstDigit || value[digitCursor] !== ';' || !isXmlScalar(numeric)) {
                throw new Error('Invalid XML character reference');
            }
            decoded = String.fromCodePoint(numeric);
            if (![...decoded].every((character) => isXmlScalar(character.codePointAt(0)))) {
                throw new Error('Invalid XML character reference');
            }
            cursor = digitCursor + 1;
        } else {
            throw new Error('Invalid XML entity reference');
        }
        if (output) output.push(decoded);
        plainStart = cursor;
    }
    if (!output) return undefined;
    if (plainStart < value.length) output.push(value.slice(plainStart));
    return output.join('');
};
const decodeXmlReferences = (value) => scanXmlReferences(value, true);
const assertXmlReferences = (value) => void scanXmlReferences(value);
const parseXmlDocument = (source) => {
    if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
    for (const character of source) {
        const code = character.codePointAt(0);
        if (!isXmlScalar(code)) throw new Error('Invalid XML character');
    }
    let cursor = 0;
    let root;
    const stack = [];
    const namespaceScope = new Map([['xml', XML_NAMESPACE]]);
    const budget = { nodes: 0, attributes: 0, namespaceDeclarations: 0, text: 0, names: 0 };
    const spend = (key, amount, limit, message) => {
        if (amount > limit - budget[key]) throw new Error(message);
        budget[key] += amount;
    };
    const parseName = () => {
        const start = cursor;
        if (!isXmlNameStart(source.charCodeAt(cursor))) throw new Error('Invalid XML name');
        cursor += 1;
        while (isXmlNameContinuation(source.charCodeAt(cursor))) {
            if (cursor - start >= MAX_XML_NAME_CODE_UNITS - budget.names) throw new Error('XML name budget exceeded');
            cursor += 1;
        }
        spend('names', cursor - start, MAX_XML_NAME_CODE_UNITS, 'XML name budget exceeded');
        return source.slice(start, cursor);
    };
    const whitespace = () => {
        while (/[ \t\r\n]/u.test(source[cursor] ?? '')) cursor += 1;
    };
    const skipComment = () => {
        const end = source.indexOf('-->', cursor + 4);
        if (end < 0 || source.indexOf('--', cursor + 4) < end) throw new Error('Invalid XML comment');
        spend('text', end - cursor - 4, MAX_XML_TEXT_CODE_UNITS, 'XML text budget exceeded');
        cursor = end + 3;
    };
    const restoreNamespaces = (changes) => {
        for (let index = changes.length - 1; index >= 0; index -= 1) {
            const change = changes[index];
            if (change.hadPrevious) namespaceScope.set(change.prefix, change.previous);
            else namespaceScope.delete(change.prefix);
        }
    };
    if (source.startsWith('<?xml', cursor)) {
        const end = source.indexOf('?>', cursor + 5);
        const declaration = end < 0 ? '' : source.slice(cursor, end + 2);
        if (
            !/^<\?xml\s+version\s*=\s*(?:"1\.[01]"|'1\.[01]')(?:\s+encoding\s*=\s*(?:"UTF-8"|'UTF-8'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/i.test(declaration)
        ) {
            throw new Error('Invalid XML declaration');
        }
        spend('text', declaration.length, MAX_XML_TEXT_CODE_UNITS, 'XML text budget exceeded');
        cursor = end + 2;
    }
    while (cursor < source.length) {
        if (source.startsWith('<!--', cursor)) {
            skipComment();
            continue;
        }
        if (source.startsWith('<?', cursor)) {
            const end = source.indexOf('?>', cursor + 2);
            if (end < 0) throw new Error('Invalid XML processing instruction');
            cursor += 2;
            const target = parseName();
            if (cursor < end && !/[ \t\r\n]/u.test(source[cursor])) {
                throw new Error('Invalid XML processing instruction');
            }
            if (target.toLowerCase() === 'xml') throw new Error('Invalid XML declaration position');
            spend('text', end - cursor, MAX_XML_TEXT_CODE_UNITS, 'XML text budget exceeded');
            cursor = end + 2;
            continue;
        }
        if (source.startsWith('<![CDATA[', cursor)) {
            if (stack.length === 0) throw new Error('CDATA outside XML root');
            const end = source.indexOf(']]>', cursor + 9);
            if (end < 0) throw new Error('Invalid XML CDATA');
            spend('text', end - cursor - 9, MAX_XML_TEXT_CODE_UNITS, 'XML text budget exceeded');
            cursor = end + 3;
            continue;
        }
        if (source[cursor] !== '<') {
            const end = source.indexOf('<', cursor);
            const textEnd = end < 0 ? source.length : end;
            spend('text', textEnd - cursor, MAX_XML_TEXT_CODE_UNITS, 'XML text budget exceeded');
            const text = source.slice(cursor, textEnd);
            if (stack.length === 0 && !/^[ \t\r\n]*$/u.test(text)) throw new Error('Text outside XML root');
            if (text.includes(']]>')) throw new Error('Invalid XML character data');
            assertXmlReferences(text);
            cursor = textEnd;
            continue;
        }
        if (source.startsWith('</', cursor)) {
            cursor += 2;
            const qualifiedName = parseName();
            splitXmlName(qualifiedName);
            whitespace();
            if (source[cursor] !== '>' || stack.length === 0 || stack.at(-1).qualifiedName !== qualifiedName) {
                throw new Error('Mismatched XML end tag');
            }
            cursor += 1;
            restoreNamespaces(stack.pop().namespaceChanges);
            continue;
        }
        if (source.startsWith('<!', cursor)) throw new Error('Unsupported XML declaration');
        if (stack.length + 1 > MAX_XML_DEPTH) throw new Error('XML depth budget exceeded');
        spend('nodes', 1, MAX_XML_NODES, 'XML node budget exceeded');
        cursor += 1;
        const qualifiedName = parseName();
        const qualified = splitXmlName(qualifiedName);
        if (qualified.prefix === 'xmlns') throw new Error('Reserved XML namespace prefix');
        const rawAttributes = [];
        const rawAttributeNames = new Set();
        let selfClosing = false;
        let elementAttributes = 0;
        for (;;) {
            whitespace();
            if (source.startsWith('/>', cursor)) {
                cursor += 2;
                selfClosing = true;
                break;
            }
            if (source[cursor] === '>') {
                cursor += 1;
                break;
            }
            elementAttributes += 1;
            if (elementAttributes > MAX_XML_ATTRIBUTES_PER_ELEMENT) throw new Error('XML element attribute budget exceeded');
            spend('attributes', 1, MAX_XML_ATTRIBUTES, 'XML attribute budget exceeded');
            const attributeName = parseName();
            const attributeQualifiedName = splitXmlName(attributeName);
            whitespace();
            if (source[cursor] !== '=') throw new Error('Invalid XML attribute');
            cursor += 1;
            whitespace();
            const quote = source[cursor];
            if (quote !== '"' && quote !== "'") throw new Error('Invalid XML attribute quote');
            const end = source.indexOf(quote, cursor + 1);
            if (end < 0) throw new Error('Truncated XML attribute');
            spend('text', end - cursor - 1, MAX_XML_TEXT_CODE_UNITS, 'XML text budget exceeded');
            const value = source.slice(cursor + 1, end);
            if (value.includes('<')) throw new Error('Invalid XML attribute value');
            if (rawAttributeNames.has(attributeName)) throw new Error('Duplicate XML attribute');
            rawAttributeNames.add(attributeName);
            const namespaceDeclaration = attributeName === 'xmlns' || attributeQualifiedName.prefix === 'xmlns';
            if (namespaceDeclaration) {
                spend(
                    'namespaceDeclarations',
                    1,
                    MAX_XML_NAMESPACE_DECLARATIONS,
                    'XML namespace declaration budget exceeded'
                );
            }
            rawAttributes.push({
                name: attributeName,
                qualifiedName: attributeQualifiedName,
                namespaceDeclaration,
                value: decodeXmlReferences(value),
            });
            cursor = end + 1;
        }
        const namespaceChanges = [];
        for (const { name, qualifiedName: attributeQualifiedName, namespaceDeclaration, value } of rawAttributes) {
            if (!namespaceDeclaration) continue;
            if (name === 'xmlns') {
                if (value === XML_NAMESPACE || value === XMLNS_NAMESPACE) throw new Error('Invalid XML namespace declaration');
                namespaceChanges.push({ prefix: '', hadPrevious: namespaceScope.has(''), previous: namespaceScope.get('') });
                namespaceScope.set('', value);
            } else {
                const prefix = attributeQualifiedName.localName;
                if (
                    prefix === 'xmlns' ||
                    value.length === 0 ||
                    value === XMLNS_NAMESPACE ||
                    (prefix === 'xml') !== (value === XML_NAMESPACE)
                ) {
                    throw new Error('Invalid XML namespace declaration');
                }
                namespaceChanges.push({ prefix, hadPrevious: namespaceScope.has(prefix), previous: namespaceScope.get(prefix) });
                namespaceScope.set(prefix, value);
            }
        }
        const namespaceUri = qualified.prefix ? namespaceScope.get(qualified.prefix) : (namespaceScope.get('') ?? '');
        if (namespaceUri === undefined) throw new Error('Unbound XML namespace prefix');
        const attributes = new Map();
        for (const { qualifiedName: qualifiedAttribute, namespaceDeclaration, value } of rawAttributes) {
            if (namespaceDeclaration) continue;
            const attributeNamespace = qualifiedAttribute.prefix ? namespaceScope.get(qualifiedAttribute.prefix) : '';
            if (attributeNamespace === undefined) throw new Error('Unbound XML attribute prefix');
            const key = `${attributeNamespace}\u0000${qualifiedAttribute.localName}`;
            if (attributes.has(key)) throw new Error('Duplicate XML attribute');
            attributes.set(key, value);
        }
        const element = { qualifiedName, localName: qualified.localName, namespaceUri, attributes, children: [] };
        if (stack.length === 0) {
            if (root) throw new Error('Multiple XML roots');
            root = element;
        } else if (stack.length === 1) {
            root.children.push(element);
        }
        if (selfClosing) restoreNamespaces(namespaceChanges);
        else stack.push({ qualifiedName, namespaceChanges });
    }
    if (!root || stack.length !== 0) throw new Error('Truncated XML document');
    return root;
};
const hasDirectElement = (root, namespaceUri, localName, predicate = (_element) => true) =>
    root.children.some((element) => element.namespaceUri === namespaceUri && element.localName === localName && predicate(element));
const attribute = (element, name) => element.attributes.get(`\u0000${name}`);
const assertRequiredXlsxParts = (contents) => {
    const contentTypes = parseXmlDocument(contents.get('[Content_Types].xml'));
    const relationships = parseXmlDocument(contents.get('_rels/.rels'));
    const workbook = parseXmlDocument(contents.get('xl/workbook.xml'));
    if (
        contentTypes.namespaceUri !== CONTENT_TYPES_NAMESPACE ||
        contentTypes.localName !== 'Types' ||
        !hasDirectElement(
            contentTypes,
            CONTENT_TYPES_NAMESPACE,
            'Override',
            (element) =>
                attribute(element, 'PartName') === '/xl/workbook.xml' &&
                attribute(element, 'ContentType') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
        ) ||
        relationships.namespaceUri !== RELATIONSHIPS_NAMESPACE ||
        relationships.localName !== 'Relationships' ||
        !hasDirectElement(
            relationships,
            RELATIONSHIPS_NAMESPACE,
            'Relationship',
            (element) =>
                Boolean(attribute(element, 'Id')) &&
                attribute(element, 'Type') === OFFICE_DOCUMENT_RELATIONSHIP &&
                attribute(element, 'Target') === 'xl/workbook.xml' &&
                attribute(element, 'TargetMode') === undefined
        ) ||
        workbook.namespaceUri !== SPREADSHEET_NAMESPACE ||
        workbook.localName !== 'workbook'
    ) {
        throw new Error('Artifact ZIP does not contain valid XLSX workbook content');
    }
};
// Internal required bound: the artifact writer validates it before calling. Omitting it is not a
// supported path; new callers must supply a validated bound rather than silently disable it.
export const assertXlsxPackage = (bytes, { maxFileBytes }) => {
    if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) {
        throw new Error('Artifact is not a valid XLSX ZIP package');
    }
    const endOffset = findZipEnd(bytes);
    if (endOffset < 0 || endOffset + 22 > bytes.length) throw new Error('Artifact is not a valid XLSX ZIP package');
    const disk = bytes.readUInt16LE(endOffset + 4);
    const centralDisk = bytes.readUInt16LE(endOffset + 6);
    const diskEntries = bytes.readUInt16LE(endOffset + 8);
    const totalEntries = bytes.readUInt16LE(endOffset + 10);
    const centralSize = bytes.readUInt32LE(endOffset + 12);
    const centralOffset = bytes.readUInt32LE(endOffset + 16);
    const commentLength = bytes.readUInt16LE(endOffset + 20);
    if (
        disk !== 0 ||
        centralDisk !== 0 ||
        totalEntries === 0 ||
        totalEntries > MAX_XLSX_ZIP_ENTRIES ||
        totalEntries === 0xffff ||
        centralSize === 0xffffffff ||
        centralOffset === 0xffffffff ||
        totalEntries !== diskEntries ||
        endOffset + 22 + commentLength !== bytes.length ||
        centralOffset + centralSize !== endOffset
    ) {
        throw new Error('Artifact is not a valid XLSX ZIP package');
    }
    const parts = new Set();
    const localOffsets = new Set();
    const ranges = [];
    const requiredContent = new Map();
    let totalMetadata = 0;
    let totalUncompressed = 0;
    let offset = centralOffset;
    for (let index = 0; index < totalEntries; index += 1) {
        if (offset + 46 > endOffset || bytes.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('Artifact is not a valid XLSX ZIP package');
        }
        const crc = bytes.readUInt32LE(offset + 16);
        const compressedSize = bytes.readUInt32LE(offset + 20);
        const uncompressedSize = bytes.readUInt32LE(offset + 24);
        const versionNeeded = bytes.readUInt16LE(offset + 6);
        const flags = bytes.readUInt16LE(offset + 8);
        const usesDataDescriptor = (flags & ZIP_FLAG_DATA_DESCRIPTOR) !== 0;
        const method = bytes.readUInt16LE(offset + 10);
        const nameLength = bytes.readUInt16LE(offset + 28);
        const extraLength = bytes.readUInt16LE(offset + 30);
        const entryCommentLength = bytes.readUInt16LE(offset + 32);
        const localOffset = bytes.readUInt32LE(offset + 42);
        const nextOffset = offset + 46 + nameLength + extraLength + entryCommentLength;
        const centralExtraOffset = offset + 46 + nameLength;
        if (
            nameLength === 0 ||
            nextOffset > endOffset ||
            versionNeeded >= 45 ||
            bytes.readUInt16LE(offset + 34) !== 0 ||
            compressedSize === 0xffffffff ||
            uncompressedSize === 0xffffffff ||
            localOffset === 0xffffffff ||
            localOffset + 30 > centralOffset ||
            localOffsets.has(localOffset) ||
            flags !== (flags & SUPPORTED_ZIP_FLAGS) ||
            (usesDataDescriptor && method !== 8) ||
            ![0, 8].includes(method) ||
            hasZip64Extra(bytes, centralExtraOffset, extraLength)
        ) {
            throw new Error('Artifact is not a valid XLSX ZIP package');
        }
        let name;
        const centralNameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
        try {
            name = new TextDecoder('utf-8', { fatal: true }).decode(centralNameBytes);
        } catch (error) {
            throw new Error('Artifact is not a valid XLSX ZIP package', { cause: error });
        }
        if (parts.has(name) || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error('Artifact is not a valid XLSX ZIP package');
        }
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localExtraLength = bytes.readUInt16LE(localOffset + 28);
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
        const dataEnd = dataOffset + compressedSize;
        const entryEnd = dataEnd + (usesDataDescriptor ? ZIP_DATA_DESCRIPTOR_BYTES : 0);
        const requiredPart = XLSX_REQUIRED_PARTS.has(name);
        const localNameBytes = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(localNameBytes);
        } catch (error) {
            throw new Error('Artifact is not a valid XLSX ZIP package', { cause: error });
        }
        totalMetadata +=
            46 +
            nameLength +
            extraLength +
            entryCommentLength +
            30 +
            localNameLength +
            localExtraLength +
            (usesDataDescriptor ? ZIP_DATA_DESCRIPTOR_BYTES : 0);
        totalUncompressed += uncompressedSize;
        const localCrc = bytes.readUInt32LE(localOffset + 14);
        const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
        const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
        if (
            bytes.readUInt16LE(localOffset + 4) !== versionNeeded ||
            localNameLength !== nameLength ||
            totalMetadata > MAX_XLSX_ZIP_METADATA_BYTES ||
            totalUncompressed > maxFileBytes ||
            !localNameBytes.equals(centralNameBytes) ||
            bytes.readUInt16LE(localOffset + 6) !== flags ||
            bytes.readUInt16LE(localOffset + 8) !== method ||
            hasZip64Extra(bytes, localOffset + 30 + localNameLength, localExtraLength) ||
            entryEnd > centralOffset ||
            (usesDataDescriptor
                ? localCrc !== 0 ||
                  localCompressedSize !== 0 ||
                  localUncompressedSize !== 0 ||
                  bytes.readUInt32LE(dataEnd) !== ZIP_DATA_DESCRIPTOR_SIGNATURE ||
                  bytes.readUInt32LE(dataEnd + 4) !== crc ||
                  bytes.readUInt32LE(dataEnd + 8) !== compressedSize ||
                  bytes.readUInt32LE(dataEnd + 12) !== uncompressedSize
                : localCrc !== crc ||
                  localCompressedSize !== compressedSize ||
                  localUncompressedSize !== uncompressedSize) ||
            (method === 0 && compressedSize !== uncompressedSize)
        ) {
            throw new Error('Artifact is not a valid XLSX ZIP package');
        }
        const compressed = bytes.subarray(dataOffset, dataEnd);
        let content;
        try {
            content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
        } catch (error) {
            throw new Error('Artifact contains invalid compressed XLSX content', { cause: error });
        }
        if (content.length !== uncompressedSize || crc32(content) !== crc) throw new Error('Artifact contains invalid XLSX entry integrity');
        if (requiredPart && (uncompressedSize === 0 || uncompressedSize > MAX_XLSX_METADATA_PART_BYTES)) {
            throw new Error('Artifact XLSX metadata is unreasonably large');
        }
        if (requiredPart) requiredContent.set(name, content);
        parts.add(name);
        localOffsets.add(localOffset);
        ranges.push({ start: localOffset, end: entryEnd });
        offset = nextOffset;
    }
    ranges.sort((left, right) => left.start - right.start);
    if (
        offset !== endOffset ||
        ranges.some((range, index) => index > 0 && ranges[index - 1].end > range.start) ||
        [...XLSX_REQUIRED_PARTS].some((part) => !parts.has(part))
    ) {
        throw new Error('Artifact ZIP does not contain the required XLSX workbook content');
    }
    const decodeXml = (part) => {
        try {
            const xml = new TextDecoder('utf-8', { fatal: true }).decode(requiredContent.get(part));
            if (/<!DOCTYPE/i.test(xml)) throw new Error('Document types are not permitted');
            return xml;
        } catch (error) {
            throw new Error('Artifact contains invalid XLSX XML content', { cause: error });
        }
    };
    const decoded = new Map();
    for (const part of XLSX_REQUIRED_PARTS) {
        decoded.set(part, decodeXml(part));
    }
    try {
        assertRequiredXlsxParts(decoded);
    } catch (error) {
        throw new Error('Artifact contains invalid XLSX XML content', { cause: error });
    }
};
