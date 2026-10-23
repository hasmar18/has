import {
  localDateStr, addDaysStr, isoWeekdayOfDateStr, dayStartUtc, localToUtc, addMinutes, parseDateStr, formatTimeCs,
} from '../lib/time.js';

/**
 * Všechny časové úseky, které jsou obsazené z jakéhokoli důvodu:
 *  - aktivní rezervace (potvrzené + dosud neexpirované „držené“) včetně rezervy za procedurou,
 *  - ruční blokace administrátora,
 *  - události z propojených kalendářů, které blokují dostupnost.
 * Důvod se klientkám nikdy nevrací – jen časy.
 */
export async function loadBusy(db, fromUtc, toUtc, now = new Date(), { excludeBookingId = null } = {}) {
  const [b, t, e] = await Promise.all([
    db.query(
      `SELECT id, starts_at AS s, blocked_until AS e FROM bookings
       WHERE status IN ('held', 'confirmed') AND (status = 'confirmed' OR hold_expires_at > $3)
         AND tstzrange(starts_at, blocked_until, '[)') && tstzrange($1, $2, '[)')
         AND ($4::uuid IS NULL OR id <> $4::uuid)`,
      [fromUtc, toUtc, now, excludeBookingId]),
    db.query(`SELECT id, starts_at AS s, ends_at AS e FROM time_blocks WHERE tstzrange(starts_at, ends_at, '[)') && tstzrange($1, $2, '[)')`, [fromUtc, toUtc]),
    db.query(
      `SELECT x.id, x.starts_at AS s, x.ends_at AS e FROM external_blocks x
       JOIN calendar_sources cs ON cs.id = x.source_id
       WHERE cs.blocks_availability AND (NOT x.is_all_day OR cs.block_all_day)
         AND tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange($1, $2, '[)')`,
      [fromUtc, toUtc]),
  ]);
  const out = [];
  for (const r of b.rows) out.push({ kind: 'booking', id: r.id, s: r.s, e: r.e });
  for (const r of t.rows) out.push({ kind: 'block', id: r.id, s: r.s, e: r.e });
  for (const r of e.rows) out.push({ kind: 'external', id: r.id, s: r.s, e: r.e });
  out.sort((x, y) => x.s - y.s);
  return out;
}

function mergeWindows(ws) {
  const sorted = ws.filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end) { if (w.end > last.end) last.end = w.end; }
    else out.push({ start: w.start, end: w.end });
  }
  return out;
}

export function windowsForDate(date, tz, hours, exceptions) {
  const wd = isoWeekdayOfDateStr(date);
  const closed = exceptions.some((x) => x.kind === 'closed' && x.date_from <= date && x.date_to >= date);
  const opens = exceptions.filter((x) => x.kind === 'open' && x.date_from === date);
  const toWin = (st, en) => ({ start: localToUtc(date, String(st), tz), end: localToUtc(date, String(en), tz) });
  const regular = hours.filter((h) => h.weekday === wd).map((h) => toWin(h.start_time, h.end_time));
  const extra = opens.map((x) => toWin(x.start_time, x.end_time));
  if (opens.length) return mergeWindows(closed ? extra : [...regular, ...extra]);
  if (closed) return [];
  return mergeWindows(regular);
}

const pgDate = (d) => (d instanceof Date ? localDateStr(d, 'UTC') : String(d).slice(0, 10));

/**
 * Volné časy pro službu dané délky. Vrací jen časy, které jsou skutečně volné.
 * @returns {{days: {date: string, slots: {start: string, time: string}[]}[]}}
 */
export async function computeAvailability(db, { durationMinutes, fromDate, toDate, now = new Date(), settings }) {
  const tz = settings.timezone;
  const today = localDateStr(now, tz);
  const first = fromDate > today ? fromDate : today;
  const horizon = addDaysStr(today, settings.max_advance_days);
  const last = toDate < horizon ? toDate : horizon;
  if (!parseDateStr(first) || !parseDateStr(last) || first > last) return { days: [] };

  const spanStart = dayStartUtc(addDaysStr(first, -1), tz);
  const spanEnd = dayStartUtc(addDaysStr(last, 2), tz);

  const [hoursRes, excRes, busy] = await Promise.all([
    db.query(`SELECT weekday, start_time::text AS start_time, end_time::text AS end_time FROM working_hours ORDER BY weekday, start_time`),
    db.query(
      `SELECT kind, date_from::text AS date_from, date_to::text AS date_to, start_time::text AS start_time, end_time::text AS end_time
       FROM schedule_exceptions WHERE date_from <= $2::date AND date_to >= $1::date`, [first, last]),
    loadBusy(db, spanStart, spanEnd, now),
  ]);
  const hours = hoursRes.rows.map((r) => ({ ...r, weekday: Number(r.weekday) }));
  const exceptions = excRes.rows.map((r) => ({ ...r, date_from: pgDate(r.date_from), date_to: pgDate(r.date_to) }));

  const earliest = addMinutes(now, Math.round(settings.min_notice_hours * 60));
  const interval = settings.slot_interval_minutes;
  const buffer = settings.buffer_minutes;
  const days = [];

  for (let date = first; date <= last; date = addDaysStr(date, 1)) {
    const wins = windowsForDate(date, tz, hours, exceptions);
    const slots = [];
    for (const w of wins) {
      for (let s = w.start; addMinutes(s, durationMinutes) <= w.end; s = addMinutes(s, interval)) {
        if (s < earliest) continue;
        const candEnd = addMinutes(s, durationMinutes + buffer);
        let clash = false;
        for (const b of busy) {
          if (b.s >= candEnd) break;
          if (b.e > s) { clash = true; break; }
        }
        if (!clash) slots.push({ start: s.toISOString(), time: formatTimeCs(s, tz) });
      }
    }
    days.push({ date, slots });
  }
  return { days };
}

/** Je přesně tento počátek stále nabízený (vč. zarovnání na mřížku a pracovní doby)? */
export async function isSlotOffered(db, { startsAt, durationMinutes, settings, now = new Date() }) {
  const date = localDateStr(startsAt, settings.timezone);
  const { days } = await computeAvailability(db, { durationMinutes, fromDate: date, toDate: date, now, settings });
  const iso = startsAt.toISOString();
  return days.some((d) => d.date === date && d.slots.some((s) => s.start === iso));
}

/** Kolize pro administrátora (ruční rezervace / přesun) – s důvodem, protože admin ho smí vidět. */
export async function findConflicts(db, startsAt, blockedUntil, { excludeBookingId = null, now = new Date() } = {}) {
  const busy = await loadBusy(db, startsAt, blockedUntil, now, { excludeBookingId });
  return busy.filter((b) => b.s < blockedUntil && b.e > startsAt).map((b) => ({
    kind: b.kind, id: b.id, starts_at: b.s.toISOString(), ends_at: b.e.toISOString(),
  }));
}
