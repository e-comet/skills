import { writeZip, ZIP_END_RECORD_BYTES, zipEntryFramingBytes } from '../../../../storage/writers/zip.mjs';
import { FEEDBACK_MAX_BYTES } from '../../domain/constants/limits.const.mjs';
const assertBytes = (value, name, { allowEmpty = true } = {}) => {
    if (!Buffer.isBuffer(value))
        throw new TypeError(`Feedback ${name} bytes must be a Buffer`);
    if (!allowEmpty && value.length === 0)
        throw new RangeError(`Feedback ${name} bytes must not be empty`);
};
const entryNames = (includeTranscript, includeExtensionLog = false) => [
    'report.md',
    'metadata.json',
    ...(includeTranscript ? ['transcript.jsonl'] : []),
    ...(includeExtensionLog ? ['extension-log.json'] : []),
];
export const feedbackZipFramingBytes = ({ includeTranscript = false, includeExtensionLog = false } = {}) => entryNames(includeTranscript, includeExtensionLog)
    .map((name) => Buffer.from(name, 'utf8'))
    .reduce((total, nameBytes) => total + zipEntryFramingBytes(nameBytes), ZIP_END_RECORD_BYTES);
export const createFeedbackZip = async ({ reportBytes, metadataBytes, transcriptBytes, extensionLogBytes, } = {}, options = {}) => {
    const { maxBytes = FEEDBACK_MAX_BYTES } = options;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new RangeError('Feedback package byte limit must be a positive safe integer');
    assertBytes(reportBytes, 'report', { allowEmpty: false });
    assertBytes(metadataBytes, 'metadata', { allowEmpty: false });
    if (transcriptBytes !== undefined)
        assertBytes(transcriptBytes, 'transcript');
    if (extensionLogBytes !== undefined)
        assertBytes(extensionLogBytes, 'extension log', { allowEmpty: false });
    const entries = [
        { name: 'report.md', bytes: reportBytes },
        { name: 'metadata.json', bytes: metadataBytes },
        ...(transcriptBytes === undefined ? [] : [{ name: 'transcript.jsonl', bytes: transcriptBytes }]),
        ...(extensionLogBytes === undefined ? [] : [{ name: 'extension-log.json', bytes: extensionLogBytes }]),
    ];
    const framingBytes = feedbackZipFramingBytes({
        includeTranscript: transcriptBytes !== undefined,
        includeExtensionLog: extensionLogBytes !== undefined,
    });
    const totalEntryBytes = entries.reduce((total, entry) => total + entry.bytes.length, 0);
    if (totalEntryBytes + framingBytes > maxBytes) {
        throw new RangeError(`Feedback combined entries and ZIP framing exceed the ${maxBytes}-byte package limit`);
    }
    // Awaited, so a failure inside the generic writer keeps this module in its bug-report source frame.
    return await writeZip(entries);
};
