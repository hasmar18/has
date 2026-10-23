import { query, withTx, lockAvailability } from '../db.js';
import { config } from '../config.js';
import { log } from '../lib/log.js';
import { encrypt, decrypt, randomToken } from '../lib/crypto.js';
import { addMinutes } from '../lib/time.js';
import { getSettings } from '../services/settings.js';
import { getContent } from '../services/content.js';
import { enqueue } from '../services/jobs.js';
import { queueEmail } from '../services/email.js';
import { getProvider, ProviderAuthError } from './providers.js';

const TOKEN_SKEW_MS = 60_000;

// ---------------------------------------------------------------------------------------
// Přístupové tokeny (uložené šifrovaně; obnovují se automaticky)
// ---------------------------------------------------------------------------------------
export async function getAccessToken(conn) {
  const provider = getProvider(conn.provider);
  if (conn.access_token_enc && conn.access_expires_at && new Date(conn.access_expires_at).getTime() - Date.now() > TOKEN_SKEW_MS) {
    try { return decrypt(conn.access_token_enc); } catch { /* obnovíme */ }
  }
  const refreshed = await provider.refreshAccessToken(decrypt(conn.refresh_token_enc));
  const expiresAt = new Date(Date.now() + (refreshed.expiresIn || 3000) * 1000);
  await query(
    `UPDATE calendar_connections SET access_token_enc = $2, access_expires_at = $3,
       refresh_token_enc = COALESCE($4, refresh_token_enc) WHERE id = $1`,
    [conn.id, encrypt(refreshed.accessToken), expiresAt, refreshed.refreshToken ? encrypt(refreshed.refreshToken) : null]);
  return refreshed.accessToken;
}

async function loadConnection(id) {
  return (await query(`SELECT * FROM calendar_connections WHERE id = $1`, [id])).rows[0];
}

// ---------------------------------------------------------------------------------------
// Evidence chyb a upozornění správci
// ---------------------------------------------------------------------------------------
export async function recordFailure(connectionId, sourceId, err) {
  const isAuth = err instanceof ProviderAuthError;
  const msg = String(err.message || err).slice(0, 500);
  const conn = (await query(
    `UPDATE calendar_connections SET consecutive_failures = consecutive_failures + 1, last_error = $2, last_error_at = now(),
       status = CASE WHEN $3 THEN 'needs_reauth' WHEN consecutive_failures + 1 >= 3 THEN 'error' ELSE status END
     WHERE id = $1 RETURNING *`, [connectionId, msg, isAuth])).rows[0];
  if (sourceId) await query(`UPDATE calendar_sources SET last_sync_ok = false, last_error = $2 WHERE id = $1`, [sourceId, msg]);
  log.warn(`Synchronizace kalendáře ${connectionId} selhala`, err);
  if (conn && conn.status !== 'active' && !conn.alerted_at) await alertAdmin(conn, msg);
  return conn;
}

export async function recordSuccess(connectionId) {
  await query(
    `UPDATE calendar_connections SET status = 'active', consecutive_failures = 0, last_error = NULL, last_success_at = now(), alerted_at = NULL WHERE id = $1`,
    [connectionId]);
}

async function alertAdmin(conn, msg) {
  // Atomické „převzetí“ upozornění: poslat se smí jen jednou za jednu epizodu výpadku (do obnovení funkčnosti).
  const claimed = (await query(`UPDATE calendar_connections SET alerted_at = now() WHERE id = $1 AND alerted_at IS NULL RETURNING id`, [conn.id])).rows[0];
  if (!claimed) return;
  const { adminAlertRecipients } = await import('../services/bookings.js');
  const settings = await getSettings();
  const recipients = await adminAlertRecipients({ query }, settings);
  await withTx(async (tx) => {
    for (const to of recipients) {
      await queueEmail(tx, {
        templateKey: 'admin_sync_error', to, dedupeKey: `syncalert:${conn.id}:${Date.now()}:${to}`,
        vars: { details: `Kalendář: ${conn.provider} (${conn.account_email})\nChyba: ${msg}\nStav: ${conn.status === 'needs_reauth' ? 'je potřeba znovu autorizovat účet' : 'opakované selhání'}` },
      });
    }
  });
}

// ---------------------------------------------------------------------------------------
// Kalendář → rezervační systém (blokace dostupnosti)
// ---------------------------------------------------------------------------------------
/**
 * Pravidelně znovu načte události v okně [dnes … dnes + max. předstih] a srovná je s databází.
 * Díky úplnému srovnání okna je zpracování idempotentní a automaticky řeší změny i mazání událostí.
 */
export async function syncSourceById(sourceId, { now = new Date() } = {}) {
  const src = (await query(
    `SELECT cs.*, cc.id AS conn_id FROM calendar_sources cs JOIN calendar_connections cc ON cc.id = cs.connection_id WHERE cs.id = $1`, [sourceId])).rows[0];
  if (!src) return { skipped: true };
  const conn = await loadConnection(src.conn_id);
  const settings = await getSettings();
  const needsBlocks = src.blocks_availability;
  const isWriteCal = conn.write_enabled && conn.write_calendar_id === src.external_calendar_id;
  try {
    if (!needsBlocks && !isWriteCal) {
      await withTx(async (tx) => {
        await lockAvailability(tx);
        await tx.query(`DELETE FROM external_blocks WHERE source_id = $1`, [src.id]);
        await tx.query(`UPDATE calendar_sources SET last_synced_at = $2, last_sync_ok = true, last_error = NULL WHERE id = $1`, [src.id, now]);
      });
      return { ok: true, blocks: 0 };
    }
    const provider = getProvider(conn.provider);
    const token = await getAccessToken(conn);
    const from = addMinutes(now, -36 * 60);
    const to = addMinutes(now, (settings.max_advance_days + 3) * 24 * 60);
    const events = await provider.listEvents(token, { calendarId: src.external_calendar_id, from, to, tz: settings.timezone });

    const mapped = (await query(
      `SELECT m.booking_id, m.external_event_id, m.state, b.starts_at, b.ends_at, b.status
       FROM booking_calendar_events m JOIN bookings b ON b.id = m.booking_id
       WHERE m.connection_id = $1 AND m.calendar_id = $2`, [conn.id, src.external_calendar_id])).rows;
    const ourIds = new Map(mapped.map((m) => [m.external_event_id, m]));

    const blocks = needsBlocks
      ? events.filter((e) => !e.ours && !ourIds.has(e.id) && !e.cancelled && !e.transparent && e.end > e.start)
      : [];

    await withTx(async (tx) => {
      await lockAvailability(tx);
      for (const e of blocks) {
        await tx.query(
          `INSERT INTO external_blocks (source_id, external_event_id, starts_at, ends_at, is_all_day, etag, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (source_id, external_event_id) DO UPDATE
             SET starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, is_all_day = EXCLUDED.is_all_day, etag = EXCLUDED.etag, updated_at = now()`,
          [src.id, e.id, e.start, e.end, e.allDay, e.etag]);
      }
      // Smazání: vše, co už v kalendáři není, uvolní termín. Událost mimo načtené okno (stará) mažeme také.
      await tx.query(`DELETE FROM external_blocks WHERE source_id = $1 AND NOT (external_event_id = ANY($2::text[]))`, [src.id, blocks.map((b) => b.id)]);

      if (isWriteCal) {
        const seen = new Set();
        for (const e of events) {
          const m = ourIds.get(e.id);
          if (!m) continue;
          seen.add(e.id);
          const moved = Math.abs(e.start - m.starts_at) > 60_000 || Math.abs(e.end - m.ends_at) > 60_000;
          await tx.query(`UPDATE booking_calendar_events SET drift = $2, etag = $3 WHERE booking_id = $1`, [m.booking_id, moved ? 'time_changed_in_calendar' : null, e.etag]);
        }
        for (const m of mapped) {
          if (seen.has(m.external_event_id) || m.state !== 'synced' || m.status !== 'confirmed') continue;
          if (m.ends_at > from && m.starts_at < to) {
            await tx.query(`UPDATE booking_calendar_events SET drift = 'deleted_in_calendar' WHERE booking_id = $1`, [m.booking_id]);
          }
        }
      }
      await tx.query(`UPDATE calendar_sources SET last_synced_at = $2, last_sync_ok = true, last_error = NULL WHERE id = $1`, [src.id, now]);
    });
    await recordSuccess(conn.id);
    return { ok: true, blocks: blocks.length };
  } catch (err) {
    await recordFailure(conn.id, src.id, err);
    throw err;
  }
}

export async function syncAllSources() {
  const sources = (await query(
    `SELECT cs.id FROM calendar_sources cs JOIN calendar_connections cc ON cc.id = cs.connection_id
     WHERE cs.blocks_availability OR (cc.write_enabled AND cc.write_calendar_id = cs.external_calendar_id)`)).rows;
  const results = [];
  for (const s of sources) {
    try { results.push({ id: s.id, ...(await syncSourceById(s.id)) }); }
    catch (err) { results.push({ id: s.id, error: err.message }); }
  }
  return results;
}

// ---------------------------------------------------------------------------------------
// Rezervační systém → kalendář (zápis zákaznických rezervací)
// ---------------------------------------------------------------------------------------
async function getWriteConnection() {
  return (await query(`SELECT * FROM calendar_connections WHERE write_enabled AND write_calendar_id IS NOT NULL LIMIT 1`)).rows[0];
}

function eventTexts(b) {
  const lines = [
    `Klientka: ${b.client_name}`,
    b.client_phone ? `Telefon: ${b.client_phone}` : null,
    b.client_email ? `E-mail: ${b.client_email}` : null,
    `Služba: ${b.service_name}`,
    b.client_note ? `Poznámka klientky: ${b.client_note}` : null,
    '',
    `Vytvořeno rezervačním systémem HASNAILS (${config.baseUrl}/admin). Čas rezervace měňte v administraci, ne v kalendáři.`,
  ].filter((x) => x !== null);
  return { summary: `HASNAILS: ${b.service_name} – ${b.client_name}`, description: lines.join('\n') };
}

/**
 * Zapíše / aktualizuje / smaže událost podle AKTUÁLNÍHO stavu rezervace (ne podle obsahu úlohy),
 * takže opakované spuštění téže úlohy je bezpečné a nevytváří duplicity.
 */
export async function pushBooking(bookingId) {
  const b = (await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId])).rows[0];
  if (!b) return { skipped: 'no_booking' };
  const conn = await getWriteConnection();
  const mapping = (await query(`SELECT * FROM booking_calendar_events WHERE booking_id = $1`, [bookingId])).rows[0];
  if (!conn) return { skipped: 'no_write_calendar' };
  const provider = getProvider(conn.provider);
  const wantEvent = b.status === 'confirmed';

  try {
    const token = await getAccessToken(conn);
    let current = mapping;

    // Změnil se cílový kalendář → starou událost odstraníme (best effort)
    if (current && current.state === 'synced' && (current.connection_id !== conn.id || current.calendar_id !== conn.write_calendar_id)) {
      try {
        const oldConn = current.connection_id ? await loadConnection(current.connection_id) : null;
        if (oldConn) await getProvider(oldConn.provider).deleteEvent(await getAccessToken(oldConn), { calendarId: current.calendar_id, eventId: current.external_event_id });
      } catch (e) { log.warn('Smazání události ve starém kalendáři selhalo', e); }
      current = null;
    }

    if (wantEvent) {
      const t = eventTexts(b);
      const res = await provider.upsertEvent(token, {
        calendarId: conn.write_calendar_id, bookingId: b.id, existingEventId: current && current.state === 'synced' ? current.external_event_id : null,
        summary: t.summary, description: t.description, start: b.starts_at, end: b.ends_at,
      });
      await query(
        `INSERT INTO booking_calendar_events (booking_id, connection_id, calendar_id, external_event_id, etag, synced_version, state, drift, last_error, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'synced', NULL, NULL, now())
         ON CONFLICT (booking_id) DO UPDATE SET connection_id = EXCLUDED.connection_id, calendar_id = EXCLUDED.calendar_id,
           external_event_id = EXCLUDED.external_event_id, etag = EXCLUDED.etag, synced_version = EXCLUDED.synced_version,
           state = 'synced', drift = NULL, last_error = NULL, updated_at = now()`,
        [b.id, conn.id, conn.write_calendar_id, res.eventId, res.etag, b.version]);
      return { upserted: true, eventId: res.eventId };
    }
    if (current && current.state === 'synced') {
      await provider.deleteEvent(token, { calendarId: current.calendar_id, eventId: current.external_event_id });
      await query(`UPDATE booking_calendar_events SET state = 'deleted', synced_version = $2, drift = NULL, last_error = NULL, updated_at = now() WHERE booking_id = $1`, [b.id, b.version]);
      return { deleted: true };
    }
    return { skipped: 'nothing_to_do' };
  } catch (err) {
    await query(`UPDATE booking_calendar_events SET last_error = $2, updated_at = now() WHERE booking_id = $1`, [bookingId, String(err.message).slice(0, 300)]);
    if (err instanceof ProviderAuthError) await recordFailure(conn.id, null, err);
    throw err;
  }
}

/** Najde budoucí rezervace, které nejsou v kalendáři ve správném stavu, a znovu je zařadí (po výpadku, po změně kalendáře). */
export async function enqueueMissingPushes({ hourBucket = Math.floor(Date.now() / 3600_000) } = {}) {
  const conn = await getWriteConnection();
  if (!conn || conn.status !== 'active') return 0;
  const rows = (await query(
    `SELECT b.id, b.version FROM bookings b LEFT JOIN booking_calendar_events m ON m.booking_id = b.id
     WHERE (b.status = 'confirmed' AND b.ends_at > now()
            AND (m.booking_id IS NULL OR m.state <> 'synced' OR m.synced_version < b.version
                 OR m.connection_id IS DISTINCT FROM $1 OR m.calendar_id <> $2))
        OR (b.status IN ('cancelled', 'expired') AND m.state = 'synced')`, [conn.id, conn.write_calendar_id])).rows;
  let n = 0;
  for (const r of rows) {
    const id = await enqueue({ query }, 'calendar_push', { bookingId: r.id }, { dedupeKey: `calfix:${r.id}:${r.version}:${hourBucket}` });
    if (id) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------------------
// Push notifikace (webhooky) – urychlují synchronizaci, kontrolní polling zůstává
// ---------------------------------------------------------------------------------------
export async function ensureWatch(sourceId) {
  if (!config.baseUrl.startsWith('https://')) return { skipped: 'no_https' };
  const src = (await query(`SELECT * FROM calendar_sources WHERE id = $1`, [sourceId])).rows[0];
  if (!src) return { skipped: true };
  const conn = await loadConnection(src.connection_id);
  const provider = getProvider(conn.provider);
  if (!provider.watch) return { skipped: 'unsupported' };
  const token = await getAccessToken(conn);
  const secret = randomToken(24);
  const channelId = `hn-${randomToken(12)}`;
  const info = await provider.watch(token, {
    calendarId: src.external_calendar_id, channelId, secret, address: `${config.baseUrl}/api/webhooks/calendar/${src.id}`,
  });
  if (src.watch_id) { try { await provider.stopWatch(token, { watchId: src.watch_id, resourceId: src.watch_resource_id }); } catch { /* starý kanál mohl vypršet */ } }
  await query(
    `UPDATE calendar_sources SET watch_id = $2, watch_resource_id = $3, watch_secret = $4, watch_expires_at = $5 WHERE id = $1`,
    [src.id, info.watchId, info.resourceId, secret, info.expiresAt]);
  return { ok: true, expiresAt: info.expiresAt };
}

export async function renewWatches() {
  const due = (await query(
    `SELECT cs.id FROM calendar_sources cs JOIN calendar_connections cc ON cc.id = cs.connection_id
     WHERE cc.status = 'active' AND (cs.blocks_availability OR (cc.write_enabled AND cc.write_calendar_id = cs.external_calendar_id))
       AND (cs.watch_expires_at IS NULL OR cs.watch_expires_at < now() + interval '24 hours')`)).rows;
  let n = 0;
  for (const s of due) {
    try { const r = await ensureWatch(s.id); if (r.ok) n += 1; } catch (err) { log.warn('Obnova push notifikací selhala (polling funguje dál)', err); }
  }
  return n;
}
