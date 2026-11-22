import pg, { type PoolClient, type QueryResultRow } from 'pg';
import type { ApiConfig } from './config.js';
import { forbidden } from './errors.js';

const { Pool } = pg;

export type DbPools = {
  auth: pg.Pool;
  tenant: pg.Pool;
  platform: pg.Pool;
  worker: pg.Pool;
  close(): Promise<void>;
};

export type Identity = {
  userId: string;
  membershipId: string | null;
  scope: 'tenant' | 'platform';
  role: 'admin' | 'courier' | 'platform';
};

export function createPools(config: ApiConfig): DbPools {
  const make = (connectionString: string) => new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  const pools = {
    auth: make(config.authDatabaseUrl),
    tenant: make(config.tenantDatabaseUrl),
    platform: make(config.platformDatabaseUrl),
    worker: make(config.workerDatabaseUrl),
  };
  return { ...pools, async close() { await Promise.all(Object.values(pools).map(pool => pool.end())); } };
}

export async function inTransaction<T>(pool: pg.Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function withTenant<T>(pools: DbPools, identity: Identity, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (identity.scope !== 'tenant' || !identity.membershipId) forbidden();
  return inTransaction(pools.tenant, async client => {
    await client.query('SELECT app.set_request_context($1, $2)', [identity.userId, identity.membershipId]);
    const plan = await client.query('SELECT 1 FROM app.active_plan_limits()');
    if (!plan.rowCount) forbidden();
    return work(client);
  });
}

export async function one<T extends QueryResultRow>(client: PoolClient, sql: string, params: unknown[] = []): Promise<T | null> {
  const result = await client.query<T>(sql, params);
  return result.rows[0] ?? null;
}
