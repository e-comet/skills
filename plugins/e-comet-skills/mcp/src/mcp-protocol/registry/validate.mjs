import { validateSchemaValue } from '../../shared/schema-validate.mjs';
import { isRecord } from '../../shared/values.mjs';
// `property` names the first failing property of our own schema; an unknown property is never echoed, it reads ''.
export const validateArguments = (schema, args) => {
    if (schema && validateSchemaValue(args, schema))
        return { ok: true };
    const properties = schema?.properties ?? {};
    const input = isRecord(args) ? args : {};
    const property = (schema?.required ?? []).find((key) => !Object.hasOwn(input, key)) ??
        Object.entries(properties).find(([key, propertySchema]) => Object.hasOwn(input, key) && !validateSchemaValue(input[key], propertySchema))?.[0] ??
        '';
    return { ok: false, property };
};
export const invalidArgumentsMessage = (name, { property }) => property === 'triggerUrl'
    ? `Invalid ${name} argument: omit triggerUrl; the host hook supplies it after browser_job. Only for an mcp__remote-devices__ tool, pass the browser_job trigger_url unchanged.`
    : property
        ? `Invalid ${name} argument: ${property} is missing or does not match the tool's input schema. Correct it and retry.`
        : `Invalid ${name} arguments: an argument is not in the tool's input schema. Send only the documented properties and retry.`;
