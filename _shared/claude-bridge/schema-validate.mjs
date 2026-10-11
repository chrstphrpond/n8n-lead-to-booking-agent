// Small JSON Schema subset used by claude-bridge to check (a) that a request's schema only uses
// keywords this validator understands, and (b) that the CLI's structured_output really matches it.
// Zero dependencies. Error messages name paths and keywords only, never the values being checked.

const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']);
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples']);
const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'const',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'items', 'minItems', 'maxItems',
]);
const MAX_DEPTH = 32;

export const SUPPORTED_KEYWORDS = [...KEYWORDS].sort();

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isInteger(value) && value >= 0;

// Throws Error with a readable message when the schema itself is unusable. Root type must be "object".
export function checkSchemaDefinition(schema) {
  if (!isPlainObject(schema)) throw new Error('schema must be a JSON object');
  if (schema.type !== 'object') throw new Error('schema root "type" must be "object"');
  walkDefinition(schema, '$', 0);
}

function walkDefinition(schema, at, depth) {
  if (depth > MAX_DEPTH) throw new Error(`schema nests deeper than ${MAX_DEPTH} levels`);
  if (typeof schema === 'boolean') return;
  if (!isPlainObject(schema)) throw new Error(`schema at ${at} must be an object or boolean`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) {
      throw new Error(`schema keyword "${key}" at ${at} is not supported (supported: ${SUPPORTED_KEYWORDS.join(', ')})`);
    }
  }
  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.length === 0 || !types.every(t => TYPES.has(t))) throw new Error(`schema "type" at ${at} is invalid`);
  }
  if ('properties' in schema) {
    if (!isPlainObject(schema.properties)) throw new Error(`"properties" at ${at} must be an object`);
    for (const [name, sub] of Object.entries(schema.properties)) walkDefinition(sub, `${at}.${name}`, depth + 1);
  }
  if ('required' in schema && !(Array.isArray(schema.required) && schema.required.every(r => typeof r === 'string'))) {
    throw new Error(`"required" at ${at} must be an array of strings`);
  }
  if ('additionalProperties' in schema && typeof schema.additionalProperties !== 'boolean') {
    walkDefinition(schema.additionalProperties, `${at}.<additional>`, depth + 1);
  }
  if ('enum' in schema && !(Array.isArray(schema.enum) && schema.enum.length > 0)) throw new Error(`"enum" at ${at} must be a non-empty array`);
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (key in schema && !Number.isFinite(schema[key])) throw new Error(`"${key}" at ${at} must be a number`);
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (key in schema && !isCount(schema[key])) throw new Error(`"${key}" at ${at} must be a non-negative integer`);
  }
  if ('items' in schema) {
    if (Array.isArray(schema.items)) throw new Error(`tuple "items" at ${at} is not supported`);
    walkDefinition(schema.items, `${at}[]`, depth + 1);
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'non-finite';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'integer') return actual === 'number' && Number.isInteger(value);
  return actual === type || (type === 'number' && actual === 'number');
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

// Returns an array of error strings (empty when the value is valid). Stops after `limit` errors.
export function validate(schema, value, { limit = 20 } = {}) {
  const errors = [];
  check(schema, value, '$', errors, limit);
  return errors;
}

function check(schema, value, at, errors, limit) {
  if (errors.length >= limit) return;
  if (schema === true) return;
  if (schema === false) { errors.push(`${at}: not allowed`); return; }

  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchesType(value, t))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if ('const' in schema && !deepEqual(schema.const, value)) errors.push(`${at}: does not equal const`);
  if ('enum' in schema && !schema.enum.some(option => deepEqual(option, value))) errors.push(`${at}: not one of the enum values`);

  const kind = typeOf(value);
  if (kind === 'number') {
    if ('minimum' in schema && value < schema.minimum) errors.push(`${at}: below minimum ${schema.minimum}`);
    if ('maximum' in schema && value > schema.maximum) errors.push(`${at}: above maximum ${schema.maximum}`);
    if ('exclusiveMinimum' in schema && value <= schema.exclusiveMinimum) errors.push(`${at}: not above exclusiveMinimum ${schema.exclusiveMinimum}`);
    if ('exclusiveMaximum' in schema && value >= schema.exclusiveMaximum) errors.push(`${at}: not below exclusiveMaximum ${schema.exclusiveMaximum}`);
  }
  if (kind === 'string') {
    const length = [...value].length;
    if ('minLength' in schema && length < schema.minLength) errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    if ('maxLength' in schema && length > schema.maxLength) errors.push(`${at}: longer than maxLength ${schema.maxLength}`);
  }
  if (kind === 'array') {
    if ('minItems' in schema && value.length < schema.minItems) errors.push(`${at}: fewer than minItems ${schema.minItems}`);
    if ('maxItems' in schema && value.length > schema.maxItems) errors.push(`${at}: more than maxItems ${schema.maxItems}`);
    if ('items' in schema) value.forEach((item, i) => check(schema.items, item, `${at}[${i}]`, errors, limit));
  }
  if (kind === 'object') {
    const properties = schema.properties || {};
    for (const name of schema.required || []) {
      if (!Object.hasOwn(value, name)) errors.push(`${at}: missing required property "${name}"`);
    }
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) check(properties[name], child, `${at}.${name}`, errors, limit);
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property "${name}"`);
      else if (isPlainObject(schema.additionalProperties)) check(schema.additionalProperties, child, `${at}.${name}`, errors, limit);
    }
  }
}
