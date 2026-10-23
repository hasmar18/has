// Společné pomocné funkce pro testy. Testy běží proti skutečné PostgreSQL (TEST_DATABASE_URL / DATABASE_URL).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://hasnails:hasnails@localhost:5432/hasnails_test';
process.env.BASE_URL = 'http://localhost:3999';
process.env.RUN_WORKER = 'false';
process.env.DISABLE_RATE_LIMIT = '1';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const { query, migrate, closePool, getPool } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { seedDefaults } = await import('../src/services/seed.js');
const { setTransport } = await import('../src/services/email.js');
const { registerHandlers } = await import('../src/worker.js');
const { runDueJobs } = await import('../src/services/jobs.js');
const { registerProvider } = await import('../src/calendar/providers.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { upsertAdmin } = await import('../src/services/auth.js');
const { invalidateSettings, updateSettings } = await import('../src/services/settings.js');
const time = await import('../src/lib/time.js');

export { query, closePool, time, updateSettings, registerProvider };

export async function resetDb() {
  await query('DROP SCHEMA public CASCADE');
  await query('CREATE SCHEMA public');
  await migrate();
  await seedDefaults();
  invalidateSettings();
  registerHandlers();
}

export const sentEmails = [];
export function captureEmail({ failWith = null } = {}) {
  sentEmails.length = 0;
  let n = 0;
  setTransport(async (m) => {
    if (typeof failWith === 'function') { const e = failWith(m); if (e) throw e; }
    sentEmails.push(m);
    n += 1;
    return { messageId: `<test-${n}@local>` };
  });
}
export const setFailingTransport = (fn) => setTransport(fn);

export async function drainJobs(max = 20) {
  let total = 0;
  for (let i = 0; i < max; i += 1) {
    const n = await runDueJobs(50);
    total += n;
    if (!n) break;
  }
  return total;
}

export async function startServer() {
  const app = createApp();
  const server = await app.listen(0);
  const url = `http://localhost:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

export class Client {
  constructor(baseUrl) { this.baseUrl = baseUrl; this.cookies = {}; this.csrf = null; }

  async req(method, path, body, { headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (Object.keys(this.cookies).length) h.cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.csrf && !h['x-csrf-token']) h['x-csrf-token'] = this.csrf;
    let payload;
    if (raw) payload = body; else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(this.baseUrl + path, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i); const v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* není JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b, o) { return this.req('POST', p, b ?? {}, o); }
  put(p, b, o) { return this.req('PUT', p, b, o); }
  patch(p, b, o) { return this.req('PATCH', p, b, o); }
  del(p, b, o) { return this.req('DELETE', p, b, o); }

  async login(email, password) {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.status === 200) this.csrf = r.body.csrf_token;
    return r;
  }
}

export const ADMIN = { email: 'admin@hasnails.test', password: 'Velmi-silne-heslo-1' };

export async function createAdmin() {
  await upsertAdmin(ADMIN.email, ADMIN.password, { mustChangePassword: false });
}

/** Pracovní doba po–pá 9:00–17:00, jedna služba 60 min, zapnuté rezervace. */
export async function seedBasics({ buffer = 0, interval = 30, hours = [[9, 17]] } = {}) {
  await query('DELETE FROM working_hours');
  for (let d = 1; d <= 5; d += 1) for (const [a, b] of hours) {
    await query(`INSERT INTO working_hours (weekday, start_time, end_time) VALUES ($1, $2, $3)`, [d, `${String(a).padStart(2, '0')}:00`, `${String(b).padStart(2, '0')}:00`]);
  }
  const svc = (await query(`INSERT INTO services (name, description, duration_minutes, price_czk, is_verified) VALUES ('Testovací služba', 'popis', 60, 500, true) RETURNING *`)).rows[0];
  const svc30 = (await query(`INSERT INTO services (name, description, duration_minutes, price_czk) VALUES ('Krátká služba', '', 30, 250) RETURNING *`)).rows[0];
  await updateSettings({ query }, { online_booking_enabled: true, require_email_verification: true, buffer_minutes: buffer, slot_interval_minutes: interval, min_notice_hours: 1, max_advance_days: 120, cancel_hours_before: 24, hold_minutes: 15 });
  return { svc, svc30 };
}

/** Datum (YYYY-MM-DD) nejbližšího dne daného ISO dne v týdnu, který je alespoň `minDays` dnů v budoucnu. */
export function futureDate(isoWeekday, minDays = 3) {
  const tz = 'Europe/Prague';
  let d = time.addDaysStr(time.localDateStr(new Date(), tz), minDays);
  while (time.isoWeekdayOfDateStr(d) !== isoWeekday) d = time.addDaysStr(d, 1);
  return d;
}

export const slotISO = (date, hhmm) => time.localToUtc(date, hhmm, 'Europe/Prague').toISOString();

export function lastEmail(to, templateKey) {
  const list = sentEmails.filter((m) => (!to || m.to === to) && (!templateKey || m.subject));
  return list[list.length - 1];
}
export const codeFromEmail = (mail) => /\b(\d{6})\b/.exec(mail.text)?.[1];
export const urlFromEmail = (mail, re) => new RegExp(`https?://[^\\s"<]*${re}[^\\s"<]*`).exec(mail.text)?.[0];

// ---- Falešný poskytovatel kalendáře (v paměti) -----------------------------------------
export class FakeCalendar {
  constructor() { this.calendars = new Map(); this.failures = 0; this.authFail = false; this.seq = 0; this.calls = []; }
  addCalendar(id, name = id, primary = false) { this.calendars.set(id, { id, name, primary, events: new Map() }); return this.calendars.get(id); }
  addEvent(calId, { start, end, allDay = false, transparent = false, cancelled = false }) {
    this.seq += 1; const id = `ev${this.seq}`;
    this.calendars.get(calId).events.set(id, { id, start: new Date(start), end: new Date(end), allDay, transparent, cancelled, ours: false });
    return id;
  }
  moveEvent(calId, id, start, end) { Object.assign(this.calendars.get(calId).events.get(id), { start: new Date(start), end: new Date(end) }); }
  removeEvent(calId, id) { this.calendars.get(calId).events.delete(id); }
  ours(calId) { return [...this.calendars.get(calId).events.values()].filter((e) => e.ours); }
}

export function makeFakeProvider(fake) {
  const guard = async () => {
    if (fake.authFail) { const { ProviderAuthError } = await import('../src/calendar/providers.js'); throw new ProviderAuthError('fake: autorizace zrušena'); }
    if (fake.failures > 0) { fake.failures -= 1; throw new Error('fake: výpadek poskytovatele'); }
  };
  return {
    name: 'fake', label: 'Test', hidden: true, isConfigured: () => true,
    async refreshAccessToken() { await guard(); return { accessToken: 'tok', expiresIn: 3600 }; },
    async listCalendars() { await guard(); return [...fake.calendars.values()].map((c) => ({ id: c.id, name: c.name, primary: c.primary, canWrite: true })); },
    async getAccountEmail() { return 'fake@account'; },
    async listEvents(_t, { calendarId }) {
      await guard(); fake.calls.push('list');
      return [...fake.calendars.get(calendarId).events.values()].map((e) => ({ ...e, etag: String(e.start.getTime()) }));
    },
    async upsertEvent(_t, { calendarId, bookingId, existingEventId, summary, description, start, end }) {
      await guard(); fake.calls.push('upsert');
      const cal = fake.calendars.get(calendarId);
      const id = existingEventId && cal.events.has(existingEventId) ? existingEventId : `hn${bookingId.replace(/-/g, '')}`;
      cal.events.set(id, { id, start, end, allDay: false, transparent: false, cancelled: false, ours: true, summary, description });
      return { eventId: id, etag: 'e' };
    },
    async deleteEvent(_t, { calendarId, eventId }) { await guard(); fake.calls.push('delete'); fake.calendars.get(calendarId).events.delete(eventId); },
  };
}

export async function connectFake(fake, { blockingCalendars = ['primary'], writeCalendar = 'primary' } = {}) {
  registerProvider(makeFakeProvider(fake));
  const conn = (await query(
    `INSERT INTO calendar_connections (provider, account_email, refresh_token_enc, status, last_success_at, write_enabled, write_calendar_id, write_calendar_name)
     VALUES ('fake', 'fake@account', $1, 'active', now(), $2, $3, $3) RETURNING *`,
    [encrypt('refresh'), Boolean(writeCalendar), writeCalendar])).rows[0];
  const sources = {};
  for (const [id, c] of fake.calendars) {
    const r = await query(`INSERT INTO calendar_sources (connection_id, external_calendar_id, name, blocks_availability) VALUES ($1, $2, $3, $4) RETURNING *`,
      [conn.id, id, c.name, blockingCalendars.includes(id)]);
    sources[id] = r.rows[0];
  }
  return { conn, sources };
}
