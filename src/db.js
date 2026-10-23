import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';
import { log } from './lib/log.js';

const { Pool, types } = pg;
// bigint (id v logu) jako číslo – hodnoty jsou malé; numeric nepoužíváme
types.setTypeParser(20, (v) => Number(v));

let pool;
export function getPool() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL není nastaven.');
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => log.error('Chyba spojení s databází', err));
  }
  return pool;
}

export async function closePool() {
  if (pool) { await pool.end(); pool = undefined; }
}

export const query = (text, params) => getPool().query(text, params);

/** Spustí funkci v transakci. Při výjimce provede ROLLBACK. */
export async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* spojení už může být zavřené */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Globální zámek pro všechny operace, které mění dostupnost (rezervace, blokace,
 * synchronizace externích událostí). Platí do konce transakce. Společně s EXCLUDE
 * omezením v tabulce bookings zajišťuje, že souběžné požadavky nemohou vytvořit kolizi.
 */
export const lockAvailability = (client) => client.query(`SELECT pg_advisory_xact_lock(727001)`);

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate() {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock(727002)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
        log.info(`Migrace aplikována: ${f}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migrace ${f} selhala: ${err.message}`);
      }
    }
    return applied;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(727002)'); } catch { /* ignore */ }
    client.release();
  }
}
