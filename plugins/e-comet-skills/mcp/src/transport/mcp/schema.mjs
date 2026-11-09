// The JSON-schema builders every tool contract and result fragment composes its schemas from (spec §7.1).
export const string = { type: 'string' };
export const boolean = { type: 'boolean' };
export const number = { type: 'number' };
export const integer = { type: 'integer' };
export const positiveNumber = { type: 'number', exclusiveMinimum: 0 };
export const positiveInteger = { type: 'integer', minimum: 1 };
export const nonNegativeInteger = { type: 'integer', minimum: 0 };
export const nullableNonNegativeInteger = { oneOf: [nonNegativeInteger, { type: 'null' }] };
export const object = (properties, required = [], additionalProperties = false) => ({
    type: 'object',
    properties,
    required,
    additionalProperties,
});
export const array = (items, extra = {}) => ({ type: 'array', items, ...extra });
export const objectUnion = (...schemas) => ({ type: 'object', oneOf: schemas });
export const described = (schema, description) => ({ ...schema, description });
export const nullable = (schema, nullDescription) => ({
    oneOf: [schema, described({ type: 'null' }, nullDescription)],
});
