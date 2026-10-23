import { query } from './db.js';
import { log } from './lib/log.js';
import { runDueJobs, registerHandler, enqueue } from './services/jobs.js';
import { sendEmailById } from './services/email.js';
import { sendReminder, expireHolds } from './services/bookings.js';
import { getSettings } from './services/settings.js';
import { pushBooking, syncAllSources, syncSourceById, enqueueMissingPushes, renewWatches, ensureWatch } from './calendar/engine.js';
import { refreshToken as refreshInstagramToken } from './services/instagram.js';

export function registerHandlers() {
  registerHandler('send_email', (p) => sendEmailById(p.emailId));
  registerHandler('send_reminder', (p) => sendReminder(p));
  registerHandler('calendar_push', (p) => pushBooking(p.bookingId));
  registerHandler('calendar_sync_all', async () => { await syncAllSources(); await enqueueMissingPushes(); });
  registerHandler('calendar_sync_source', (p) => syncSourceById(p.sourceId));
  registerHandler('calendar_watch', (p) => ensureWatch(p.sourceId));
  registerHandler('watch_renew', () => renewWatches());
  registerHandler('instagram_refresh', () => refreshInstagramToken());
  registerHandler('cleanup', () => cleanup());
}

export async function cleanup() {
  const settings = await getSettings();
  const out = {};
  out.expiredHolds = await expireHolds({ query });
  await query(`DELETE FROM sessions WHERE expires_at < now()`);
  await query(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'`);
  await query(`DELETE FROM external_blocks WHERE ends_at < now() - interval '3 days'`);
  await query(`DELETE FROM jobs WHERE (status = 'done' AND finished_at < now() - interval '14 days') OR (status = 'failed' AND finished_at < now() - interval '60 days')`);
  // E-maily zaseknuté v odesílání (pád procesu) → zpět do fronty
  const stuck = (await query(`UPDATE email_log SET status = 'pending' WHERE status = 'sending' AND updated_at < now() - interval '10 minutes' RETURNING id`)).rows;
  for (const s of stuck) await enqueue({ query }, 'send_email', { emailId: s.id }, { dedupeKey: `send_email:retry:${s.id}:${Math.floor(Date.now() / 600000)}` });
  // Minimalizace údajů: po uplynutí doby uchování se osobní údaje v rezervacích anonymizují
  const anon = await query(
    `UPDATE bookings SET client_name = 'Anonymizováno', client_email = '', client_phone = '', client_note = '', admin_note = '',
       manage_token_hash = NULL, manage_token_enc = NULL, user_id = NULL
     WHERE starts_at < now() - ($1 || ' months')::interval AND client_name <> 'Anonymizováno' AND client_name <> 'Smazaná klientka'`,
    [String(settings.retention_months)]);
  out.anonymized = anon.rowCount;
  await query(`DELETE FROM email_log WHERE created_at < now() - ($1 || ' months')::interval`, [String(settings.retention_months)]);
  await query(`DELETE FROM booking_history WHERE at < now() - ($1 || ' months')::interval`, [String(settings.retention_months)]);
  return out;
}

/** Periodické úlohy: dedupe klíč podle časového okna zajistí, že se zařadí jen jednou (i při více instancích). */
export async function schedulePeriodic(now = new Date()) {
  const settings = await getSettings();
  const poll = settings.calendar_poll_minutes * 60_000;
  const hour = 3600_000;
  const t = now.getTime();
  await enqueue({ query }, 'calendar_sync_all', {}, { dedupeKey: `syncall:${Math.floor(t / poll)}`, maxAttempts: 1 });
  await enqueue({ query }, 'cleanup', {}, { dedupeKey: `cleanup:${Math.floor(t / hour)}`, maxAttempts: 2 });
  await enqueue({ query }, 'watch_renew', {}, { dedupeKey: `watchrenew:${Math.floor(t / hour)}`, maxAttempts: 1 });
  await enqueue({ query }, 'instagram_refresh', {}, { dedupeKey: `igrefresh:${Math.floor(t / (7 * 24 * hour))}`, maxAttempts: 2 });
}

export function startWorker() {
  registerHandlers();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await schedulePeriodic();
      let n;
      do { n = await runDueJobs(10); } while (n === 10);
    } catch (err) { log.error('Chyba workeru', err); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  log.info('Worker na pozadí spuštěn');
  return () => clearInterval(timer);
}
