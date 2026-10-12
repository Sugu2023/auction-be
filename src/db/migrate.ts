import { readdir, readFile } from 'node:fs/promises';
import { pool } from '../db.js';

// Applies every file in sql/ that hasn't run yet, in filename order.
// Each file runs in its own transaction and is recorded in schema_migrations.
const migrationsDir = new URL('../../sql/', import.meta.url);

const client = await pool.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map(r => r.name));
  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, migrationsDir), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log('Database is up to date.');
} finally {
  client.release();
  await pool.end();
}
