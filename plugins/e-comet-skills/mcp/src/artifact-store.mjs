import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import {
    ARTIFACT_DIR,
    ARTIFACT_MAX_CHUNK_BYTES,
    ARTIFACT_MAX_FILE_BYTES,
    ARTIFACT_MAX_FILES,
    ARTIFACT_MAX_JOB_BYTES,
    ARTIFACT_MAX_TOTAL_BYTES,
    ARTIFACT_RETENTION_MS,
} from './config.mjs';

const defaultFileSystem = { appendFile, chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile };
const jobUsage = new Map();
const activePartPaths = new Set();
const ARTIFACT_LOCK_RETRY_LIMIT = 200;
const ARTIFACT_LOCK_RETRY_DELAY_MS = 25;
const ARTIFACT_LOCK_STALE_MS = 30_000;
const ARTIFACT_PIN_REMOVE_RETRY_LIMIT = 3;
const ARTIFACT_DEFERRED_RELEASE_RETRY_LIMIT = 3;
const ARTIFACT_DEFERRED_RELEASE_RETRY_DELAY_MS = 1_000;
const ARTIFACT_CLEANUP_RETRY_LIMIT = 3;
const ARTIFACT_CLEANUP_RETRY_DELAY_MS = 1_000;
const TRANSIENT_ARTIFACT_PIN_REMOVE_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RETRYABLE_ARTIFACT_RELEASE_ERRORS = new Set([...TRANSIENT_ARTIFACT_PIN_REMOVE_ERRORS, 'ARTIFACT_STORE_BUSY']);
const ARTIFACT_LOCK_OWNER_PATTERN = /^([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const asError = (error) => (error instanceof Error ? error : new Error(String(error)));
export class ArtifactStoreError extends Error {
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = 'ArtifactStoreError';
        this.code = code;
        if (options.retryable !== undefined) this.retryable = options.retryable === true;
    }
}
const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
const ensurePrivateDirectory = async (directory, fileSystem = defaultFileSystem, platform = process.platform) => {
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    if (platform !== 'win32') await fileSystem.chmod(directory, 0o700);
};
const ensurePrivateFile = async (path, fileSystem = defaultFileSystem, platform = process.platform) => {
    if (platform !== 'win32') await fileSystem.chmod(path, 0o600);
};
const safeArtifactName = (fileName) => {
    if (typeof fileName !== 'string' || fileName.length === 0) throw new Error('Artifact file name is required');
    const sanitized = basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 180);
    const baseName = sanitized || 'artifact';
    return baseName.toLowerCase().endsWith('.xlsx') ? baseName : `${baseName}.xlsx`;
};
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
const assertXlsxPackage = (bytes) => {
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
            totalUncompressed > ARTIFACT_MAX_FILE_BYTES ||
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
const decodeCanonicalBase64 = (base64Data, maxChunkBytes) => {
    if (typeof base64Data !== 'string' || base64Data.length === 0) throw new Error('Artifact chunk must use canonical base64');
    const maximumEncodedLength = Math.ceil(maxChunkBytes / 3) * 4;
    if (base64Data.length > maximumEncodedLength) throw new Error(`Artifact encoded chunk exceeds the ${maximumEncodedLength}-byte chunk limit`);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64Data)) {
        throw new Error('Artifact chunk must use canonical base64');
    }
    const bytes = Buffer.from(base64Data, 'base64');
    if (bytes.toString('base64') !== base64Data) throw new Error('Artifact chunk must use canonical base64');
    return bytes;
};
const validateLimits = ({ maxChunkBytes, maxFileBytes, maxJobBytes, maxTotalBytes, maxFiles, retentionMs }) => {
    if (![maxChunkBytes, maxFileBytes, maxJobBytes, maxTotalBytes, maxFiles, retentionMs].every(isPositiveSafeInteger)) {
        throw new Error('Artifact limits must be positive safe integers');
    }
};
const acquireJob = (jobId, maxJobBytes) => {
    const usage = jobUsage.get(jobId) || {
        bytes: 0,
        writers: 0,
        pendingCleanups: 0,
        maxJobBytes,
        pinGroups: new Map(),
        deferredReleaseAttempts: 0,
        releaseRetryScheduled: false,
        deferredRelease: undefined,
    };
    usage.writers += 1;
    jobUsage.set(jobId, usage);
    return usage;
};
const ACTIVE_PART_PATTERN = /^\.active-([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/;
const ACTIVE_ARTIFACT_PIN_PATTERN =
    /^\.active-artifact-([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pin$/;
const partOwnerPid = (name) => {
    const match = ACTIVE_PART_PATTERN.exec(name);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const artifactPinOwnerPid = (name) => {
    const match = ACTIVE_ARTIFACT_PIN_PATTERN.exec(name);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const lockOwnerPid = (name) => {
    const match = ARTIFACT_LOCK_OWNER_PATTERN.exec(name);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const defaultIsProcessAlive = (pid) => {
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        return undefined;
    }
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const defaultScheduleDeferredRelease = (retry, delayMs) => {
    const timer = setTimeout(() => {
        void retry();
    }, delayMs);
    timer.unref();
};
// The lock must live on the same filesystem as the artifacts it guards, so callers that inject a
// `fileSystem` place the lock beside their artifact directory instead of on the real disk.
const acquireArtifactStoreLock = async (artifactDir, fileSystem = defaultFileSystem) => {
    const lockPath = join(artifactDir, '.artifact-store.lock');
    for (let attempt = 0; attempt < ARTIFACT_LOCK_RETRY_LIMIT; attempt += 1) {
        const ownerId = `${process.pid}-${randomUUID()}`;
        const candidatePath = join(artifactDir, `.artifact-store-lock-${ownerId}`);
        const candidateOwnerPath = join(candidatePath, ownerId);
        await fileSystem.mkdir(candidatePath, { mode: 0o700 });
        try {
            await fileSystem.writeFile(candidateOwnerPath, '', { flag: 'wx', mode: 0o600 });
            await fileSystem.rename(candidatePath, lockPath);
            const ownerPath = join(lockPath, ownerId);
            return async () => {
                await fileSystem.rm(ownerPath, { force: true });
                try {
                    await fileSystem.rmdir(lockPath);
                } catch (error) {
                    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
                }
            };
        } catch (error) {
            await fileSystem.rm(candidatePath, { recursive: true, force: true });
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
        }
        try {
            const lockMetadata = await fileSystem.stat(lockPath);
            if (Date.now() - lockMetadata.mtimeMs > ARTIFACT_LOCK_STALE_MS) {
                const ownerEntries = (await fileSystem.readdir(lockPath, { withFileTypes: true })).filter((entry) => entry.isFile());
                const ownerPids = ownerEntries.map((entry) => lockOwnerPid(entry.name)).filter((pid) => pid !== null);
                if (ownerPids.some((ownerPid) => defaultIsProcessAlive(ownerPid) !== false)) {
                    await delay(ARTIFACT_LOCK_RETRY_DELAY_MS);
                    continue;
                }
                const currentMetadata = await fileSystem.stat(lockPath);
                if (
                    currentMetadata.dev === lockMetadata.dev &&
                    currentMetadata.ino === lockMetadata.ino &&
                    currentMetadata.mtimeMs === lockMetadata.mtimeMs
                ) {
                    const stalePath = join(artifactDir, `.artifact-store-stale-lock-${process.pid}-${randomUUID()}`);
                    await fileSystem.rename(lockPath, stalePath);
                    await fileSystem.rm(stalePath, { recursive: true, force: true });
                    continue;
                }
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        await delay(ARTIFACT_LOCK_RETRY_DELAY_MS);
    }
    throw new ArtifactStoreError('ARTIFACT_STORE_BUSY', 'Artifact storage is busy; retry the export');
};
const withArtifactStoreLock = async (artifactDir, operation, fileSystem = defaultFileSystem) => {
    const release = await acquireArtifactStoreLock(artifactDir, fileSystem);
    let operationError;
    try {
        return await operation();
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        try {
            await release();
        } catch (releaseError) {
            if (!operationError) throw releaseError;
        }
    }
};

const removeArtifactPin = async (pinPath, fileSystem) => {
    for (let attempt = 1; attempt <= ARTIFACT_PIN_REMOVE_RETRY_LIMIT; attempt += 1) {
        try {
            await fileSystem.rm(pinPath, { force: true });
            return;
        } catch (error) {
            if (!TRANSIENT_ARTIFACT_PIN_REMOVE_ERRORS.has(error?.code) || attempt === ARTIFACT_PIN_REMOVE_RETRY_LIMIT) throw error;
            await delay(ARTIFACT_LOCK_RETRY_DELAY_MS);
        }
    }
};
const isRetryableArtifactReleaseError = (error) => RETRYABLE_ARTIFACT_RELEASE_ERRORS.has(error?.code);

const scheduleDeferredArtifactRelease = (jobId, usage, scheduleDeferredRelease) => {
    if (usage.releaseRetryScheduled || usage.deferredReleaseAttempts >= ARTIFACT_DEFERRED_RELEASE_RETRY_LIMIT) return;
    usage.releaseRetryScheduled = true;
    try {
        scheduleDeferredRelease(async () => {
            usage.releaseRetryScheduled = false;
            if (jobUsage.get(jobId) !== usage) return;
            usage.deferredReleaseAttempts += 1;
            try {
                await releaseArtifactJob(jobId, { scheduleDeferredRelease });
            } catch {
                // releaseArtifactJob schedules the next bounded retry for transient pin failures.
            }
        }, ARTIFACT_DEFERRED_RELEASE_RETRY_DELAY_MS);
    } catch {
        usage.releaseRetryScheduled = false;
    }
};

const resumeDeferredArtifactRelease = (jobId, usage) => {
    const deferredRelease = usage.deferredRelease;
    if (!deferredRelease || usage.writers > 0 || usage.pendingCleanups > 0 || jobUsage.get(jobId) !== usage) return;
    usage.deferredRelease = undefined;
    void releaseArtifactJob(jobId, { scheduleDeferredRelease: deferredRelease.scheduleDeferredRelease }).catch(() => undefined);
};

export const releaseArtifactJob = async (
    jobId,
    { scheduleDeferredRelease = defaultScheduleDeferredRelease, deferWhileActive = false } = {}
) => {
    const usage = jobUsage.get(jobId);
    if (!usage) return false;
    if (usage.writers > 0 || usage.pendingCleanups > 0) {
        if (deferWhileActive) {
            usage.deferredRelease = { scheduleDeferredRelease };
            return false;
        }
        throw new Error('Cannot release artifact job while active artifact writers or cleanup remain');
    }
    try {
        for (const { artifactDir, fileSystem, pinPaths } of usage.pinGroups.values()) {
            await withArtifactStoreLock(
                artifactDir,
                () => Promise.all([...pinPaths].map((pinPath) => removeArtifactPin(pinPath, fileSystem))),
                fileSystem
            );
        }
    } catch (error) {
        if (isRetryableArtifactReleaseError(error)) {
            scheduleDeferredArtifactRelease(jobId, usage, scheduleDeferredRelease);
        }
        throw error;
    }
    jobUsage.delete(jobId);
    return true;
};

const pruneArtifactsUnlocked = async ({
    artifactDir = ARTIFACT_DIR,
    now = Date.now(),
    retentionMs = ARTIFACT_RETENTION_MS,
    maxTotalBytes = ARTIFACT_MAX_TOTAL_BYTES,
    maxFiles = ARTIFACT_MAX_FILES,
    excludePaths = [],
    fileSystem = defaultFileSystem,
    platform = process.platform,
    isProcessAlive = defaultIsProcessAlive,
} = {}) => {
    const errors = [];
    const protectedPaths = new Set(excludePaths);
    const fs = { ...defaultFileSystem, ...fileSystem };
    await ensurePrivateDirectory(artifactDir, fs, platform);
    let entries;
    try {
        entries = await fs.readdir(artifactDir, { withFileTypes: true });
    } catch (error) {
        return [asError(error)];
    }

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ownerPid = artifactPinOwnerPid(entry.name);
        if (ownerPid === null) continue;
        const pinPath = join(artifactDir, entry.name);
        try {
            if ((await isProcessAlive(ownerPid)) === false) {
                await fs.rm(pinPath, { force: true });
                continue;
            }
            await ensurePrivateFile(pinPath, fs, platform);
            const artifactName = await fs.readFile(pinPath, 'utf8');
            if (basename(artifactName) !== artifactName || !artifactName.endsWith('.xlsx')) {
                throw new Error(`Artifact pin ${entry.name} contains an invalid artifact name`);
            }
            protectedPaths.add(join(artifactDir, artifactName));
        } catch (error) {
            errors.push(asError(error));
        }
    }
    if (errors.length > 0) return errors;

    const completed = [];
    let retainedPartBytes = 0;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = join(artifactDir, entry.name);
        if (entry.name.endsWith('.part')) {
            try {
                const metadata = await fs.stat(path);
                let removed = false;
                if (!protectedPaths.has(path) && !activePartPaths.has(path) && now - metadata.mtimeMs > retentionMs) {
                    const ownerPid = partOwnerPid(entry.name);
                    if (ownerPid !== null && (await isProcessAlive(ownerPid)) === false) {
                        await fs.rm(path, { force: true });
                        removed = true;
                    }
                }
                if (!removed) {
                    retainedPartBytes += metadata.size;
                }
            } catch (error) {
                errors.push(asError(error));
            }
            continue;
        }
        if (!entry.name.endsWith('.xlsx')) continue;
        try {
            await ensurePrivateFile(path, fs, platform);
            const metadata = await fs.stat(path);
            if (!protectedPaths.has(path) && now - metadata.mtimeMs > retentionMs) {
                await fs.rm(path, { force: true });
            } else {
                completed.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
            }
        } catch (error) {
            errors.push(asError(error));
        }
    }

    completed.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = retainedPartBytes + completed.reduce((total, artifact) => total + artifact.size, 0);
    let totalFiles = completed.length;
    for (const artifact of completed) {
        if (totalBytes <= maxTotalBytes && totalFiles <= maxFiles) break;
        if (protectedPaths.has(artifact.path)) continue;
        try {
            await fs.rm(artifact.path, { force: true });
            totalBytes -= artifact.size;
            totalFiles -= 1;
        } catch (error) {
            errors.push(asError(error));
        }
    }
    return errors;
};

export const pruneArtifacts = async (options = {}) => {
    const artifactDir = options.artifactDir ?? ARTIFACT_DIR;
    const fs = { ...defaultFileSystem, ...(options.fileSystem ?? {}) };
    const platform = options.platform ?? process.platform;
    await ensurePrivateDirectory(artifactDir, fs, platform);
    return withArtifactStoreLock(artifactDir, () => pruneArtifactsUnlocked(options), fs);
};

const artifactTotalBytes = async (artifactDir, fs) => {
    let totalBytes = 0;
    for (const entry of await fs.readdir(artifactDir, { withFileTypes: true })) {
        if (!entry.isFile() || (!entry.name.endsWith('.xlsx') && !entry.name.endsWith('.part'))) continue;
        totalBytes += (await fs.stat(join(artifactDir, entry.name))).size;
    }
    return totalBytes;
};

const artifactCompletedFileCount = async (artifactDir, fs) =>
    (await fs.readdir(artifactDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.xlsx')).length;

/**
 * @param {{
 *     jobId?: string,
 *     fileName?: string,
 *     mimeType?: string,
 *     artifactDir?: string,
 *     maxChunkBytes?: number,
 *     maxFileBytes?: number,
 *     maxJobBytes?: number,
 *     maxTotalBytes?: number,
 *     maxFiles?: number,
 *     retentionMs?: number,
 *     validateXlsx?: boolean,
 *     signal?: AbortSignal,
 *     scheduleCleanupRetry?: (retry: () => Promise<void>, delayMs: number) => void,
 *     fileSystem?: Partial<typeof defaultFileSystem>,
 *     platform?: NodeJS.Platform,
 * }} options
 */
export const createArtifactWriter = async (options = {}) => {
    const {
        jobId,
        fileName,
        mimeType,
        artifactDir = ARTIFACT_DIR,
        maxChunkBytes = ARTIFACT_MAX_CHUNK_BYTES,
        maxFileBytes = ARTIFACT_MAX_FILE_BYTES,
        maxJobBytes = ARTIFACT_MAX_JOB_BYTES,
        maxTotalBytes = ARTIFACT_MAX_TOTAL_BYTES,
        maxFiles = ARTIFACT_MAX_FILES,
        retentionMs = ARTIFACT_RETENTION_MS,
        validateXlsx = false,
        signal,
        scheduleCleanupRetry = defaultScheduleDeferredRelease,
        fileSystem = {},
        platform = process.platform,
    } = options;
    if (typeof jobId !== 'string' || jobId.length === 0) throw new Error('Artifact job ID is required');
    if (typeof mimeType !== 'string' || mimeType.length === 0) throw new Error('Artifact MIME type is required');
    validateLimits({ maxChunkBytes, maxFileBytes, maxJobBytes, maxTotalBytes, maxFiles, retentionMs });
    if (
        signal !== undefined &&
        (typeof signal !== 'object' || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')
    ) {
        throw new TypeError('Artifact writer signal must be an AbortSignal');
    }
    let aborted = false;
    const abortReason = () =>
        signal?.reason instanceof Error ? signal.reason : new Error('Artifact writer is aborted');
    const assertNotAborted = () => {
        if (!aborted && signal?.aborted !== true) return;
        aborted = true;
        throw abortReason();
    };
    assertNotAborted();
    const name = safeArtifactName(fileName);
    const usage = acquireJob(jobId, maxJobBytes);
    const fs = { ...defaultFileSystem, ...fileSystem };
    const identity = randomUUID();
    const partialPath = join(artifactDir, `.active-${process.pid}-${identity}.part`);
    const artifactPath = join(artifactDir, `${identity}-${name}`);
    const pinPath = join(artifactDir, `.active-artifact-${process.pid}-${identity}.pin`);
    try {
        assertNotAborted();
        await ensurePrivateDirectory(artifactDir, fs, platform);
        assertNotAborted();
        await withArtifactStoreLock(artifactDir, async () => {
            assertNotAborted();
            const pruneErrors = await pruneArtifactsUnlocked({ artifactDir, retentionMs, maxTotalBytes, maxFiles, fileSystem: fs, platform });
            assertNotAborted();
            if (pruneErrors.length > 0) throw new Error(`Unable to prune artifact storage: ${pruneErrors[0].message}`);
            assertNotAborted();
            await fs.writeFile(partialPath, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
            assertNotAborted();
            await ensurePrivateFile(partialPath, fs, platform);
            assertNotAborted();
        }, fs);
        assertNotAborted();
    } catch (error) {
        aborted = true;
        usage.writers -= 1;
        try {
            await fs.rm(partialPath, { force: true });
        } catch (cleanupError) {
            throw new AggregateError([asError(error), asError(cleanupError)], 'Artifact writer setup failed and cleanup failed');
        }
        resumeDeferredArtifactRelease(jobId, usage);
        throw asError(error);
    }
    activePartPaths.add(partialPath);

    /** @type {Promise<unknown>} */
    let writeChain = Promise.resolve();
    let nextIndex = 0;
    let byteCount = 0;
    let usageByteCount = 0;
    const hash = createHash('sha256');
    let completed = false;
    let writerClosed = false;
    let usageBytesDiscarded = false;
    let pinRegistered = false;
    let cleanupTracked = false;
    let cleanupCompleted = false;
    let payloadMayExist = false;
    let pinMayExist = false;
    let cleanupPromise;
    let abortCleanupPromise;
    let cleanupRetryAttempts = 0;
    let cleanupRetryScheduled = false;
    const discardUsageBytes = () => {
        if (usageBytesDiscarded) return;
        usage.bytes -= usageByteCount;
        usageBytesDiscarded = true;
    };
    const closeWriter = ({ discardBytes }) => {
        if (discardBytes) discardUsageBytes();
        if (!writerClosed) {
            usage.writers -= 1;
            writerClosed = true;
        }
    };
    const registerPin = () => {
        let pinGroup = usage.pinGroups.get(artifactDir);
        if (!pinGroup) {
            pinGroup = { artifactDir, fileSystem: fs, pinPaths: new Set() };
            usage.pinGroups.set(artifactDir, pinGroup);
        }
        pinGroup.pinPaths.add(pinPath);
        pinRegistered = true;
    };
    const unregisterPin = () => {
        if (!pinRegistered) return;
        const pinGroup = usage.pinGroups.get(artifactDir);
        pinGroup?.pinPaths.delete(pinPath);
        if (pinGroup?.pinPaths.size === 0) usage.pinGroups.delete(artifactDir);
        pinRegistered = false;
    };
    const beginCleanup = () => {
        if (cleanupTracked) return;
        cleanupTracked = true;
        usage.pendingCleanups += 1;
    };
    const finishCleanup = () => {
        cleanupCompleted = true;
        if (!cleanupTracked) return;
        cleanupTracked = false;
        usage.pendingCleanups -= 1;
        resumeDeferredArtifactRelease(jobId, usage);
    };
    const scheduleCleanupRetryAfter = (error) => {
        if (
            cleanupRetryScheduled ||
            cleanupRetryAttempts >= ARTIFACT_CLEANUP_RETRY_LIMIT ||
            !isRetryableArtifactReleaseError(error)
        ) {
            return;
        }
        cleanupRetryScheduled = true;
        try {
            scheduleCleanupRetry(async () => {
                cleanupRetryScheduled = false;
                cleanupRetryAttempts += 1;
                try {
                    await cleanupPaths();
                } catch {
                    // cleanupPaths retains ownership and schedules the next bounded retry when appropriate.
                }
            }, ARTIFACT_CLEANUP_RETRY_DELAY_MS);
        } catch {
            cleanupRetryScheduled = false;
        }
    };
    const cleanupPaths = () => {
        if (cleanupPromise) return cleanupPromise;
        const attempt = (async () => {
            await withArtifactStoreLock(artifactDir, async () => {
                await fs.rm(partialPath, { force: true });
                activePartPaths.delete(partialPath);
                await fs.rm(artifactPath, { force: true });
                payloadMayExist = false;
                await fs.rm(pinPath, { force: true });
                pinMayExist = false;
            }, fs);
            unregisterPin();
            finishCleanup();
        })();
        const observedAttempt = attempt.catch((error) => {
            if (cleanupPromise === observedAttempt) cleanupPromise = undefined;
            if (!payloadMayExist && !pinMayExist && !pinRegistered) finishCleanup();
            scheduleCleanupRetryAfter(error);
            throw error;
        });
        cleanupPromise = observedAttempt;
        return cleanupPromise;
    };
    const abortInternal = async () => {
        aborted = true;
        if (cleanupCompleted) return;
        beginCleanup();
        closeWriter({ discardBytes: true });
        await cleanupPaths();
    };
    const fail = async (error) => {
        const primaryError = asError(error);
        try {
            await abortInternal();
        } catch (cleanupError) {
            const aggregate = new AggregateError([primaryError, asError(cleanupError)], 'Artifact storage failed and cleanup failed');
            if (primaryError instanceof ArtifactStoreError) Object.assign(aggregate, { code: primaryError.code });
            throw aggregate;
        }
        throw primaryError;
    };
    const assertWritable = () => {
        assertNotAborted();
        if (completed) throw new Error('Artifact writer is already complete');
    };
    const requestAbort = () => {
        if (completed && signal === undefined) return writeChain.then(() => undefined);
        aborted = true;
        if (abortCleanupPromise) return abortCleanupPromise;
        if (cleanupCompleted) return Promise.resolve();
        beginCleanup();
        const pendingWrites = writeChain;
        abortCleanupPromise = pendingWrites.then(
            async () => {
                closeWriter({ discardBytes: true });
                await cleanupPaths();
            },
            async () => {
                closeWriter({ discardBytes: true });
                await cleanupPaths();
            }
        );
        writeChain = abortCleanupPromise;
        return abortCleanupPromise;
    };
    if (signal) {
        signal.addEventListener(
            'abort',
            () => {
                void requestAbort().catch(() => undefined);
            },
            { once: true }
        );
        if (signal.aborted) void requestAbort().catch(() => undefined);
    }

    return {
        appendChunk(index, base64Data) {
            writeChain = writeChain.then(async () => {
                try {
                    assertWritable();
                    if (!Number.isSafeInteger(index) || index !== nextIndex) throw new Error(`Unexpected artifact chunk index: expected ${nextIndex}`);
                    const bytes = decodeCanonicalBase64(base64Data, maxChunkBytes);
                    if (bytes.length > maxChunkBytes) throw new Error(`Artifact chunk exceeds the ${maxChunkBytes}-byte chunk limit`);
                    if (byteCount + bytes.length > maxFileBytes) throw new Error(`Artifact exceeds the ${maxFileBytes}-byte per-file limit`);
                    if (usage.bytes + bytes.length > usage.maxJobBytes) {
                        throw new ArtifactStoreError(
                            'JOB_ARTIFACT_QUOTA_EXCEEDED',
                            `Artifact job quota exceeds the ${usage.maxJobBytes}-byte limit`
                        );
                    }
                    assertNotAborted();
                    await withArtifactStoreLock(artifactDir, async () => {
                        assertNotAborted();
                        // Measured fresh under the lock on every chunk. Carrying a per-writer running total
                        // instead would let a concurrent process's writes go unseen, so this writer could
                        // keep appending past the shared quota by as much as its own remaining file.
                        let totalBytes = await artifactTotalBytes(artifactDir, fs);
                        assertNotAborted();
                        if (totalBytes + bytes.length > maxTotalBytes) {
                            assertNotAborted();
                            await pruneArtifactsUnlocked({
                                artifactDir,
                                retentionMs,
                                maxTotalBytes: maxTotalBytes - bytes.length,
                                maxFiles,
                                excludePaths: [partialPath, artifactPath],
                                fileSystem: fs,
                                platform,
                            });
                            assertNotAborted();
                            totalBytes = await artifactTotalBytes(artifactDir, fs);
                            assertNotAborted();
                        }
                        if (totalBytes + bytes.length > maxTotalBytes) {
                            throw new ArtifactStoreError(
                                'ARTIFACT_TOTAL_QUOTA_EXCEEDED',
                                `Artifact storage quota exceeds the ${maxTotalBytes}-byte limit`
                            );
                        }
                        usage.bytes += bytes.length;
                        usageByteCount += bytes.length;
                        try {
                            assertNotAborted();
                            await fs.appendFile(partialPath, bytes);
                            assertNotAborted();
                        } catch (error) {
                            usage.bytes -= bytes.length;
                            usageByteCount -= bytes.length;
                            throw error;
                        }
                    }, fs);
                    assertNotAborted();
                    byteCount += bytes.length;
                    hash.update(bytes);
                    nextIndex += 1;
                } catch (error) {
                    await fail(error);
                }
            });
            return writeChain;
        },
        /** @param {{ size?: number, sha256?: string }} completion */
        complete(completion = {}) {
            const { size, sha256 } = completion;
            writeChain = writeChain.then(async () => {
                try {
                    assertWritable();
                    if (!Number.isSafeInteger(size) || size < 0 || size !== byteCount) throw new Error('Artifact declared size does not match written bytes');
                    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Artifact SHA-256 must be a lowercase hexadecimal digest');
                    if (hash.digest('hex') !== sha256) throw new Error('Artifact SHA-256 does not match written bytes');
                    assertNotAborted();
                    if (validateXlsx) {
                        assertNotAborted();
                        const workbook = await fs.readFile(partialPath);
                        assertNotAborted();
                        assertXlsxPackage(workbook);
                        assertNotAborted();
                    }
                    assertNotAborted();
                    await withArtifactStoreLock(artifactDir, async () => {
                        assertNotAborted();
                        payloadMayExist = true;
                        await fs.rename(partialPath, artifactPath);
                        assertNotAborted();
                        activePartPaths.delete(partialPath);
                        assertNotAborted();
                        await ensurePrivateFile(artifactPath, fs, platform);
                        assertNotAborted();
                        pinMayExist = true;
                        await fs.writeFile(pinPath, basename(artifactPath), { mode: 0o600, flag: 'wx' });
                        assertNotAborted();
                        await ensurePrivateFile(pinPath, fs, platform);
                        assertNotAborted();
                        const pruneErrorsAfterPublish = await pruneArtifactsUnlocked({
                            artifactDir,
                            retentionMs,
                            maxTotalBytes,
                            maxFiles,
                            excludePaths: [artifactPath],
                            fileSystem: fs,
                            platform,
                        });
                        assertNotAborted();
                        if (pruneErrorsAfterPublish.length > 0) throw new Error(`Unable to prune artifact storage: ${pruneErrorsAfterPublish[0].message}`);
                        assertNotAborted();
                        const completedFileCount = await artifactCompletedFileCount(artifactDir, fs);
                        assertNotAborted();
                        if (completedFileCount > maxFiles) {
                            throw new ArtifactStoreError(
                                'ARTIFACT_FILE_QUOTA_EXCEEDED',
                                `Artifact storage quota exceeds the ${maxFiles}-file limit`,
                                { retryable: true }
                            );
                        }
                    }, fs);
                    assertNotAborted();
                    const artifact = { name, path: artifactPath, uri: pathToFileURL(artifactPath).href, mimeType, size: byteCount, sha256 };
                    assertNotAborted();
                    registerPin();
                    assertNotAborted();
                    completed = true;
                    closeWriter({ discardBytes: false });
                    resumeDeferredArtifactRelease(jobId, usage);
                    return artifact;
                } catch (error) {
                    await fail(error);
                }
            });
            return writeChain;
        },
        abort() {
            return requestAbort();
        },
    };
};
