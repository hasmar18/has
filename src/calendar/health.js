import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';

/** Které zdroje blokací jsou neaktuální nebo nefunkční? Na ně se při nabídce termínů nelze spolehnout. */
export async function calendarHealth(db, settings, now = new Date()) {
  const rows = (await db.query(
    `SELECT cs.id, cs.name, cs.last_synced_at, cs.last_sync_ok, cs.last_error,
            cc.status, cc.provider, cc.account_email, cc.id AS connection_id
     FROM calendar_sources cs JOIN calendar_connections cc ON cc.id = cs.connection_id
     WHERE cs.blocks_availability`)).rows;
  const maxAge = settings.calendar_max_staleness_minutes * 60_000;
  const stale = rows.filter((r) => isStale(r, maxAge, now));
  return { sources: rows, stale, degraded: stale.length > 0 };
}

const isStale = (r, maxAge, now) => r.status !== 'active' || !r.last_synced_at
  || now.getTime() - new Date(r.last_synced_at).getTime() > maxAge;

/**
 * Před potvrzením rezervace: blokující kalendáře, které jsou neaktuální (nebo starší než `maxAgeMs`), se okamžitě
 * synchronizují. Pokud zůstane některý kalendář neaktuální a platí „fail_closed“, rezervace se nepřijme (bezpečné chování).
 * Díky tomu je okno, ve kterém by nová událost v kalendáři nebyla známa, při rezervaci jen pár sekund.
 */
export async function ensureCalendarFresh(db, settings, { now = new Date(), timeoutMs = 6000, maxAgeMs = 0 } = {}) {
  let h = await calendarHealth(db, settings, now);
  const maxAge = settings.calendar_max_staleness_minutes * 60_000;
  const needSync = h.sources.filter((r) => isStale(r, maxAge, now) || (maxAgeMs > 0 && isStale(r, maxAgeMs, now)));
  if (!needSync.length) return h;
  try {
    const { syncSourceById } = await import('./engine.js');
    await Promise.race([
      Promise.allSettled(needSync.map((s) => syncSourceById(s.id))),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch (err) {
    log.warn('Okamžitá synchronizace před rezervací selhala', err);
  }
  h = await calendarHealth(db, settings, new Date());
  if (h.degraded && settings.fail_closed) {
    throw new HttpError(503, 'calendar_unavailable',
      'Online rezervace je dočasně nedostupná. Prosím zavolejte do studia, nebo to zkuste za chvíli.');
  }
  return h;
}
