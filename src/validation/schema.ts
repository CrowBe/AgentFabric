import { Ajv, type ValidateFunction } from 'ajv';
import { default as formats } from 'ajv-formats';
import { GatewayError, type JsonSchemaObject } from '../types/index.js';

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true, addUsedSchema: false, ownProperties: true });
(formats as unknown as (instance: Ajv) => void)(ajv);

export function strictSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const result = structuredClone(schema);
  function visit(node: unknown) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const shape = node as JsonSchemaObject;
    const additional = shape.additionalProperties;
    const typed = additional && typeof additional === 'object' &&
      ['type', '$ref', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'properties', 'patternProperties'].some(key => Object.hasOwn(additional, key));
    if (shape.properties && additional !== false && !typed) shape.additionalProperties = false;
    for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependencies', 'dependentSchemas']) {
      const children = shape[key];
      if (children && typeof children === 'object') for (const child of Object.values(children)) visit(child);
    }
    for (const key of ['allOf', 'oneOf', 'anyOf', 'prefixItems', 'items', 'contains', 'additionalItems',
      'propertyNames', 'additionalProperties', 'not', 'if', 'then', 'else']) {
      const child = shape[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(result);
  return result;
}

const validators = new Map<string, ValidateFunction>();
export function validateArguments(schema: JsonSchemaObject, args: unknown): asserts args is Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new GatewayError('INVALID_INPUT', 'Arguments must be an object');
  let validate: ValidateFunction;
  try {
    const key = JSON.stringify(schema);
    const cached = validators.get(key);
    validate = cached ?? ajv.compile(strictSchema(schema));
    if (!cached) {
      if (validators.size >= 256) validators.delete(validators.keys().next().value!);
      validators.set(key, validate);
    }
  } catch (cause) {
    throw new GatewayError('INVALID_INPUT', 'Invalid capability input schema', { cause });
  }
  if (!validate(args)) {
    const issues = validate.errors?.map(({ instancePath, message, params }) => ({
      path: instancePath || '/', message, ...params,
    })) ?? [];
    const summary = issues.map(issue => `${issue.path} ${issue.message}`).join(', ');
    throw new GatewayError('INVALID_INPUT', `Invalid arguments: ${summary}`, { details: { issues } });
  }
}

export const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
