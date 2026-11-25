import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

export function getPoolConfig() {
  return {
    host: process.env.SQL_HOST,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SQL_DB_NAME,
    max: Number(process.env.SQL_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  };
}

export const createPool = (): Pool => {
  if (!global._postgresPool) {
    global._postgresPool = new Pool(getPoolConfig());
    global._postgresPool.on('error', (err) => {
      console.error('[DB] Unexpected error on idle PostgreSQL pool client:', err.message);
    });
  }
  return global._postgresPool;
};

export const pool = createPool();
export const db = drizzle(pool, { schema });

export function createDedicatedClient(): Client {
  return new Client({
    host: process.env.SQL_HOST,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SQL_DB_NAME,
    connectionTimeoutMillis: 15_000,
  });
}

export async function closeDatabasePool(): Promise<void> {
  if (global._postgresPool) {
    const p = global._postgresPool;
    global._postgresPool = undefined;
    await p.end();
  }
}
