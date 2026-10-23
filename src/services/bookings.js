import { query, withTx, lockAvailability } from '../db.js';
import { HttpError, badRequest, notFound, forbidden, conflict } from '../lib/errors.js';
import { sha256Hex, randomToken, randomCode, safeEqual, encrypt, decrypt } from '../lib/crypto.js';
import { addMinutes, formatDateCs, formatTimeCs, localDateStr } from '../lib/time.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { getContent } from './content.js';
import { computeAvailability, isSlotOffered, findConflicts } from './availability.js';
import { enqueue } from './jobs.js';
import { queueEmail } from './email.js';
import { addHistory, audit } from './audit.js';
import { ensureCalendarFresh } from '../calendar/health.js';

const ACTIVE = ['held', 'confirmed'];

export function manageUrl(token) { return `${config.baseUrl}/rezervace/sprava?token=${encodeURIComponent(token)}`; }

const codeHash = (code, bookingId) => sha256Hex(`${bookingId}:${code}`);

function isExclusionViolation(err) { return err && err.code === '23P01'; }
const slotTaken = () => conflict('Tento termín si právě rezervovala jiná klientka. Vyberte prosím jiný čas.', 'slot_taken');

export async function expireHolds(db, now = new Date()) {
  const r = await db.query(
    `UPDATE bookings SET status = 'expired', version = version + 1, updated_at = now()
     WHERE status = 'held' AND hold_expires_at <= $1 RETURNING id`, [now]);
  return r.rowCount;
}

export async function getActiveService(db, serviceId) {
  const s = (await db.query(
    `SELECT * FROM services WHERE id = $1 AND is_active AND archived_at IS NULL`, [serviceId])).rows[0];
  if (!s) throw badRequest('Tato služba není momentálně k dispozici.', 'service_unavailable');
  return s;
}

export function priceLabel(b) {
  if (b.price_czk === null || b.price_czk === undefined) return 'cena dle domluvy';
  return `${new Intl.NumberFormat('cs-CZ').format(b.price_czk)} Kč`;
}

export function bookingVars(b, settings, extra = {}) {
  const tz = settings.timezone;
  return {
    client_name: b.client_name,
    service_name: b.service_name,
    date: formatDateCs(b.starts_at, tz),
    time: formatTimeCs(b.starts_at, tz),
    price: priceLabel(b),
    ...extra,
  };
}

export function publicBooking(b, settings, { admin = false, now = new Date() } = {}) {
  const tz = settings.timezone;
  const hoursLeft = (b.starts_at.getTime() - now.getTime()) / 3600_000;
  const out = {
    id: b.id,
    status: b.status,
    service_name: b.service_name,
    duration_minutes: b.service_duration_minutes,
    price_czk: b.price_czk,
    starts_at: b.starts_at.toISOString(),
    ends_at: b.ends_at.toISOString(),
    local_date: localDateStr(b.starts_at, tz),
    local_time: formatTimeCs(b.starts_at, tz),
    date_label: formatDateCs(b.starts_at, tz),
    can_cancel: b.status === 'confirmed' && hoursLeft >= settings.cancel_hours_before,
    can_request_change: b.status === 'confirmed' && hoursLeft > 0,
    cancel_hours_before: settings.cancel_hours_before,
    client_name: b.client_name,
    client_note: b.client_note,
  };
  if (admin) {
    Object.assign(out, {
      service_id: b.service_id, user_id: b.user_id, client_email: b.client_email, client_phone: b.client_phone,
      admin_note: b.admin_note, source: b.source, email_verified: b.email_verified, conflict_override: b.conflict_override,
      blocked_until: b.blocked_until.toISOString(), cancelled_at: b.cancelled_at, cancelled_by: b.cancelled_by,
      cancel_reason: b.cancel_reason, created_at: b.created_at, version: b.version,
    });
  }
  return out;
}

async function issueManageToken(tx, bookingId) {
  const raw = randomToken(24);
  await tx.query(`UPDATE bookings SET manage_token_hash = $2, manage_token_enc = $3 WHERE id = $1`, [bookingId, sha256Hex(raw), encrypt(raw)]);
  return raw;
}

async function scheduleReminders(tx, b, settings, now = new Date()) {
  for (const h of settings.reminder_hours_before) {
    const runAt = addMinutes(b.starts_at, -h * 60);
    if (runAt <= now) continue;
    await enqueue(tx, 'send_reminder', { bookingId: b.id, startsAt: b.starts_at.toISOString(), hours: h },
      { runAt, dedupeKey: `reminder:${b.id}:${b.starts_at.getTime()}:${h}` });
  }
}

/** Vše, co se má stát, když rezervace přejde do stavu „potvrzeno“ – ve stejné transakci (outbox). */
async function onConfirmed(tx, b, settings, { notifyClient = true, now = new Date() } = {}) {
  const raw = await issueManageToken(tx, b.id);
  if (notifyClient && b.client_email) {
    await queueEmail(tx, {
      templateKey: 'booking_confirmed', to: b.client_email, bookingId: b.id, dedupeKey: `confirmed:${b.id}`,
      vars: bookingVars(b, settings, { manage_url: manageUrl(raw) }),
    });
  }
  if (b.source === 'online') {
    const adminTo = await adminAlertRecipients(tx, settings);
    for (const to of adminTo) {
      await queueEmail(tx, {
        templateKey: 'admin_new_booking', to, bookingId: b.id, dedupeKey: `adminnew:${b.id}:${to}`,
        vars: bookingVars(b, settings, { details: b.client_phone || '—' }),
      });
    }
  }
  await enqueue(tx, 'calendar_push', { bookingId: b.id }, { dedupeKey: `cal:${b.id}:${b.version}` });
  if (b.client_email) await scheduleReminders(tx, b, settings, now);
  return raw;
}

export async function adminAlertRecipients(db, settings) {
  if (settings.admin_alert_email) return [settings.admin_alert_email];
  const r = await db.query(`SELECT email FROM users WHERE role = 'admin' AND deleted_at IS NULL AND email_verified_at IS NOT NULL`);
  return r.rows.map((x) => x.email);
}

// ---------------------------------------------------------------------------------------
// Online rezervace klientkou
// ---------------------------------------------------------------------------------------
export async function createOnlineBooking({ serviceId, startsAt, name, email, phone, note, user = null, now = new Date() }) {
  const settings = await getSettings();
  if (!settings.online_booking_enabled) {
    throw new HttpError(503, 'booking_disabled', 'Online rezervace zatím není spuštěna. Prosím zavolejte do studia.');
  }
  // Před zápisem ověříme aktuálnost externích kalendářů (jinak bezpečně odmítneme).
  await ensureCalendarFresh({ query }, settings, { now, maxAgeMs: 20_000 });

  const normEmail = String(email).trim().toLowerCase();
  try {
    return await withTx(async (tx) => {
      await lockAvailability(tx);
      await expireHolds(tx, now);
      const service = await getActiveService(tx, serviceId);

      if (!(await isSlotOffered(tx, { startsAt, durationMinutes: service.duration_minutes, settings, now }))) {
        throw conflict('Tento termín už není k dispozici. Vyberte prosím jiný čas.', 'slot_unavailable');
      }
      const holds = (await tx.query(
        `SELECT count(*)::int AS n FROM bookings WHERE status = 'held' AND lower(client_email) = $1`, [normEmail])).rows[0].n;
      if (holds >= 2) throw new HttpError(429, 'too_many_holds', 'Máte rozpracované rezervace. Dokončete je prosím, nebo chvíli počkejte.');

      const endsAt = addMinutes(startsAt, service.duration_minutes);
      const blockedUntil = addMinutes(endsAt, settings.buffer_minutes);
      const verifiedUser = user && user.email_verified_at && user.email.toLowerCase() === normEmail;
      const status = (verifiedUser || !settings.require_email_verification) ? 'confirmed' : 'held';
      const holdExpires = status === 'held' ? addMinutes(now, settings.hold_minutes) : null;
      const code = status === 'held' ? randomCode() : null;

      const ins = await tx.query(
        `INSERT INTO bookings (service_id, user_id, service_name, service_duration_minutes, price_czk,
           client_name, client_email, client_phone, client_note, starts_at, ends_at, blocked_until,
           status, source, hold_expires_at, email_verified, verify_sent_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'online',$14,$15,$16) RETURNING *`,
        [service.id, user ? user.id : null, service.name, service.duration_minutes, service.price_czk,
          name, normEmail, phone || '', note || '', startsAt, endsAt, blockedUntil, status, holdExpires,
          Boolean(verifiedUser), status === 'held' ? 1 : 0]);
      let b = ins.rows[0];
      await addHistory(tx, b.id, 'client', user?.id, 'created', { status });

      if (status === 'held') {
        await tx.query(`UPDATE bookings SET verify_code_hash = $2 WHERE id = $1`, [b.id, codeHash(code, b.id)]);
        await queueEmail(tx, {
          templateKey: 'booking_verify', to: normEmail, bookingId: b.id, dedupeKey: `verify:${b.id}:1`,
          vars: bookingVars(b, settings, { code, hold_minutes: settings.hold_minutes }),
        });
        return { booking: publicBooking(b, settings), needs_verification: true, hold_expires_at: holdExpires.toISOString() };
      }
      b = (await tx.query(`UPDATE bookings SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [b.id])).rows[0];
      await addHistory(tx, b.id, 'client', user?.id, 'confirmed', {});
      const raw = await onConfirmed(tx, b, settings, { now });
      return { booking: publicBooking(b, settings), needs_verification: false, manage_url: manageUrl(raw) };
    });
  } catch (err) {
    if (isExclusionViolation(err)) throw slotTaken();
    throw err;
  }
}

export async function verifyBooking(bookingId, code, { now = new Date() } = {}) {
  const settings = await getSettings();
  // Selhání (špatný kód, vypršení) se NESMÍ házet uvnitř transakce – rollback by zrušil započítání pokusu.
  // Transakce proto vrací výsledek a chyba se vyhodí až po commitu.
  const outcome = await withTx(async (tx) => {
    await lockAvailability(tx);
    const b = (await tx.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId])).rows[0];
    if (!b) return { error: notFound('Rezervace nenalezena.') };
    if (b.status === 'confirmed') return { ok: { booking: publicBooking(b, settings), already: true } };
    if (b.status !== 'held' || (b.hold_expires_at && b.hold_expires_at <= now)) {
      return { error: new HttpError(410, 'hold_expired', 'Platnost rezervace vypršela. Vyberte prosím termín znovu.') };
    }
    if (b.verify_attempts >= 5) {
      await tx.query(`UPDATE bookings SET status = 'expired', version = version + 1, updated_at = now() WHERE id = $1`, [b.id]);
      return { error: new HttpError(410, 'too_many_attempts', 'Příliš mnoho nesprávných pokusů. Vyberte prosím termín znovu.') };
    }
    if (!safeEqual(codeHash(String(code).trim(), b.id), b.verify_code_hash || '')) {
      const attempts = b.verify_attempts + 1;
      await tx.query(`UPDATE bookings SET verify_attempts = $2 WHERE id = $1`, [b.id, attempts]);
      if (attempts >= 5) {
        await tx.query(`UPDATE bookings SET status = 'expired', version = version + 1, updated_at = now() WHERE id = $1`, [b.id]);
        return { error: new HttpError(410, 'too_many_attempts', 'Příliš mnoho nesprávných pokusů. Vyberte prosím termín znovu.') };
      }
      return { error: new HttpError(400, 'wrong_code', 'Kód nesouhlasí. Zkontrolujte prosím e-mail.') };
    }
    const upd = (await tx.query(
      `UPDATE bookings SET status = 'confirmed', email_verified = true, hold_expires_at = NULL, verify_code_hash = NULL,
         version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [b.id])).rows[0];
    await addHistory(tx, b.id, 'client', null, 'confirmed', { via: 'email_code' });
    const raw = await onConfirmed(tx, upd, settings, { now });
    return { ok: { booking: publicBooking(upd, settings), manage_url: manageUrl(raw) } };
  });
  if (outcome.error) throw outcome.error;
  return outcome.ok;
}

export async function resendVerification(bookingId, { now = new Date() } = {}) {
  const settings = await getSettings();
  return withTx(async (tx) => {
    const b = (await tx.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId])).rows[0];
    if (!b || b.status !== 'held' || b.hold_expires_at <= now) throw new HttpError(410, 'hold_expired', 'Platnost rezervace vypršela.');
    if (b.verify_sent_count >= 3) throw new HttpError(429, 'too_many_resends', 'Kód už byl odeslán opakovaně. Zkontrolujte prosím e-mail (i spam).');
    const code = randomCode();
    const n = b.verify_sent_count + 1;
    await tx.query(`UPDATE bookings SET verify_code_hash = $2, verify_sent_count = $3, verify_attempts = 0 WHERE id = $1`, [b.id, codeHash(code, b.id), n]);
    await queueEmail(tx, {
      templateKey: 'booking_verify', to: b.client_email, bookingId: b.id, dedupeKey: `verify:${b.id}:${n}`,
      vars: bookingVars(b, settings, { code, hold_minutes: settings.hold_minutes }),
    });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------------------
// Zrušení, žádost o změnu
// ---------------------------------------------------------------------------------------
export async function cancelBooking(bookingId, { actor, userId = null, reason = '', enforcePolicy = false, notify = true, now = new Date(), ownerCheck = null }) {
  const settings = await getSettings();
  return withTx(async (tx) => {
    await lockAvailability(tx);
    const b = (await tx.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId])).rows[0];
    if (!b) throw notFound('Rezervace nenalezena.');
    if (ownerCheck && !ownerCheck(b)) throw notFound('Rezervace nenalezena.');
    if (!ACTIVE.includes(b.status)) {
      if (b.status === 'cancelled') return { booking: publicBooking(b, settings, { admin: actor === 'admin' }), already: true };
      throw conflict('Tuto rezervaci už nelze zrušit.', 'not_cancellable');
    }
    if (enforcePolicy) {
      const hoursLeft = (b.starts_at.getTime() - now.getTime()) / 3600_000;
      if (hoursLeft < settings.cancel_hours_before) {
        const content = await getContent(tx);
        throw forbidden(`Rezervaci už nelze zrušit online (nejpozději ${settings.cancel_hours_before} h předem). Prosím zavolejte na ${content.contact_phone}.`);
      }
    }
    const upd = (await tx.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3,
         hold_expires_at = NULL, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [b.id, actor, String(reason).slice(0, 500)])).rows[0];
    await addHistory(tx, b.id, actor, userId, 'cancelled', { reason });
    if (b.status === 'confirmed' && notify && b.client_email) {
      await queueEmail(tx, { templateKey: 'booking_cancelled', to: b.client_email, bookingId: b.id, dedupeKey: `cancelled:${b.id}`, vars: bookingVars(upd, settings) });
    }
    await enqueue(tx, 'calendar_push', { bookingId: b.id }, { dedupeKey: `cal:${b.id}:${upd.version}` });
    return { booking: publicBooking(upd, settings, { admin: actor === 'admin' }) };
  });
}

export async function requestReschedule(bookingId, message, { ownerCheck, now = new Date() } = {}) {
  const settings = await getSettings();
  return withTx(async (tx) => {
    const b = (await tx.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId])).rows[0];
    if (!b || (ownerCheck && !ownerCheck(b))) throw notFound('Rezervace nenalezena.');
    if (b.status !== 'confirmed' || b.starts_at <= now) throw conflict('U této rezervace už nelze žádat o změnu.', 'not_changeable');
    const open = (await tx.query(`SELECT count(*)::int AS n FROM reschedule_requests WHERE booking_id = $1 AND status = 'open'`, [b.id])).rows[0].n;
    if (open >= 3) throw new HttpError(429, 'too_many_requests', 'Žádost už jsme obdrželi. Ozveme se vám.');
    const r = (await tx.query(`INSERT INTO reschedule_requests (booking_id, message) VALUES ($1, $2) RETURNING id`, [b.id, String(message).slice(0, 1000)])).rows[0];
    await addHistory(tx, b.id, 'client', b.user_id, 'reschedule_requested', { message });
    for (const to of await adminAlertRecipients(tx, settings)) {
      await queueEmail(tx, {
        templateKey: 'admin_reschedule_request', to, bookingId: b.id, dedupeKey: `resreq:${r.id}:${to}`,
        vars: bookingVars(b, settings, { details: message }),
      });
    }
    return { ok: true };
  });
}

export async function bookingByManageToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  return (await query(`SELECT * FROM bookings WHERE manage_token_hash = $1`, [sha256Hex(token)])).rows[0] || null;
}

export function decryptManageToken(b) { return b.manage_token_enc ? decrypt(b.manage_token_enc) : null; }

// ---------------------------------------------------------------------------------------
// Administrace: ruční rezervace, přesuny, úpravy
// ---------------------------------------------------------------------------------------
export async function adminCreateBooking(input, { adminId, now = new Date() }) {
  const settings = await getSettings();
  try {
    return await withTx(async (tx) => {
      await lockAvailability(tx);
      await expireHolds(tx, now);
      const service = input.serviceId ? (await tx.query(`SELECT * FROM services WHERE id = $1`, [input.serviceId])).rows[0] : null;
      if (input.serviceId && !service) throw badRequest('Služba neexistuje.');
      const name = service ? service.name : (input.serviceName || 'Rezervace');
      const duration = input.durationMinutes || service?.duration_minutes;
      if (!duration) throw badRequest('Zadejte délku rezervace.');
      const endsAt = addMinutes(input.startsAt, duration);
      const blockedUntil = addMinutes(endsAt, input.noBuffer ? 0 : settings.buffer_minutes);
      const conflicts = await findConflicts(tx, input.startsAt, blockedUntil, { now });
      if (conflicts.length && !input.force) {
        throw new HttpError(409, 'conflict_detected', 'Termín koliduje s jinou rezervací nebo blokací.', { conflicts, can_override: true });
      }
      const price = input.priceCzk !== undefined ? input.priceCzk : (service ? service.price_czk : null);
      const ins = await tx.query(
        `INSERT INTO bookings (service_id, user_id, service_name, service_duration_minutes, price_czk, client_name, client_email,
           client_phone, client_note, admin_note, starts_at, ends_at, blocked_until, status, source, email_verified, conflict_override)
         VALUES ($1, (SELECT id FROM users WHERE lower(email) = $2 AND deleted_at IS NULL), $3,$4,$5,$6,$2,$7,$8,$9,$10,$11,$12,'confirmed','admin',$13,$14) RETURNING *`,
        [service ? service.id : null, (input.email || '').toLowerCase(), name, duration, price, input.name, input.phone || '',
          input.clientNote || '', input.adminNote || '', input.startsAt, endsAt, blockedUntil, Boolean(input.email), conflicts.length > 0]);
      let b = ins.rows[0];
      b = (await tx.query(`UPDATE bookings SET version = version + 1 WHERE id = $1 RETURNING *`, [b.id])).rows[0];
      await addHistory(tx, b.id, 'admin', adminId, 'created', { forced: conflicts.length > 0, conflicts });
      await audit(tx, adminId, 'booking.create', 'booking', b.id, { forced: conflicts.length > 0 });
      await onConfirmed(tx, b, settings, { notifyClient: input.notify !== false, now });
      return { booking: publicBooking(b, settings, { admin: true }) };
    });
  } catch (err) {
    if (isExclusionViolation(err)) throw slotTaken();
    throw err;
  }
}

export async function adminUpdateBooking(bookingId, patch, { adminId, now = new Date() }) {
  const settings = await getSettings();
  try {
    return await withTx(async (tx) => {
      await lockAvailability(tx);
      const b = (await tx.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId])).rows[0];
      if (!b) throw notFound('Rezervace nenalezena.');
      // Skutečná změna času/délky (shodný PATCH se neeviduje jako změna → žádná nová verze, e-mail ani zápis do kalendáře)
      const timeChange = (patch.startsAt !== undefined && patch.startsAt.getTime() !== b.starts_at.getTime())
        || (patch.durationMinutes !== undefined && patch.durationMinutes !== b.service_duration_minutes);
      if (timeChange && !ACTIVE.includes(b.status)) throw conflict('Čas zrušené rezervace nelze měnit.', 'not_changeable');

      const startsAt = patch.startsAt ?? b.starts_at;
      const duration = patch.durationMinutes ?? b.service_duration_minutes;
      const endsAt = addMinutes(startsAt, duration);
      const blockedUntil = addMinutes(endsAt, settings.buffer_minutes);
      let override = b.conflict_override;
      if (timeChange) {
        const conflicts = await findConflicts(tx, startsAt, blockedUntil, { excludeBookingId: b.id, now });
        if (conflicts.length && !patch.force) {
          throw new HttpError(409, 'conflict_detected', 'Nový termín koliduje s jinou rezervací nebo blokací.', { conflicts, can_override: true });
        }
        override = conflicts.length > 0;
      }
      const sets = []; const vals = [b.id]; const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (patch.name !== undefined) add('client_name', patch.name);
      if (patch.email !== undefined) add('client_email', patch.email.toLowerCase());
      if (patch.phone !== undefined) add('client_phone', patch.phone);
      if (patch.clientNote !== undefined) add('client_note', patch.clientNote);
      if (patch.adminNote !== undefined) add('admin_note', patch.adminNote);
      if (patch.priceCzk !== undefined) add('price_czk', patch.priceCzk);
      if (patch.status !== undefined && ['completed', 'no_show'].includes(patch.status) && b.status === 'confirmed') add('status', patch.status);
      if (timeChange) {
        add('starts_at', startsAt); add('ends_at', endsAt); add('blocked_until', blockedUntil);
        add('service_duration_minutes', duration); add('conflict_override', override);
        sets.push('version = version + 1');
      }
      if (!sets.length) return { booking: publicBooking(b, settings, { admin: true }) };
      sets.push('updated_at = now()');
      const upd = (await tx.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)).rows[0];
      await addHistory(tx, b.id, 'admin', adminId, timeChange ? 'rescheduled' : 'edited', {
        from: timeChange ? { starts_at: b.starts_at, duration: b.service_duration_minutes } : undefined,
        to: timeChange ? { starts_at: startsAt, duration } : undefined, fields: Object.keys(patch).filter((k) => k !== 'force'),
      });
      await audit(tx, adminId, timeChange ? 'booking.reschedule' : 'booking.edit', 'booking', b.id, { fields: Object.keys(patch) });
      if (timeChange && ACTIVE.includes(upd.status)) {
        await enqueue(tx, 'calendar_push', { bookingId: b.id }, { dedupeKey: `cal:${b.id}:${upd.version}` });
        if (patch.notify !== false && upd.client_email && b.status === 'confirmed') {
          await queueEmail(tx, {
            templateKey: 'booking_rescheduled', to: upd.client_email, bookingId: b.id, dedupeKey: `rescheduled:${b.id}:${upd.version}`,
            vars: bookingVars(upd, settings, { manage_url: upd.manage_token_enc ? manageUrl(decrypt(upd.manage_token_enc)) : '' }),
          });
        }
        if (upd.client_email && upd.status === 'confirmed') await scheduleReminders(tx, upd, settings, now);
        await tx.query(`UPDATE reschedule_requests SET status = 'done', handled_at = now() WHERE booking_id = $1 AND status = 'open'`, [b.id]);
      }
      return { booking: publicBooking(upd, settings, { admin: true }) };
    });
  } catch (err) {
    if (isExclusionViolation(err)) throw slotTaken();
    throw err;
  }
}

/** Handler připomínek (úloha send_reminder) */
export async function sendReminder({ bookingId, startsAt, hours }) {
  const settings = await getSettings();
  const b = (await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId])).rows[0];
  if (!b || b.status !== 'confirmed' || b.starts_at.toISOString() !== startsAt || !b.client_email) return { skipped: true };
  if (b.starts_at <= new Date()) return { skipped: true };
  const raw = b.manage_token_enc ? decrypt(b.manage_token_enc) : null;
  await withTx(async (tx) => {
    await queueEmail(tx, {
      templateKey: 'booking_reminder', to: b.client_email, bookingId: b.id,
      dedupeKey: `reminder:${b.id}:${b.starts_at.getTime()}:${hours}`,
      vars: bookingVars(b, settings, { manage_url: raw ? manageUrl(raw) : '' }),
    });
  });
  return { queued: true };
}
