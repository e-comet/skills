// The one JSON-schema validator every producer and consumer in this package shares. It lives in a
// module that imports nothing, so the feedback projection can validate facts against the producers'
// own exported schemas without importing the tool catalog that imports the projection.
const canonicalUniqueValue = (value, ancestors = new Set()) => {
    if (value === null) return 'null';
    if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
    if (typeof value === 'number') return `number:${Number.isNaN(value) ? 'NaN' : String(value)}`;
    if (typeof value === 'boolean') return `boolean:${value}`;
    if (typeof value === 'undefined') return 'undefined';
    if (typeof value === 'bigint') return `bigint:${value}`;
    if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
    if (ancestors.has(value)) throw new TypeError('Schema values must not contain cycles.');
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return `array:[${Array.from({ length: value.length }, (_, index) =>
                Object.hasOwn(value, index) ? canonicalUniqueValue(value[index], ancestors) : 'hole'
            ).join(',')}]`;
        }
        return `object:{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalUniqueValue(value[key], ancestors)}`)
            .join(',')}}`;
    } finally {
        ancestors.delete(value);
    }
};

const hasUniqueItems = (values) => {
    const primitiveValues = new Set();
    const structuredValues = new Set();
    try {
        for (const value of values) {
            if (value !== null && typeof value === 'object') {
                const identity = canonicalUniqueValue(value);
                if (structuredValues.has(identity)) return false;
                structuredValues.add(identity);
            } else {
                if (primitiveValues.has(value)) return false;
                primitiveValues.add(value);
            }
        }
    } catch {
        return false;
    }
    return true;
};

export const validateSchemaValue = (value, schema) => {
    if (schema.allOf && !schema.allOf.every((candidate) => validateSchemaValue(value, candidate))) return false;
    if (schema.contains) {
        if (!Array.isArray(value)) return false;
        const matches = value.filter((item) => validateSchemaValue(item, schema.contains)).length;
        if (matches < (schema.minContains ?? 1) || matches > (schema.maxContains ?? Infinity)) return false;
    }
    if (schema.oneOf) {
        return schema.oneOf.filter((candidate) => validateSchemaValue(value, candidate)).length === 1;
    }
    if (Object.hasOwn(schema, 'const')) return Object.is(value, schema.const);
    if (!schema.type) return true;
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const properties = schema.properties || {};
        if ((schema.required || []).some((name) => !Object.hasOwn(value, name))) return false;
        return Object.entries(value).every(([name, propertyValue]) => {
            if (!Object.hasOwn(properties, name)) {
                if (schema.additionalProperties === false) return false;
                if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                    return validateSchemaValue(propertyValue, schema.additionalProperties);
                }
                return true;
            }
            const propertySchema = properties[name];
            return validateSchemaValue(propertyValue, propertySchema);
        });
    }
    if (schema.type === 'array') {
        if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
        if (!value.every((item) => validateSchemaValue(item, schema.items))) return false;
        return !schema.uniqueItems || hasUniqueItems(value);
    }
    if (schema.type === 'string') {
        return (
            typeof value === 'string' &&
            value.length >= (schema.minLength ?? 0) &&
            value.length <= (schema.maxLength ?? Infinity) &&
            (!schema.enum || schema.enum.includes(value)) &&
            (!schema.pattern || new RegExp(schema.pattern).test(value))
        );
    }
    if (schema.type === 'integer') {
        return (
            Number.isSafeInteger(value) &&
            value >= (schema.minimum ?? -Infinity) &&
            value <= (schema.maximum ?? Infinity)
        );
    }
    if (schema.type === 'number') {
        return (
            typeof value === 'number' &&
            Number.isFinite(value) &&
            value >= (schema.minimum ?? -Infinity) &&
            value <= (schema.maximum ?? Infinity) &&
            value > (schema.exclusiveMinimum ?? -Infinity) &&
            value < (schema.exclusiveMaximum ?? Infinity)
        );
    }
    if (schema.type === 'boolean') return typeof value === 'boolean';
    if (schema.type === 'null') return value === null;
    return false;
};
