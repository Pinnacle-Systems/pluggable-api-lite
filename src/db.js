import knex from 'knex';
import oracledb from 'oracledb';

// Oracle 11g needs Thick mode (Thin mode supports 12.1+). Must run before the first connection.
export function initOracleClient(libDir) {
  if (!oracledb.thin) return;
  oracledb.initOracleClient(libDir ? { libDir } : {});
}

export function createDb({ connectString, user, password }) {
  return knex({
    client: 'oracledb',
    connection: { connectString, user, password },
    pool: { min: 0, max: 5 },
  });
}

export async function checkConnection(db) {
  await db.raw('select 1 from dual');
}
