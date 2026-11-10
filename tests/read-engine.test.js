import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import knex from 'knex';
import { loadConfig } from '../src/config-loader.js';
import { ApiError, createReadEngine } from '../src/read-engine.js';
import { buildApp } from '../src/server.js';

const env = { DB_CONNECT_STRING: 'host/svc', DB_USER: 'u', DB_PASSWORD: 'p' };
// Builds SQL only; never connects.
const db = knex({ client: 'oracledb' });
const sql = (query) => query.toSQL();

// Fixture config: GTSORDER (uppercase, with primary key) plus quoted lowercase / mixed-case / spaced columns.
const ORDERS_SCHEMA = `primaryKey: orderId
fields:
  orderId: { column: GTSORDERID, type: integer }
  documentId: { column: DOCID, type: string }
  documentDate: { column: DOCDATE, type: date }
  customer: { column: CUSTOMER, type: string }
  netAmount: { column: NETAMOUNT, type: decimal }
policy:
  list: true
  get: true
  filters: [orderId, documentId, customer]
`;
const MIXED_SCHEMA = `primaryKey: serialNo
fields:
  serialNo: { column: srno, type: integer }
  erpNumber: { column: erp_no, type: string }
  receivedDate: { column: Recd_Date, type: date }
  supplierCode: { column: Supplier_code, type: string }
policy:
  list: true
  get: false
  filters: [erpNumber, receivedDate, supplierCode]
`;
const SPACED_SCHEMA = `primaryKey: serialNo
fields:
  serialNo:
    column: SR NO
    type: integer
  erpNumber: { column: erp_no, type: string }
policy:
  list: true
  filters: [serialNo, erpNumber]
`;
const NO_KEY_SCHEMA = `fields:
  erpNumber: { column: erp_no, type: string }
policy:
  list: true
  filters: [erpNumber]
`;

// Writes a throwaway config dir. `overrides` replaces schema files by name.
function fixtureDir(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  mkdirSync(join(dir, 'schemas'));
  writeFileSync(
    join(dir, 'database.yaml'),
    'type: oracle\nconnectString: ${DB_CONNECT_STRING}\nuser: ${DB_USER}\npassword: ${DB_PASSWORD}\n',
  );
  writeFileSync(
    join(dir, 'models.yaml'),
    [
      'orders: { owner: PSSMGI, table: GTSORDER, schema: orders.yaml }',
      'mixed: { owner: PSSBSA, table: FABRICINT, schema: mixed.yaml }',
      'spaced: { owner: PSSBSA, table: CMTINT, schema: spaced.yaml }',
      'nokey: { owner: PSSBSA, table: BOMINT, schema: nokey.yaml }',
      '',
    ].join('\n'),
  );
  const schemas = {
    'orders.yaml': ORDERS_SCHEMA,
    'mixed.yaml': MIXED_SCHEMA,
    'spaced.yaml': SPACED_SCHEMA,
    'nokey.yaml': NO_KEY_SCHEMA,
    ...overrides,
  };
  for (const [name, text] of Object.entries(schemas)) writeFileSync(join(dir, 'schemas', name), text);
  return dir;
}

const dir = fixtureDir();
const models = loadConfig(dir, env).models;
const engine = createReadEngine(db, models);
const list = (model, params = {}) => sql(engine.buildListQuery(model, { page: 1, limit: 10, ...params }));
// Loads the fixture with the "orders" schema replaced by `text`.
const loadOrdersSchema = (text) => loadConfig(fixtureDir({ 'orders.yaml': text }), env);

// Same query building as production, but the builder resolves to canned rows instead of connecting.
const cannedDb = (rows) => ({
  raw: (...args) => db.raw(...args),
  withSchema: (owner) => {
    const builder = db.withSchema(owner);
    const from = builder.from.bind(builder);
    builder.from = (table) => {
      const query = from(table);
      query.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return query;
    };
    return builder;
  },
});

test('config loads and preserves identifier case exactly', () => {
  const { database } = loadConfig(dir, env);
  assert.equal(database.connectString, 'host/svc');
  assert.equal(models.get('orders').owner, 'PSSMGI');
  assert.equal(models.get('orders').fields.orderId.column, 'GTSORDERID'); // uppercase
  const mixed = models.get('mixed');
  assert.equal(mixed.table, 'FABRICINT');
  assert.equal(mixed.fields.serialNo.column, 'srno'); // lowercase
  assert.equal(mixed.fields.receivedDate.column, 'Recd_Date'); // mixed case
  assert.equal(mixed.fields.supplierCode.column, 'Supplier_code');
  assert.equal(models.get('spaced').fields.serialNo.column, 'SR NO'); // inner space, no literal quotes
  assert.deepEqual([...mixed.filters], ['erpNumber', 'receivedDate', 'supplierCode']);
});

test('owner and table spelling is preserved, not upper-cased', () => {
  const d = fixtureDir();
  writeFileSync(join(d, 'models.yaml'), 'orders: { owner: pssmgi, table: GtsOrder, schema: orders.yaml }\n');
  const model = loadConfig(d, env).models.get('orders');
  assert.equal(model.owner, 'pssmgi');
  assert.equal(model.table, 'GtsOrder');
});

test('uppercase GTSORDER queries keep working', () => {
  const { sql: text, bindings } = list('orders', { customer: 'ACME' });
  assert.match(text, /"GTSORDERID" as "orderId"/);
  assert.match(text, /"NETAMOUNT" as "netAmount"/);
  assert.match(text, /TO_CHAR\("DOCDATE", 'YYYY-MM-DD"T"HH24:MI:SS'\) as "documentDate"/);
  assert.match(text, /from "PSSMGI"\."GTSORDER"/);
  assert.match(text, /"CUSTOMER" = \?/);
  assert.match(text, /order by "GTSORDERID"/);
  assert.ok(bindings.includes('ACME'));
  const get = sql(engine.buildGetQuery('orders', '101'));
  assert.match(get.sql, /"GTSORDERID" = \?/);
  assert.ok(get.bindings.includes(101));
  assert.throws(() => engine.buildGetQuery('orders', 'abc'), { status: 400 });
});

test('lowercase and mixed-case identifiers are quoted with their original case', () => {
  const { sql: text } = list('mixed', { supplierCode: 'S1' });
  assert.match(text, /from "PSSBSA"\."FABRICINT"/);
  assert.match(text, /"srno" as "serialNo"/);
  assert.match(text, /"erp_no" as "erpNumber"/);
  assert.match(text, /TO_CHAR\("Recd_Date", 'YYYY-MM-DD"T"HH24:MI:SS'\) as "receivedDate"/);
  assert.match(text, /"Supplier_code" as "supplierCode"/);
  assert.match(text, /"Supplier_code" = \?/);
  assert.match(text, /order by "srno"/);
  assert.doesNotMatch(text, /"SRNO"|"ERP_NO"|"RECD_DATE"|"SUPPLIER_CODE"/);

  const dated = list('mixed', { receivedDate: '2026-11-05' });
  assert.match(dated.sql, /TRUNC\("Recd_Date"\) = TO_DATE\(\?, 'YYYY-MM-DD'\)/);
  assert.ok(dated.bindings.includes('2026-11-05'));
});

test('column names containing spaces are quoted as a single identifier', () => {
  const { sql: text, bindings } = list('spaced', { serialNo: '7' });
  assert.match(text, /"SR NO" as "serialNo"/);
  assert.match(text, /"SR NO" = \?/);
  assert.match(text, /order by "SR NO"/);
  assert.ok(bindings.includes(7));
});

const SPACED_FIELD_SCHEMA = `primaryKey: "SR NO"
fields:
  "SR NO": { column: SR NO, type: integer }
  erp_no: { column: erp_no, type: string }
  Mixed_Case: { column: Mixed_Case, type: string }
policy:
  list: true
  get: true
  filters: ["SR NO", erp_no]
`;

test('field names containing spaces are accepted and kept exactly', () => {
  const model = loadOrdersSchema(SPACED_FIELD_SCHEMA).models.get('orders');
  assert.deepEqual(Object.keys(model.fields), ['SR NO', 'erp_no', 'Mixed_Case']);
  assert.equal(model.primaryKey, 'SR NO');
  assert.ok(model.filters.has('SR NO'));
  assert.throws(
    () => loadOrdersSchema('primaryKey: "SR  NO"\nfields:\n  "SR NO": { column: A, type: string }\n'),
    /primaryKey must be a defined field/,
  );
  assert.throws(
    () => loadOrdersSchema('fields:\n  "SR NO": { column: A, type: string }\npolicy:\n  filters: ["sr no"]\n'),
    /unknown field "sr no"/,
  );
});

test('unsafe field names are rejected at startup', () => {
  const badFields = [
    ' SR NO',
    'SR NO ',
    'SR\tNO',
    'SR\nNO',
    'A; DROP TABLE X',
    'A"B',
    '"SR NO"',
    "A'B",
    'A--x',
    'A/*x*/',
    'A,B',
    'A.B',
    'A (B)',
    'A AS B',
    'A as B',
    '1A',
    'Page',
    'A'.repeat(31),
  ];
  for (const field of badFields) {
    const schema = `fields:\n  ${JSON.stringify(field)}: { column: A, type: string }\n`;
    assert.throws(() => loadOrdersSchema(schema), /invalid field name/, `field ${JSON.stringify(field)}`);
  }
});

test('spaced field names are quoted as one identifier for column and alias, with values bound', () => {
  const spacedEngine = createReadEngine(db, loadOrdersSchema(SPACED_FIELD_SCHEMA).models);
  const { sql: text, bindings } = sql(
    spacedEngine.buildListQuery('orders', { page: 1, limit: 10, 'SR NO': '7', erp_no: 'E1' }),
  );
  assert.match(text, /"SR NO" as "SR NO"/);
  assert.match(text, /"Mixed_Case" as "Mixed_Case"/);
  assert.match(text, /"erp_no" as "erp_no"/);
  assert.match(text, /"SR NO" = \?/);
  assert.match(text, /order by "SR NO"/);
  assert.ok(bindings.includes(7) && bindings.includes('E1'));
  const get = sql(spacedEngine.buildGetQuery('orders', '7'));
  assert.match(get.sql, /"SR NO" = \?/);
  assert.ok(get.bindings.includes(7));
});

test('JSON responses keep the "SR NO" key exactly, including over HTTP', async () => {
  const rows = [{ 'SR NO': '5', erp_no: 'E1', Mixed_Case: null, ignored: 'x' }];
  const spacedEngine = createReadEngine(cannedDb(rows), loadOrdersSchema(SPACED_FIELD_SCHEMA).models);
  const expected = { 'SR NO': 5, erp_no: 'E1', Mixed_Case: null };
  assert.deepEqual((await spacedEngine.list('orders', { page: 1, limit: 10 })).data, [expected]);

  const app = buildApp({ engine: spacedEngine, apiKey: 'secret', logger: false });
  const res = await app.inject({ url: '/api/orders?SR%20NO=5', headers: { 'x-api-key': 'secret' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().data, [expected]);
  assert.ok(res.body.includes('"SR NO":5'));
  await app.close();
});

test('list-only models work without a primaryKey (no ORDER BY)', async () => {
  const nokey = models.get('nokey');
  assert.equal(nokey.primaryKey, undefined);
  const { sql: text } = list('nokey', { erpNumber: 'E1' });
  assert.match(text, /"erp_no" as "erpNumber"/);
  assert.doesNotMatch(text, /order by/i);
  assert.match(text, /rownum/i);
  await assert.rejects(engine.get('nokey', '1'), { status: 404 });
});

test('single-record GET stays disabled for list-only models', () => {
  assert.throws(() => engine.buildGetQuery('mixed', '1'), { status: 404 });
  assert.throws(() => engine.buildGetQuery('spaced', '1'), { status: 404 });
});

test('policy.get requires a valid primaryKey', () => {
  assert.throws(
    () => loadOrdersSchema('fields:\n  a: { column: A, type: string }\npolicy:\n  list: true\n  get: true\n'),
    /policy\.get requires a primaryKey/,
  );
  assert.throws(
    () => loadOrdersSchema('primaryKey: nope\nfields:\n  a: { column: A, type: string }\n'),
    /primaryKey must be a defined field/,
  );
});

test('unsafe identifiers are rejected at startup', () => {
  const badColumns = [
    'A; DROP TABLE X',
    'A"B',
    '"A"',
    "A'B",
    'A--x',
    'A/*x*/',
    'A,B',
    'A.B',
    'A (B)',
    'A\nB',
    'A AS B',
    ' A',
    'A ',
    '1A',
    '',
    'A'.repeat(31),
  ];
  for (const column of badColumns) {
    const schema = `fields:\n  id:\n    column: ${JSON.stringify(column)}\n    type: string\n`;
    assert.throws(() => loadOrdersSchema(schema), /invalid column/, `column ${JSON.stringify(column)}`);
  }
  assert.throws(() => loadOrdersSchema('fields:\n  id:\n    type: string\n'), /invalid column/);
  assert.throws(() => loadOrdersSchema('fields:\n  id:\n    column: [A]\n    type: string\n'), /invalid column/);

  const badEntries = [
    ['owner', 'A B'],
    ['owner', 'A;B'],
    ['owner', 'A"B'],
    ['table', 'A B'],
    ['table', 'A.B'],
    ['table', ''],
  ];
  for (const [key, value] of badEntries) {
    const d = fixtureDir();
    const entry = { owner: 'PSSMGI', table: 'GTSORDER', schema: 'orders.yaml', [key]: value };
    writeFileSync(join(d, 'models.yaml'), `orders: ${JSON.stringify(entry)}\n`);
    assert.throws(() => loadConfig(d, env), new RegExp(`invalid ${key}`), `${key} ${JSON.stringify(value)}`);
  }

  assert.throws(
    () => loadOrdersSchema('fields:\n  id: { column: A, type: string }\npolicy:\n  filters: [nope]\n'),
    /unknown field "nope"/,
  );
});

test('Oracle $ and # characters and inner spaces are accepted in column identifiers', () => {
  const { models: loaded } = loadOrdersSchema(
    'fields:\n  a: { column: Col$1#x, type: string }\n  b: { column: A B C, type: string }\n',
  );
  assert.equal(loaded.get('orders').fields.a.column, 'Col$1#x');
  assert.equal(loaded.get('orders').fields.b.column, 'A B C');
});

test('list uses Oracle 11g ROWNUM pagination', () => {
  const { sql: text, bindings } = list('orders', { page: 3, limit: 20 });
  assert.match(text, /rownum/i);
  assert.doesNotMatch(text, /fetch|offset/i);
  assert.deepEqual(bindings, [40 + 21, 40]); // end row (offset + limit + 1 lookahead), offset

  const spaced = list('spaced', { page: 2, limit: 5 });
  assert.match(spaced.sql, /rownum/i);
  assert.doesNotMatch(spaced.sql, /fetch|offset/i);
  assert.deepEqual(spaced.bindings, [5 + 5 + 1, 5]);
});

test('filters are allowlisted and values are bound, never inlined', () => {
  const { sql: text, bindings } = list('orders', { customer: "O'Brien" });
  assert.match(text, /"CUSTOMER" = \?/);
  assert.ok(!text.includes('Brien'));
  assert.ok(bindings.includes("O'Brien"));

  const injected = list('mixed', { erpNumber: "x' OR '1'='1" });
  assert.ok(!injected.sql.includes("x'"));
  assert.ok(injected.bindings.includes("x' OR '1'='1"));

  // Not configured as filters, or not friendly field names at all (raw column names are rejected too).
  const cases = [
    ['orders', { netAmount: '1' }],
    ['orders', { CUSTOMER: 'x' }],
    ['orders', { nope: 'x' }],
    ['mixed', { srno: '1' }],
    ['mixed', { Supplier_code: 'x' }],
    ['mixed', { serialNo: '1' }],
    ['spaced', { 'SR NO': '1' }],
  ];
  for (const [model, bad] of cases) {
    assert.throws(
      () => engine.buildListQuery(model, { page: 1, limit: 10, ...bad }),
      (err) => err instanceof ApiError && err.status === 400 && err.code === 'invalid_filter',
    );
  }
});

test('results are mapped to friendly field names with Oracle date strings preserved', async () => {
  const rows = [
    { serialNo: '5', erpNumber: 'ERP001', receivedDate: '2026-11-05T00:00:00', supplierCode: null, ignored: 'x' },
  ];
  const result = await createReadEngine(cannedDb(rows), models).list('mixed', { page: 1, limit: 10 });
  assert.deepEqual(result.data, [
    { serialNo: 5, erpNumber: 'ERP001', receivedDate: '2026-11-05T00:00:00', supplierCode: null },
  ]);
  assert.equal(result.hasMore, false);
});

test('unknown models are rejected', async () => {
  await assert.rejects(engine.list('nope', { page: 1, limit: 10 }), { status: 404 });
  await assert.rejects(engine.get('nope', '1'), { status: 404 });
});

test('the shipped PSSBSA config loads with exact identifier case and list-only policy', () => {
  const { models: shipped } = loadConfig('config', env);
  assert.deepEqual([...shipped.keys()], ['orderAllowanceDetails', 'fabricEntries', 'cmtEntries', 'bomItems']);
  for (const model of shipped.values()) {
    assert.equal(model.owner, 'PSSBSA');
    assert.equal(model.list, true);
    assert.equal(model.get, false);
    for (const f of model.filters) assert.ok(model.fields[f], `filter ${f} is a configured field`);
  }
  assert.equal(shipped.get('cmtEntries').primaryKey, 'SR NO');
  assert.equal(shipped.get('cmtEntries').fields['SR NO'].column, 'SR NO');
  assert.equal(shipped.get('cmtEntries').fields.erp_no.column, 'erp_no');
  assert.equal(shipped.get('fabricEntries').fields.Supplier_code.column, 'Supplier_code');
  assert.equal(shipped.get('fabricEntries').fields.Recd_Date.column, 'Recd_Date');
  assert.equal(shipped.get('bomItems').fields.ERP_NO.column, 'ERP_NO');

  const real = createReadEngine(db, shipped);
  const { sql: text } = sql(real.buildListQuery('cmtEntries', { page: 1, limit: 5, erp_no: 'E1' }));
  assert.match(text, /from "PSSBSA"\."CMTINT"/);
  assert.match(text, /"SR NO" as "SR NO"/);
  assert.throws(() => real.buildGetQuery('cmtEntries', '1'), { status: 404 });
});

test('HTTP: API key, validation and error envelope', async () => {
  const calls = [];
  const stub = {
    list: async (model, params) => (calls.push([model, params]), { data: [], ...params, hasMore: false }),
    get: async () => {
      throw new ApiError(404, 'not_found', 'missing');
    },
  };
  const app = buildApp({ engine: stub, apiKey: 'secret', maxLimit: 50, logger: false });
  const headers = { 'x-api-key': 'secret' };

  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject('/api/customers')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/customers', headers: { 'x-api-key': 'wrong' } })).statusCode, 401);

  const ok = await app.inject({ url: '/api/customers?name=John&limit=10', headers });
  assert.equal(ok.statusCode, 200);
  assert.equal(calls[0][0], 'customers');
  assert.deepEqual({ ...calls[0][1] }, { page: 1, limit: 10, name: 'John' });

  const tooBig = await app.inject({ url: '/api/customers?limit=51', headers });
  assert.equal(tooBig.statusCode, 400);
  assert.equal(tooBig.json().error.code, 'invalid_request');

  const missing = await app.inject({ url: '/api/customers/1', headers });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: { code: 'not_found', message: 'missing' } });
  await app.close();
});
