import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
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
const engineFor = (configDir = 'config') => createReadEngine(db, loadConfig(configDir, env).models);

test('config loads, upper-cases identifiers and maps friendly names', () => {
  const { database, models } = loadConfig('config', env);
  assert.equal(database.connectString, 'host/svc');
  const customers = models.get('customers');
  assert.equal(customers.table, 'CUST_MST');
  assert.equal(customers.fields.name.column, 'CUST_NM');
  assert.deepEqual([...customers.filters], ['customerId', 'name']);
});

test('config rejects unsafe identifiers and unknown filter fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  cpSync('config', dir, { recursive: true });
  const schema = join(dir, 'schemas', 'customers.yaml');

  writeFileSync(schema, 'primaryKey: id\nfields:\n  id:\n    column: "A; DROP TABLE X"\n    type: string\n');
  assert.throws(() => loadConfig(dir, env), /invalid column/);

  writeFileSync(schema, 'primaryKey: id\nfields:\n  id:\n    column: A\n    type: string\npolicy:\n  filters: [nope]\n');
  assert.throws(() => loadConfig(dir, env), /unknown field "nope"/);
});

test('list selects only configured columns with Oracle 11g pagination', () => {
  const { sql: text, bindings } = sql(engineFor().buildListQuery('customers', { page: 3, limit: 20 }));
  assert.match(text, /"CUST_CODE" as "customerId"/);
  assert.match(text, /"OUT_ST_AMT" as "balance"/);
  assert.match(text, /from "ERPUSER"\."CUST_MST"/);
  assert.match(text, /order by "CUST_CODE"/);
  assert.match(text, /rownum/i);
  assert.doesNotMatch(text, /fetch|offset/i);
  assert.deepEqual(bindings, [40 + 21, 40]); // end row (offset + limit + 1 lookahead), offset
});

test('filters are allowlisted and values are bound, never inlined', () => {
  const engine = engineFor();
  const { sql: text, bindings } = sql(engine.buildListQuery('customers', { page: 1, limit: 10, name: "O'Brien" }));
  assert.match(text, /"CUST_NM" = \?/);
  assert.ok(!text.includes('Brien'));
  assert.ok(bindings.includes("O'Brien"));

  for (const bad of [{ balance: '1' }, { CUST_NM: 'x' }, { nope: 'x' }]) {
    assert.throws(
      () => engine.buildListQuery('customers', { page: 1, limit: 10, ...bad }),
      (err) => err instanceof ApiError && err.status === 400 && err.code === 'invalid_filter',
    );
  }
});

test('get filters on the configured primary key', () => {
  const { sql: text, bindings } = sql(engineFor().buildGetQuery('customers', '101'));
  assert.match(text, /"CUST_CODE" = \?/);
  assert.ok(bindings.includes('101'));
});

test('unknown models are rejected', async () => {
  const engine = engineFor();
  await assert.rejects(engine.list('nope', { page: 1, limit: 10 }), { status: 404 });
  await assert.rejects(engine.get('nope', '1'), { status: 404 });
});

test('a second model is added through YAML only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  cpSync('config', dir, { recursive: true });
  appendFileSync(join(dir, 'models.yaml'), 'orders:\n  table: ORD_HDR\n  schema: orders.yaml\n');
  writeFileSync(
    join(dir, 'schemas', 'orders.yaml'),
    [
      'primaryKey: orderNo',
      'fields:',
      '  orderNo: { column: ORD_NO, type: integer }',
      '  orderDate: { column: ORD_DT, type: date }',
      'policy:',
      '  list: true',
      '  get: true',
      '  filters: [orderDate]',
      '',
    ].join('\n'),
  );

  const engine = engineFor(dir);
  const { sql: text, bindings } = sql(engine.buildListQuery('orders', { page: 1, limit: 5, orderDate: '2026-01-31' }));
  assert.match(text, /from "ORD_HDR"/);
  assert.match(text, /TO_CHAR\("ORD_DT", 'YYYY-MM-DD"T"HH24:MI:SS'\) as "orderDate"/);
  assert.match(text, /TRUNC\("ORD_DT"\) = TO_DATE\(\?, 'YYYY-MM-DD'\)/);
  assert.ok(bindings.includes('2026-01-31'));
  assert.throws(() => engine.buildGetQuery('orders', 'abc'), { status: 400 });
  assert.throws(() => engine.buildListQuery('orders', { page: 1, limit: 5, orderDate: '2026-02-30' }), { status: 400 });
});

test('HTTP: API key, validation and error envelope', async () => {
  const calls = [];
  const engine = {
    list: async (model, params) => (calls.push([model, params]), { data: [], ...params, hasMore: false }),
    get: async () => {
      throw new ApiError(404, 'not_found', 'missing');
    },
  };
  const app = buildApp({ engine, apiKey: 'secret', maxLimit: 50, logger: false });
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
