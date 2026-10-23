import { z } from 'zod';
import { query } from '../db.js';
import { rateLimit } from '../lib/http.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { addDaysStr, localDateStr, parseDateStr } from '../lib/time.js';
import { getSettings } from '../services/settings.js';
import { getContent } from '../services/content.js';
import { computeAvailability } from '../services/availability.js';
import * as bookings from '../services/bookings.js';
import { calendarHealth } from '../calendar/health.js';
import { enqueue } from '../services/jobs.js';
import { getPosts, instagramConfigured } from '../services/instagram.js';
import { optionalUser, requireUser } from './middleware.js';
import { bookingBody, uuid, isoDate } from './schemas.js';

const availLimit = rateLimit({ name: 'avail', windowMs: 60_000, max: 90 });
const createLimit = rateLimit({ name: 'book', windowMs: 3600_000, max: 12 });
const verifyLimit = rateLimit({ name: 'verify', windowMs: 15 * 60_000, max: 30 });
const resendLimit = rateLimit({ name: 'resend', windowMs: 3600_000, max: 10 });
const manageLimit = rateLimit({ name: 'manage', windowMs: 15 * 60_000, max: 60 });

const WD_LABEL = ['', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];

async function loadServices() {
  const rows = (await query(
    `SELECT s.id, s.name, s.description, s.duration_minutes, s.price_czk, s.price_from, s.category_id,
            c.name AS category_name, c.sort_order AS cat_order
     FROM services s LEFT JOIN service_categories c ON c.id = s.category_id
     WHERE s.is_active AND s.archived_at IS NULL
     ORDER BY COALESCE(c.sort_order, 9999), c.name NULLS LAST, s.sort_order, s.name`)).rows;
  const cats = [];
  for (const r of rows) {
    const key = r.category_id || 'none';
    let c = cats.find((x) => x.id === key);
    if (!c) { c = { id: key, name: r.category_name || 'Služby', services: [] }; cats.push(c); }
    c.services.push({ id: r.id, name: r.name, description: r.description, duration_minutes: r.duration_minutes, price_czk: r.price_czk, price_from: r.price_from });
  }
  return cats;
}

export function mount(app) {
  app.get('/api/public/bootstrap', async () => {
    const [settings, content, categories, hours, gallery, ig] = await Promise.all([
      getSettings(), getContent(), loadServices(),
      query(`SELECT weekday, start_time::text AS s, end_time::text AS e FROM working_hours ORDER BY weekday, start_time`),
      query(`SELECT id, alt, is_hero FROM gallery_images WHERE is_visible ORDER BY is_hero DESC, sort_order, created_at DESC`),
      instagramConfigured(),
    ]);
    const hoursByDay = [];
    for (const r of hours.rows) {
      let d = hoursByDay.find((x) => x.weekday === Number(r.weekday));
      if (!d) { d = { weekday: Number(r.weekday), label: WD_LABEL[Number(r.weekday)], ranges: [] }; hoursByDay.push(d); }
      d.ranges.push({ from: r.s.slice(0, 5), to: r.e.slice(0, 5) });
    }
    return {
      content,
      categories,
      hours: hoursByDay,
      gallery: gallery.rows,
      instagram: { configured: ig },
      booking: {
        enabled: settings.online_booking_enabled, cancel_hours_before: settings.cancel_hours_before,
        hold_minutes: settings.hold_minutes, max_advance_days: settings.max_advance_days, timezone: settings.timezone,
      },
    };
  });

  app.get('/api/public/instagram', async () => ({ posts: await getPosts() }));

  app.get('/api/public/availability', availLimit, async (ctx) => {
    const q = z.object({ service_id: uuid, from: isoDate.optional(), to: isoDate.optional() }).parse(ctx.query);
    const settings = await getSettings();
    if (!settings.online_booking_enabled) return { disabled: true, days: [] };
    const svc = (await query(`SELECT duration_minutes FROM services WHERE id = $1 AND is_active AND archived_at IS NULL`, [q.service_id])).rows[0];
    if (!svc) throw notFound('Služba nenalezena.');
    const now = new Date();
    const today = localDateStr(now, settings.timezone);
    const from = q.from && parseDateStr(q.from) ? q.from : today;
    let to = q.to && parseDateStr(q.to) ? q.to : addDaysStr(from, 13);
    if (to > addDaysStr(from, 62)) to = addDaysStr(from, 62);

    // Pokud nelze spolehlivě znát obsazenost (výpadek synchronizace kalendáře), neslibujeme žádné termíny.
    const health = await calendarHealth({ query }, settings, now);
    if (health.degraded && settings.fail_closed) {
      for (const s of health.stale) await enqueue({ query }, 'calendar_sync_source', { sourceId: s.id }, { dedupeKey: `syncnow:${s.id}:${Math.floor(now.getTime() / 30000)}`, maxAttempts: 1 });
      return { degraded: true, days: [], message: 'Online rezervace je dočasně nedostupná. Prosím zavolejte do studia nebo to zkuste za chvíli.' };
    }
    const { days } = await computeAvailability({ query }, { durationMinutes: svc.duration_minutes, fromDate: from, toDate: to, now, settings });
    return { days, timezone: settings.timezone };
  });

  // ---- vytvoření a dokončení rezervace -------------------------------------------------
  app.post('/api/bookings', createLimit, optionalUser, async (ctx) => {
    const b = bookingBody.parse(await ctx.json());
    return bookings.createOnlineBooking({
      serviceId: b.service_id, startsAt: b.starts_at, name: b.name, email: b.email, phone: b.phone, note: b.note, user: ctx.user,
    });
  });

  app.post('/api/bookings/:id/verify', verifyLimit, async (ctx) => {
    const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Kód má 6 číslic.') }).parse(await ctx.json());
    if (!z.string().uuid().safeParse(ctx.params.id).success) throw notFound('Rezervace nenalezena.');
    return bookings.verifyBooking(ctx.params.id, code);
  });

  app.post('/api/bookings/:id/resend', resendLimit, async (ctx) => {
    if (!z.string().uuid().safeParse(ctx.params.id).success) throw notFound('Rezervace nenalezena.');
    return bookings.resendVerification(ctx.params.id);
  });

  // ---- správa rezervace přes tajný odkaz z e-mailu (bez účtu) ---------------------------
  const tokenBody = z.object({ token: z.string().min(10).max(200) });
  const byToken = async (token) => {
    const b = await bookings.bookingByManageToken(token);
    if (!b) throw notFound('Rezervace nenalezena. Odkaz je neplatný.');
    return b;
  };

  app.post('/api/bookings/manage/view', manageLimit, async (ctx) => {
    const { token } = tokenBody.parse(await ctx.json());
    const b = await byToken(token);
    return { booking: bookings.publicBooking(b, await getSettings()), contact: await contactInfo() };
  });

  app.post('/api/bookings/manage/cancel', manageLimit, async (ctx) => {
    const { token } = tokenBody.parse(await ctx.json());
    const b = await byToken(token);
    return bookings.cancelBooking(b.id, { actor: 'client', reason: 'Zrušeno klientkou', enforcePolicy: true });
  });

  app.post('/api/bookings/manage/reschedule-request', manageLimit, async (ctx) => {
    const body = tokenBody.extend({ message: z.string().trim().min(3).max(1000) }).parse(await ctx.json());
    const b = await byToken(body.token);
    return bookings.requestReschedule(b.id, body.message, { ownerCheck: (x) => x.id === b.id });
  });

  // ---- přihlášená klientka ---------------------------------------------------------------
  app.get('/api/me/bookings', requireUser, async (ctx) => {
    const settings = await getSettings();
    const rows = (await query(`SELECT * FROM bookings WHERE user_id = $1 AND status IN ('held', 'confirmed', 'cancelled', 'completed', 'no_show') ORDER BY starts_at DESC LIMIT 200`, [ctx.user.id])).rows;
    const now = new Date();
    const list = rows.map((b) => bookings.publicBooking(b, settings, { now }));
    return {
      upcoming: list.filter((b) => b.status === 'confirmed' && new Date(b.ends_at) > now).reverse(),
      past: list.filter((b) => !(b.status === 'confirmed' && new Date(b.ends_at) > now) && b.status !== 'held'),
      contact: await contactInfo(),
    };
  });

  app.post('/api/me/bookings/:id/cancel', requireUser, async (ctx) => {
    if (!z.string().uuid().safeParse(ctx.params.id).success) throw notFound('Rezervace nenalezena.');
    return bookings.cancelBooking(ctx.params.id, {
      actor: 'client', userId: ctx.user.id, reason: 'Zrušeno klientkou', enforcePolicy: true, ownerCheck: (b) => b.user_id === ctx.user.id,
    });
  });

  app.post('/api/me/bookings/:id/reschedule-request', requireUser, async (ctx) => {
    if (!z.string().uuid().safeParse(ctx.params.id).success) throw notFound('Rezervace nenalezena.');
    const { message } = z.object({ message: z.string().trim().min(3).max(1000) }).parse(await ctx.json());
    return bookings.requestReschedule(ctx.params.id, message, { ownerCheck: (b) => b.user_id === ctx.user.id });
  });

  // ---- fotografie z galerie -----------------------------------------------------------------
  app.get('/media/:id', async (ctx) => {
    if (!z.string().uuid().safeParse(ctx.params.id).success) throw notFound();
    const r = (await query(`SELECT content_type, data FROM gallery_images WHERE id = $1`, [ctx.params.id])).rows[0];
    if (!r) throw notFound();
    ctx.send(200, ctx.req.method === 'HEAD' ? '' : r.data, {
      'Content-Type': r.content_type, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': r.data.length,
    });
  });
}

async function contactInfo() {
  const c = await getContent();
  return { name: c.contact_name, phone: c.contact_phone, address: c.contact_address };
}
