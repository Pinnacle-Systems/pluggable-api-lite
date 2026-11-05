import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';

// Oracle 11g identifiers: up to 30 chars, letters/digits/_/$/#, starting with a letter.
const DB_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_$#]{0,29}$/;
// Field names become Oracle column aliases, so the same length limit applies.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;
const MODEL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FIELD_TYPES = ['string', 'integer', 'decimal', 'date'];
// `page`/`limit` are query parameters; `rownum_` is the helper column added by pagination.
const RESERVED_FIELDS = ['page', 'limit', 'rownum_'];

const fail = (message) => {
  throw new Error(`Config error: ${message}`);
};

function readYaml(file) {
  try {
    return parse(readFileSync(file, 'utf8')) ?? {};
  } catch (err) {
    return fail(`cannot read ${file}: ${err.message}`);
  }
}

function substituteEnv(value, env, where) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => {
      if (!env[name]) fail(`${where} references ${name}, which is not set`);
      return env[name];
    });
  }
  return value;
}

function loadDatabase(configDir, env) {
  const file = join(configDir, 'database.yaml');
  const raw = readYaml(file);
  if (raw.type !== 'oracle') fail(`${file}: type must be "oracle"`);
  const database = { type: raw.type };
  for (const key of ['connectString', 'user', 'password']) {
    if (typeof raw[key] !== 'string' || !raw[key]) fail(`${file}: ${key} is required`);
    database[key] = substituteEnv(raw[key], env, `${file}: ${key}`);
  }
  return database;
}

function loadModel(configDir, name, entry) {
  const where = `models.yaml: model "${name}"`;
  if (!MODEL_NAME.test(name)) fail(`${where} has an invalid name`);
  if (!entry || typeof entry !== 'object') fail(`${where} must be an object`);

  const { owner, table, schema } = entry;
  if (owner !== undefined && !DB_IDENTIFIER.test(owner)) fail(`${where}: invalid owner`);
  if (!DB_IDENTIFIER.test(table ?? '')) fail(`${where}: invalid table`);
  // Schema files must live directly in config/schemas.
  if (typeof schema !== 'string' || basename(schema) !== schema) fail(`${where}: invalid schema file`);

  const file = join(configDir, 'schemas', schema);
  const def = readYaml(file);
  const at = `${schema} (model "${name}")`;

  const fields = {};
  for (const [field, spec] of Object.entries(def.fields ?? {})) {
    if (!FIELD_NAME.test(field) || RESERVED_FIELDS.includes(field.toLowerCase())) {
      fail(`${at}: invalid field name "${field}"`);
    }
    if (!DB_IDENTIFIER.test(spec?.column ?? '')) fail(`${at}: field "${field}" has an invalid column`);
    if (!FIELD_TYPES.includes(spec.type)) {
      fail(`${at}: field "${field}" type must be one of ${FIELD_TYPES.join(', ')}`);
    }
    // Oracle folds unquoted identifiers to upper case; the engine quotes them, so store them upper-cased.
    fields[field] = { column: spec.column.toUpperCase(), type: spec.type };
  }
  if (!Object.keys(fields).length) fail(`${at}: fields must not be empty`);
  if (!fields[def.primaryKey]) fail(`${at}: primaryKey must be a defined field`);

  const policy = def.policy ?? {};
  const filters = policy.filters ?? [];
  for (const f of filters) {
    if (!fields[f]) fail(`${at}: policy.filters references unknown field "${f}"`);
  }

  return {
    name,
    owner: owner?.toUpperCase(),
    table: table.toUpperCase(),
    primaryKey: def.primaryKey,
    fields,
    filters: new Set(filters),
    list: policy.list === true,
    get: policy.get === true,
  };
}

export function loadConfig(configDir = 'config', env = process.env) {
  const database = loadDatabase(configDir, env);
  const entries = readYaml(join(configDir, 'models.yaml'));
  if (!Object.keys(entries).length) fail('models.yaml defines no models');

  const models = new Map();
  for (const [name, entry] of Object.entries(entries)) {
    models.set(name, loadModel(configDir, name, entry));
  }
  return { database, models };
}
