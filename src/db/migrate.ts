/**
 * Migration runner. Applies every unapplied file in db/migrations in filename
 * order, each in its own transaction, recording it in _migrations.
 *
 * Run: pnpm migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, closeDb, withTransaction } from './client.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

export async function migrate(): Promise<string[]> {
  await db().query(`
    create table if not exists _migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await db().query<{ name: string }>('select name from _migrations');
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('insert into _migrations (name) values ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}
