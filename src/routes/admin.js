import { z } from 'zod';
import { query, withTx, lockAvailability } from '../db.js';
import { config } from '../config.js';
import { HttpError, badRequest, notFound, conflict } from '../lib/errors.js';
import { addDaysStr, localDateStr, dayStartUtc, parseDateStr } from '../lib/time.js';
import { getSettings, updateSettings, SETTING_DEFS } from '../services/settings.js';
import { getContent, setContent, CONTENT_DEFS } from '../services/content.js';
import * as bookings from '../services/bookings.js';
import { findConflicts } from '../services/availability.js';
import { audit } from '../services/audit.js';
import { enqueue } from '../services/jobs.js';
import { DEFAULT_TEMPLATES, TEMPLATE_VARS } from '../services/templates.js';
import { emailProviderConfigured, retryEmail, queueEmail } from '../services/email.js';
import { calendarHealth } from '../calendar/health.js';
import { requireAdmin } from './middleware.js';
import { email as emailSchema, phone as phoneSchema, personName, uuid, isoDate, isoTime, instant } from './schemas.js';

const A = requireAdmin;
const optStr = (n = 500) => z.string().trim().max(n);

function parseRange(q, tz, defaultDays = 7) {
  const now = new Date();
  const from = q.from ? new Date(q.from) : dayStartUtc(localDateStr(now, tz), tz);
  const to = q.to ? new Date(q.to) : new Date(from.getTime() + defaultDays * 86400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw badRequest('Neplatné období.');
  if (to - from > 100 * 86400_000) throw badRequest('Období je příliš dlouhé.');
  return { from, to };
}

const adminBooking = (b, settings) => bookings.publicBooking(b, settings, { admin: true });

export function mount(app) {
  // ---------------------------------------------------------------- přehled
  app.get('/api/admin/dashboard', A, async () => {
    const settings = await getSettings();
    const now = new Date();
    const [svc, noPrice, hours, upcoming, requests, failedEmails, failedJobs, health, drift, conn, ig] = await Promise.all([
      query(`SELECT count(*)::int AS n FROM services WHERE is_active AND archived_at IS NULL`),
      query(`SELECT count(*)::int AS n FROM services WHERE is_active AND archived_at IS NULL AND price_czk IS NULL`),
      query(`SELECT count(*)::int AS n FROM working_hours`),
      query(`SELECT count(*)::int AS n FROM bookings WHERE status = 'confirmed' AND starts_at BETWEEN now() AND now() + interval '7 days'`),
      query(`SELECT count(*)::int AS n FROM reschedule_requests WHERE status = 'open'`),
      query(`SELECT count(*)::int AS n FROM email_log WHERE status IN ('failed', 'bounced') AND created_at > now() - interval '7 days'`),
      query(`SELECT count(*)::int AS n FROM jobs WHERE status = 'failed' AND finished_at > now() - interval '7 days'`),
      calendarHealth({ query }, settings, now),
      query(`SELECT count(*)::int AS n FROM booking_calendar_events m JOIN bookings b ON b.id = m.booking_id WHERE m.drift IS NOT NULL AND b.status = 'confirmed' AND b.ends_at > now()`),
      query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE write_enabled) AS writers FROM calendar_connections`),
      query(`SELECT 1 FROM users WHERE role = 'admin' AND must_change_password LIMIT 1`),
    ]);
    const emailOk = emailProviderConfigured();
    const checklist = [
      { key: 'services', ok: svc.rows[0].n > 0, label: 'Přidejte alespoň jednu službu (Služby).' },
      { key: 'prices', ok: noPrice.rows[0].n === 0, label: `Doplňte ceny u služeb (${noPrice.rows[0].n} bez ceny) – Služby.` },
      { key: 'hours', ok: hours.rows[0].n > 0, label: 'Nastavte dny a časy, kdy lze zadávat rezervace (Doba rezervací).' },
      { key: 'email', ok: emailOk, label: 'Nakonfigurujte odesílání e-mailů – proměnné BREVO_API_KEY a MAIL_FROM_EMAIL v prostředí Renderu.' },
      { key: 'calendar', ok: conn.rows[0].total > 0, label: 'Propojte kalendář (Nastavení → Kalendář).', optional: true },
      { key: 'calendar_write', ok: Number(conn.rows[0].writers) > 0 || conn.rows[0].total === 0, label: 'Vyberte kalendář, do kterého se zapisují rezervace.', optional: true },
      { key: 'reviewed', ok: settings.settings_reviewed, label: 'Zkontrolujte nastavení (storno lhůta, rezerva, předstih) a právní texty, pak to potvrďte v Nastavení.' },
      { key: 'encryption', ok: Boolean(config.encryptionKey) || !config.isProd, label: 'Chybí ENCRYPTION_KEY.' },
      { key: 'https', ok: config.baseUrl.startsWith('https://') || !config.isProd, label: 'BASE_URL musí být https adresa webu.' },
      { key: 'enabled', ok: settings.online_booking_enabled, label: 'Zapněte online rezervace (Nastavení → Obecné), až bude vše připraveno.' },
    ];
    return {
      checklist,
      stats: {
        upcoming_week: upcoming.rows[0].n, open_requests: requests.rows[0].n, failed_emails: failedEmails.rows[0].n,
        failed_jobs: failedJobs.rows[0].n, calendar_drift: drift.rows[0].n,
      },
      calendar: { degraded: health.degraded, stale: health.stale.map((s) => ({ name: s.name, status: s.status, last_synced_at: s.last_synced_at, last_error: s.last_error })) },
      online_booking_enabled: settings.online_booking_enabled,
    };
  });

  // ---------------------------------------------------------------- rezervace
  app.get('/api/admin/calendar', A, async (ctx) => {
    const settings = await getSettings();
    const { from, to } = parseRange(ctx.query, settings.timezone, 7);
    const [b, blocks, ext] = await Promise.all([
      query(
        `SELECT bk.*, m.state AS cal_state, m.drift AS cal_drift, m.last_error AS cal_error FROM bookings bk
         LEFT JOIN booking_calendar_events m ON m.booking_id = bk.id
         WHERE bk.status IN ('held', 'confirmed', 'completed', 'no_show')
           AND (bk.status <> 'held' OR bk.hold_expires_at > now())
           AND tstzrange(bk.starts_at, bk.blocked_until, '[)') && tstzrange($1, $2, '[)') ORDER BY bk.starts_at`, [from, to]),
      query(`SELECT id, starts_at, ends_at, reason FROM time_blocks WHERE tstzrange(starts_at, ends_at, '[)') && tstzrange($1, $2, '[)') ORDER BY starts_at`, [from, to]),
      query(
        `SELECT x.id, x.starts_at, x.ends_at, x.is_all_day, cs.name AS calendar_name, cs.blocks_availability FROM external_blocks x JOIN calendar_sources cs ON cs.id = x.source_id
         WHERE tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange($1, $2, '[)') ORDER BY x.starts_at`, [from, to]),
    ]);
    return {
      timezone: settings.timezone, from: from.toISOString(), to: to.toISOString(),
      bookings: b.rows.map((r) => ({ ...adminBooking(r, settings), held: r.status === 'held', cal_state: r.cal_state, cal_drift: r.cal_drift, cal_error: r.cal_error })),
      blocks: blocks.rows.map((r) => ({ id: r.id, starts_at: r.starts_at.toISOString(), ends_at: r.ends_at.toISOString(), reason: r.reason })),
      external: ext.rows.map((r) => ({ id: r.id, starts_at: r.starts_at.toISOString(), ends_at: r.ends_at.toISOString(), is_all_day: r.is_all_day, calendar_name: r.calendar_name, blocking: r.blocks_availability })),
    };
  });

  app.get('/api/admin/bookings', A, async (ctx) => {
    const settings = await getSettings();
    const q = z.object({
      from: z.string().optional(), to: z.string().optional(), status: z.string().optional(), service_id: uuid.optional(),
      q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(ctx.query);
    const where = []; const p = [];
    const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (q.from) add('b.starts_at >= ?', new Date(q.from));
    if (q.to) add('b.starts_at < ?', new Date(q.to));
    if (q.status) add('b.status = ?', q.status);
    if (q.service_id) add('b.service_id = ?', q.service_id);
    if (q.q) add(`(b.client_name ILIKE ? OR b.client_email ILIKE $${p.length + 1} OR b.client_phone ILIKE $${p.length + 1})`, `%${q.q}%`);
    const rows = (await query(
      `SELECT b.*, m.state AS cal_state, m.drift AS cal_drift, m.last_error AS cal_error FROM bookings b LEFT JOIN booking_calendar_events m ON m.booking_id = b.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.starts_at DESC LIMIT ${q.limit}`, p)).rows;
    return { bookings: rows.map((r) => ({ ...adminBooking(r, settings), cal_state: r.cal_state, cal_drift: r.cal_drift, cal_error: r.cal_error })) };
  });

  app.get('/api/admin/bookings/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const settings = await getSettings();
    const b = (await query(`SELECT * FROM bookings WHERE id = $1`, [ctx.params.id])).rows[0];
    if (!b) throw notFound('Rezervace nenalezena.');
    const [hist, reqs, cal, emails] = await Promise.all([
      query(`SELECT at, actor, action, details FROM booking_history WHERE booking_id = $1 ORDER BY at DESC, id DESC`, [b.id]),
      query(`SELECT id, message, status, created_at FROM reschedule_requests WHERE booking_id = $1 ORDER BY created_at DESC`, [b.id]),
      query(`SELECT state, drift, last_error, synced_version, updated_at FROM booking_calendar_events WHERE booking_id = $1`, [b.id]),
      query(`SELECT id, template_key, status, last_error, created_at FROM email_log WHERE booking_id = $1 ORDER BY created_at DESC`, [b.id]),
    ]);
    return { booking: adminBooking(b, settings), history: hist.rows, reschedule_requests: reqs.rows, calendar: cal.rows[0] || null, emails: emails.rows };
  });

  const manualBody = z.object({
    service_id: uuid.nullable().optional(), service_name: optStr(120).optional(), starts_at: instant, duration_minutes: z.number().int().min(5).max(720).optional(),
    name: personName, email: z.union([z.literal(''), emailSchema]).default(''), phone: z.union([z.literal(''), phoneSchema]).default(''),
    client_note: optStr().default(''), admin_note: optStr().default(''), price_czk: z.number().int().min(0).nullable().optional(),
    force: z.boolean().default(false), notify: z.boolean().default(true),
  });
  app.post('/api/admin/bookings', A, async (ctx) => {
    const b = manualBody.parse(await ctx.json());
    return bookings.adminCreateBooking({
      serviceId: b.service_id || null, serviceName: b.service_name, startsAt: b.starts_at, durationMinutes: b.duration_minutes, name: b.name, email: b.email,
      phone: b.phone, clientNote: b.client_note, adminNote: b.admin_note, priceCzk: b.price_czk, force: b.force, notify: b.notify,
    }, { adminId: ctx.user.id });
  });

  const patchBody = z.object({
    starts_at: instant.optional(), duration_minutes: z.number().int().min(5).max(720).optional(), name: personName.optional(),
    email: z.union([z.literal(''), emailSchema]).optional(), phone: z.union([z.literal(''), phoneSchema]).optional(),
    client_note: optStr().optional(), admin_note: optStr().optional(), price_czk: z.number().int().min(0).nullable().optional(),
    status: z.enum(['completed', 'no_show']).optional(), force: z.boolean().optional(), notify: z.boolean().optional(),
  });
  app.patch('/api/admin/bookings/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const b = patchBody.parse(await ctx.json());
    return bookings.adminUpdateBooking(ctx.params.id, {
      startsAt: b.starts_at, durationMinutes: b.duration_minutes, name: b.name, email: b.email, phone: b.phone,
      clientNote: b.client_note, adminNote: b.admin_note, priceCzk: b.price_czk, status: b.status, force: b.force, notify: b.notify,
    }, { adminId: ctx.user.id });
  });

  app.post('/api/admin/bookings/:id/cancel', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const b = z.object({ reason: optStr().default(''), notify: z.boolean().default(true) }).parse(await ctx.json());
    const r = await bookings.cancelBooking(ctx.params.id, { actor: 'admin', userId: ctx.user.id, reason: b.reason, notify: b.notify });
    await audit({ query }, ctx.user.id, 'booking.cancel', 'booking', ctx.params.id, { reason: b.reason });
    return r;
  });

  app.post('/api/admin/bookings/:id/resync', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const b = (await query(`SELECT id, version FROM bookings WHERE id = $1`, [ctx.params.id])).rows[0];
    if (!b) throw notFound();
    await enqueue({ query }, 'calendar_push', { bookingId: b.id }, { dedupeKey: `calmanual:${b.id}:${Date.now()}` });
    return { ok: true };
  });

  app.patch('/api/admin/reschedule-requests/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const b = z.object({ status: z.enum(['done', 'dismissed']) }).parse(await ctx.json());
    await query(`UPDATE reschedule_requests SET status = $2, handled_at = now() WHERE id = $1`, [ctx.params.id, b.status]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- blokace
  app.post('/api/admin/blocks', A, async (ctx) => {
    const b = z.object({ starts_at: instant, ends_at: instant, reason: optStr(200).default(''), force: z.boolean().default(false) }).parse(await ctx.json());
    if (b.ends_at <= b.starts_at) throw badRequest('Konec musí být po začátku.');
    return withTx(async (tx) => {
      await lockAvailability(tx);
      const conflicts = (await findConflicts(tx, b.starts_at, b.ends_at)).filter((c) => c.kind === 'booking');
      if (conflicts.length && !b.force) {
        throw new HttpError(409, 'conflict_detected', 'V tomto čase už existují rezervace. Blokace je neruší – chcete ji přesto vytvořit?', { conflicts, can_override: true });
      }
      const r = (await tx.query(`INSERT INTO time_blocks (starts_at, ends_at, reason, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [b.starts_at, b.ends_at, b.reason, ctx.user.id])).rows[0];
      await audit(tx, ctx.user.id, 'block.create', 'time_block', r.id, { starts_at: b.starts_at, ends_at: b.ends_at });
      return { id: r.id, conflicts };
    });
  });

  app.delete('/api/admin/blocks/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    await withTx(async (tx) => {
      await lockAvailability(tx);
      await tx.query(`DELETE FROM time_blocks WHERE id = $1`, [ctx.params.id]);
      await audit(tx, ctx.user.id, 'block.delete', 'time_block', ctx.params.id);
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- pracovní doba
  app.get('/api/admin/hours', A, async () => {
    const [h, e] = await Promise.all([
      query(`SELECT weekday, start_time::text AS start, end_time::text AS "end" FROM working_hours ORDER BY weekday, start_time`),
      query(`SELECT id, date_from::text AS date_from, date_to::text AS date_to, kind, start_time::text AS start, end_time::text AS "end", note FROM schedule_exceptions ORDER BY date_from DESC LIMIT 200`),
    ]);
    return {
      hours: h.rows.map((r) => ({ weekday: Number(r.weekday), start: r.start.slice(0, 5), end: r.end.slice(0, 5) })),
      exceptions: e.rows.map((r) => ({ ...r, start: r.start ? r.start.slice(0, 5) : null, end: r.end ? r.end.slice(0, 5) : null })),
    };
  });

  app.put('/api/admin/hours', A, async (ctx) => {
    const b = z.object({ hours: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: isoTime, end: isoTime })).max(40) }).parse(await ctx.json());
    const norm = (t) => t.padStart(5, '0');
    for (const h of b.hours) if (norm(h.end) <= norm(h.start)) throw badRequest('Konec pracovní doby musí být po začátku.');
    // překryv v rámci dne
    for (let d = 1; d <= 7; d += 1) {
      const day = b.hours.filter((h) => h.weekday === d).sort((x, y) => norm(x.start).localeCompare(norm(y.start)));
      for (let i = 1; i < day.length; i += 1) if (norm(day[i].start) < norm(day[i - 1].end)) throw badRequest('Úseky pracovní doby se v jednom dni nesmí překrývat.');
    }
    await withTx(async (tx) => {
      await tx.query(`DELETE FROM working_hours`);
      for (const h of b.hours) await tx.query(`INSERT INTO working_hours (weekday, start_time, end_time) VALUES ($1, $2, $3)`, [h.weekday, h.start, h.end]);
      await audit(tx, ctx.user.id, 'hours.update', 'working_hours', null, { count: b.hours.length });
    });
    return { ok: true };
  });

  app.post('/api/admin/exceptions', A, async (ctx) => {
    const b = z.object({ kind: z.enum(['closed', 'open']), date_from: isoDate, date_to: isoDate, start: isoTime.optional(), end: isoTime.optional(), note: optStr(200).default('') }).parse(await ctx.json());
    if (!parseDateStr(b.date_from) || !parseDateStr(b.date_to) || b.date_to < b.date_from) throw badRequest('Neplatné datum.');
    if (b.kind === 'open' && (!b.start || !b.end || b.end.padStart(5, '0') <= b.start.padStart(5, '0') || b.date_from !== b.date_to)) throw badRequest('Mimořádné hodiny: zadejte jeden den a čas od–do.');
    const r = (await query(`INSERT INTO schedule_exceptions (kind, date_from, date_to, start_time, end_time, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.kind, b.date_from, b.date_to, b.kind === 'open' ? b.start : null, b.kind === 'open' ? b.end : null, b.note])).rows[0];
    await audit({ query }, ctx.user.id, 'exception.create', 'schedule_exception', r.id, b);
    // upozornění na již existující rezervace v zavřených dnech
    let affected = 0;
    if (b.kind === 'closed') {
      const settings = await getSettings();
      affected = (await query(`SELECT count(*)::int AS n FROM bookings WHERE status = 'confirmed' AND starts_at >= $1 AND starts_at < $2`,
        [dayStartUtc(b.date_from, settings.timezone), dayStartUtc(addDaysStr(b.date_to, 1), settings.timezone)])).rows[0].n;
    }
    return { id: r.id, affected_bookings: affected };
  });

  app.delete('/api/admin/exceptions/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    await query(`DELETE FROM schedule_exceptions WHERE id = $1`, [ctx.params.id]);
    await audit({ query }, ctx.user.id, 'exception.delete', 'schedule_exception', ctx.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- nastavení a obsah
  app.get('/api/admin/settings', A, async () => ({ settings: await getSettings(), defaults: Object.fromEntries(Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.def])) }));
  app.put('/api/admin/settings', A, async (ctx) => {
    const patch = await ctx.json();
    const changed = await updateSettings({ query }, patch);
    await audit({ query }, ctx.user.id, 'settings.update', 'settings', null, changed);
    return { settings: await getSettings() };
  });

  app.get('/api/admin/content', A, async () => ({
    content: await getContent(),
    fields: Object.entries(CONTENT_DEFS).map(([key, d]) => ({ key, label: d.label, multiline: d.multiline, default: d.def })),
  }));
  app.put('/api/admin/content', A, async (ctx) => {
    const patch = await ctx.json();
    const changed = await setContent({ query }, patch, ctx.user.id);
    await audit({ query }, ctx.user.id, 'content.update', 'site_content', null, { keys: changed });
    return { ok: true, changed };
  });

  // ---------------------------------------------------------------- služby
  const serviceBody = z.object({
    name: z.string().trim().min(2).max(120), description: z.string().trim().max(2000).default(''),
    duration_minutes: z.number().int().min(5).max(720), price_czk: z.number().int().min(0).max(1_000_000).nullable().default(null),
    price_from: z.boolean().default(false), category_id: uuid.nullable().default(null), is_active: z.boolean().default(true),
    image_url: z.string().trim().max(200).regex(/^(\/(img|media)\/[A-Za-z0-9._-]+|https:\/\/images\.unsplash\.com\/photo-[A-Za-z0-9-]+(\?[A-Za-z0-9=&._%-]*)?)$/, 'Neplatný obrázek.').nullable().default(null),
    is_verified: z.boolean().default(false), source_note: z.string().trim().max(300).nullable().default(null), sort_order: z.number().int().default(0),
  });

  app.get('/api/admin/services', A, async () => {
    const [s, c] = await Promise.all([
      query(`SELECT * FROM services WHERE archived_at IS NULL ORDER BY sort_order, name`),
      query(`SELECT * FROM service_categories ORDER BY sort_order, name`),
    ]);
    return { services: s.rows, categories: c.rows };
  });
  app.post('/api/admin/services', A, async (ctx) => {
    const b = serviceBody.parse(await ctx.json());
    const r = (await query(
      `INSERT INTO services (name, description, duration_minutes, price_czk, price_from, category_id, is_active, is_verified, source_note, sort_order, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.name, b.description, b.duration_minutes, b.price_czk, b.price_from, b.category_id, b.is_active, b.is_verified, b.source_note, b.sort_order, b.image_url])).rows[0];
    await audit({ query }, ctx.user.id, 'service.create', 'service', r.id, { name: b.name });
    return { service: r };
  });
  app.patch('/api/admin/services/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const b = serviceBody.partial().parse(await ctx.json());
    const sets = []; const vals = [ctx.params.id];
    for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
    if (!sets.length) return { ok: true };
    const r = (await query(`UPDATE services SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING *`, vals)).rows[0];
    if (!r) throw notFound();
    await audit({ query }, ctx.user.id, 'service.update', 'service', r.id, b);
    return { service: r };
  });
  app.delete('/api/admin/services/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    // Služba se jen archivuje – historické rezervace si ponechají snímek názvu, ceny a délky.
    await query(`UPDATE services SET archived_at = now(), is_active = false, updated_at = now() WHERE id = $1`, [ctx.params.id]);
    await audit({ query }, ctx.user.id, 'service.archive', 'service', ctx.params.id);
    return { ok: true };
  });
  app.post('/api/admin/services/reorder', A, async (ctx) => {
    const b = z.object({ ids: z.array(uuid).max(500) }).parse(await ctx.json());
    await withTx(async (tx) => { for (let i = 0; i < b.ids.length; i += 1) await tx.query(`UPDATE services SET sort_order = $2 WHERE id = $1`, [b.ids[i], i]); });
    return { ok: true };
  });

  app.post('/api/admin/categories', A, async (ctx) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), sort_order: z.number().int().default(0) }).parse(await ctx.json());
    return { category: (await query(`INSERT INTO service_categories (name, sort_order) VALUES ($1, $2) RETURNING *`, [b.name, b.sort_order])).rows[0] };
  });
  app.patch('/api/admin/categories/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), sort_order: z.number().int().optional() }).parse(await ctx.json());
    const r = (await query(`UPDATE service_categories SET name = COALESCE($2, name), sort_order = COALESCE($3, sort_order) WHERE id = $1 RETURNING *`, [ctx.params.id, b.name ?? null, b.sort_order ?? null])).rows[0];
    if (!r) throw notFound();
    return { category: r };
  });
  app.delete('/api/admin/categories/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    await query(`DELETE FROM service_categories WHERE id = $1`, [ctx.params.id]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- galerie
  const sniff = (buf) => {
    if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    return null;
  };
  app.get('/api/admin/gallery', A, async () => ({ images: (await query(`SELECT id, alt, sort_order, is_hero, is_visible, is_logo, created_at, octet_length(data) AS bytes FROM gallery_images ORDER BY is_hero DESC, sort_order, created_at DESC`)).rows }));
  app.post('/api/admin/gallery', A, async (ctx) => {
    const buf = await ctx.buffer(6_000_000);
    const type = sniff(buf);
    if (!type) throw badRequest('Podporované formáty: JPEG, PNG, WebP.', 'bad_image');
    const alt = String(ctx.query.alt || '').slice(0, 200);
    const r = (await query(`INSERT INTO gallery_images (content_type, data, alt, is_visible, sort_order) VALUES ($1, $2, $3, $4, COALESCE((SELECT min(sort_order) - 1 FROM gallery_images), 0)) RETURNING id`, [type, buf, alt, ctx.query.hidden !== '1'])).rows[0];
    await audit({ query }, ctx.user.id, 'gallery.add', 'gallery_image', r.id);
    return { id: r.id };
  });
  app.patch('/api/admin/gallery/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const b = z.object({ alt: z.string().trim().max(200).optional(), is_hero: z.boolean().optional(), is_visible: z.boolean().optional(), is_logo: z.boolean().optional(), sort_order: z.number().int().optional() }).parse(await ctx.json());
    await withTx(async (tx) => {
      if (b.is_hero) await tx.query(`UPDATE gallery_images SET is_hero = false`);
      if (b.is_logo) await tx.query(`UPDATE gallery_images SET is_logo = false WHERE id <> $1`, [ctx.params.id]);
      if (b.is_logo === false) await tx.query(`UPDATE gallery_images SET is_logo = false WHERE id = $1`, [ctx.params.id]);
      await tx.query(`UPDATE gallery_images SET alt = COALESCE($2, alt), is_hero = COALESCE($3, is_hero), is_visible = COALESCE($4, is_visible), sort_order = COALESCE($5, sort_order),
         is_logo = COALESCE($6, is_logo) WHERE id = $1`,
        [ctx.params.id, b.alt ?? null, b.is_hero ?? null, b.is_visible ?? null, b.sort_order ?? null, b.is_logo ?? null]);
    });
    return { ok: true };
  });
  app.delete('/api/admin/gallery/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    await query(`DELETE FROM gallery_images WHERE id = $1`, [ctx.params.id]);
    await audit({ query }, ctx.user.id, 'gallery.delete', 'gallery_image', ctx.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- e-maily
  app.get('/api/admin/email/templates', A, async () => {
    const rows = (await query(`SELECT key, subject, body, enabled FROM email_templates`)).rows;
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    const settings = await getSettings();
    return {
      vars: TEMPLATE_VARS, reminder_hours_before: settings.reminder_hours_before, provider_configured: emailProviderConfigured(),
      templates: Object.entries(DEFAULT_TEMPLATES).map(([key, d]) => ({
        key, label: d.label, subject: byKey[key]?.subject ?? d.subject, body: byKey[key]?.body ?? d.body, enabled: byKey[key]?.enabled ?? true,
        customized: Boolean(byKey[key]), default_subject: d.subject, default_body: d.body,
      })),
    };
  });
  app.put('/api/admin/email/templates/:key', A, async (ctx) => {
    if (!DEFAULT_TEMPLATES[ctx.params.key]) throw notFound();
    const b = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000), enabled: z.boolean() }).parse(await ctx.json());
    await query(`INSERT INTO email_templates (key, subject, body, enabled) VALUES ($1,$2,$3,$4)
      ON CONFLICT (key) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, enabled = EXCLUDED.enabled, updated_at = now()`, [ctx.params.key, b.subject, b.body, b.enabled]);
    await audit({ query }, ctx.user.id, 'email_template.update', 'email_template', ctx.params.key);
    return { ok: true };
  });
  app.post('/api/admin/email/templates/:key/reset', A, async (ctx) => {
    await query(`DELETE FROM email_templates WHERE key = $1`, [ctx.params.key]);
    return { ok: true };
  });
  app.post('/api/admin/email/test', A, async (ctx) => {
    const b = z.object({ template_key: z.string().max(60) }).parse(await ctx.json());
    if (!DEFAULT_TEMPLATES[b.template_key]) throw notFound();
    const settings = await getSettings();
    const now = new Date();
    const vars = bookings.bookingVars({ client_name: 'Jana Nováková', service_name: 'Ukázková služba', starts_at: new Date(now.getTime() + 2 * 86400_000), price_czk: 500 }, settings,
      { manage_url: `${config.baseUrl}/rezervace/sprava?token=ukazka`, code: '123456', hold_minutes: settings.hold_minutes, verify_url: `${config.baseUrl}/ucet`, reset_url: `${config.baseUrl}/ucet`, details: 'Ukázkový text' });
    const r = await withTx((tx) => queueEmail(tx, { templateKey: b.template_key, to: ctx.user.email, vars, dedupeKey: `test:${b.template_key}:${Date.now()}` }));
    return { queued: !r.duplicate, to: ctx.user.email };
  });
  app.get('/api/admin/email/log', A, async (ctx) => {
    const status = ctx.query.status;
    const rows = (await query(
      `SELECT id, template_key, to_email, subject, status, attempts, last_error, booking_id, created_at, sent_at, (html IS NOT NULL) AS retryable
       FROM email_log ${status ? 'WHERE status = $1' : ''} ORDER BY created_at DESC LIMIT 200`, status ? [status] : [])).rows;
    return { emails: rows, provider_configured: emailProviderConfigured() };
  });
  app.post('/api/admin/email/log/:id/retry', A, async (ctx) => {
    const ok = await retryEmail({ query }, Number(ctx.params.id));
    if (!ok) throw conflict('Tuto zprávu nelze znovu odeslat.');
    return { ok: true };
  });

  // ---------------------------------------------------------------- audit
  app.get('/api/admin/audit', A, async () => ({
    entries: (await query(`SELECT a.id, a.at, a.action, a.entity, a.entity_id, a.details, u.email AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.at DESC, a.id DESC LIMIT 300`)).rows,
  }));

  // ---------------------------------------------------------------- klientky
  app.get('/api/admin/clients', A, async () => ({
    clients: (await query(
      `SELECT lower(client_email) AS email, max(client_name) AS name, max(client_phone) AS phone, count(*)::int AS bookings, max(starts_at) AS last_visit
       FROM bookings WHERE client_email <> '' AND status IN ('confirmed', 'completed', 'no_show') GROUP BY lower(client_email) ORDER BY max(starts_at) DESC LIMIT 500`)).rows,
  }));
}
