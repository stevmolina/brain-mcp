/**
 * The sessions database: a second Postgres, owned by the sessions CLI, holding
 * each person's cleaned chats. brain-mcp reads `sessions` and owns only its
 * `brain_mcp` schema there (share grants).
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadSessionsConfig } from '../config.js';

let pool: pg.Pool | undefined;

export function sessionsEnabled(): boolean {
  return loadSessionsConfig() !== null;
}

export function sessionsDb(): pg.Pool {
  if (!pool) {
    const config = loadSessionsConfig();
    if (!config) throw new Error('SESSIONS_DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: Number(process.env.SESSIONS_PG_POOL_MAX || 4),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      console.error(JSON.stringify({ level: 'error', at: 'pg.sessions', message: err.message }));
    });
  }
  return pool;
}

export async function closeSessionsDb(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'sessions-migrations');

/** Applies db/sessions-migrations in filename order, recorded in brain_mcp._migrations. */
export async function migrateSessions(): Promise<string[]> {
  const db = sessionsDb();
  await db.query('create schema if not exists brain_mcp');
  await db.query(`
    create table if not exists brain_mcp._migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await db.query<{ name: string }>('select name from brain_mcp._migrations');
  const applied = new Set(rows.map((r) => r.name));
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into brain_mcp._migrations (name) values ($1)', [file]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    ran.push(file);
  }
  return ran;
}
