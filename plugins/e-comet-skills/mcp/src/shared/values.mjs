// Value checks several modules share (refactor spec §6.3).
// A version-4 UUID as e-Comet generates it, in lower-case hex: artifact, result and report ids.
export const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
// Any non-array object. Read its fields one by one: an inherited key reads the same as an own one, so a parser that
// must tell them apart also checks the keys with one of the own-key checks below.
export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// The field `key` of a non-array object, undefined for anything else: `value?.[key]` for a parsed JSON value.
export const fieldOf = (value, key) => (isRecord(value) ? value[key] : undefined);
// Array.isArray whose elements stay unknown instead of any.
export const isUnknownArray = (value) => Array.isArray(value);
// Exactly the expected own keys, no more and no fewer.
export const hasExactOwnKeys = (value, expected) => {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};
// Every expected key is own; other own keys may exist, as fields a later contract adds.
export const hasOwnKeys = (value, expected) => expected.every((key) => Object.hasOwn(value, key));
export const isBoundedText = (value, maxLength) => typeof value === 'string' && value.length > 0 && value.length <= maxLength;
export const isNonNegativeSafeInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const isPositiveSafeInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
// One of `values`, compared with SameValueZero as Array.prototype.includes does.
export const isOneOf = (values, value) => values.includes(value);
// Every own key is one of `allowed`; an allowed key may be absent.
export const hasOnlyOwnKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
// A canonical 24-character UTC timestamp, the only time form every report consumer accepts.
export const isCanonicalTimestamp = (value) => {
    if (typeof value !== 'string' || value.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
        return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
};
