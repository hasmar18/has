import { query } from '../db.js';
import { log } from '../lib/log.js';

const handlers = new Map();
export const registerHandler = (type, fn) => handlers.set(type, fn);

export class PermanentError extends Error {}

/** Zařadí úlohu. Při shodném dedupe_key se nezařadí podruhé (idempotence). */
export async function enqueue(db, type, payload = {}, { dedupeKey = null, runAt = null, maxAttempts = 8 } = {}) {
  const r = await db.query(
    `INSERT INTO jobs (type, payload, dedupe_key, run_at, max_attempts)
     VALUES ($1, $2::jsonb, $3, COALESCE($4, now()), $5)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [type, JSON.stringify(payload), dedupeKey, runAt, maxAttempts],
  );
  return r.rows[0]?.id ?? null;
}

const backoffSeconds = (attempt) => Math.min(3600, 30 * 2 ** (attempt - 1));

export async function runDueJobs(limit = 10) {
  // Úlohy zaseknuté (restart procesu) vrátíme do fronty
  await query(`UPDATE jobs SET status = 'pending' WHERE status = 'running' AND locked_at < now() - interval '5 minutes'`);
  const claimed = (await query(
    `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [limit],
  )).rows;
  let processed = 0;
  for (const job of claimed) {
    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new PermanentError(`Neznámý typ úlohy: ${job.type}`);
      await handler(job.payload, job);
      await query(`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL, locked_at = NULL WHERE id = $1`, [job.id]);
    } catch (err) {
      const permanent = err instanceof PermanentError || job.attempts >= job.max_attempts;
      log.warn(`Úloha ${job.type}#${job.id} selhala (pokus ${job.attempts}/${job.max_attempts})`, err);
      if (permanent) {
        await query(`UPDATE jobs SET status = 'failed', finished_at = now(), last_error = $2, locked_at = NULL WHERE id = $1`, [job.id, String(err.message).slice(0, 1000)]);
      } else {
        await query(
          `UPDATE jobs SET status = 'pending', last_error = $2, locked_at = NULL, run_at = now() + ($3 || ' seconds')::interval WHERE id = $1`,
          [job.id, String(err.message).slice(0, 1000), String(backoffSeconds(job.attempts))],
        );
      }
    }
    processed += 1;
  }
  return processed;
}
