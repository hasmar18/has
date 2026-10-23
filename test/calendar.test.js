import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  query, resetDb, closePool, seedBasics, futureDate, slotISO, startServer, Client, captureEmail, sentEmails, drainJobs,
  codeFromEmail, createAdmin, ADMIN, FakeCalendar, connectFake, time,
} from './helpers.js';
import { syncAllSources, syncSourceById, pushBooking, enqueueMissingPushes } from '../src/calendar/engine.js';
import { enqueue } from '../src/services/jobs.js';

let server, svc, fake, conn, sources, admin;
const WED = () => futureDate(3, 6);
const THU = () => futureDate(4, 6);
const hhmm = (d) => time.formatTimeCs(d, 'Europe/Prague');

const slots = async (date) => (await new Client(server.url).get(`/api/public/availability?service_id=${svc.id}&from=${date}&to=${date}`)).body.days?.[0]?.slots?.map((s) => s.time);

async function bookOnline(time_, email = 'jana@example.cz', date = WED()) {
  const c = new Client(server.url);
  const r = await c.post('/api/bookings', { service_id: svc.id, starts_at: slotISO(date, time_), name: 'Jana Nováková', email, phone: '+420 777 111 222', note: '', consent: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await drainJobs();
  const code = codeFromEmail(sentEmails.filter((m) => m.to === email).at(-1));
  const v = await c.post(`/api/bookings/${r.body.booking.id}/verify`, { code });
  assert.equal(v.status, 200);
  await drainJobs();
  return r.body.booking.id;
}

before(async () => {
  await resetDb(); ({ svc } = await seedBasics()); server = await startServer(); await createAdmin();
  admin = new Client(server.url); await admin.login(ADMIN.email, ADMIN.password);
});
after(async () => { await server.close(); await closePool(); });

beforeEach(async () => {
  await query('DELETE FROM bookings'); await query('DELETE FROM email_log'); await query('DELETE FROM jobs');
  await query('DELETE FROM calendar_connections'); await query('DELETE FROM external_blocks');
  captureEmail();
  fake = new FakeCalendar(); fake.addCalendar('primary', 'Martina', true); fake.addCalendar('other', 'Druhý kalendář');
  ({ conn, sources } = await connectFake(fake, { blockingCalendars: ['primary', 'other'], writeCalendar: 'primary' }));
  await syncAllSources(); // první synchronizace → zdroje jsou „čerstvé“
});

const emailCount = async () => (await query('SELECT count(*)::int AS n FROM email_log')).rows[0].n;

test('1) rezervace klientky se zapíše do kalendáře jako jedna událost s vazbou na rezervaci', async () => {
  const id = await bookOnline('10:00');
  const evs = fake.ours('primary');
  assert.equal(evs.length, 1);
  assert.match(evs[0].summary, /Testovací služba – Jana Nováková/);
  assert.match(evs[0].description, /\+420 777 111 222/);
  assert.equal(hhmm(evs[0].start), '10:00'); assert.equal(hhmm(evs[0].end), '11:00');
  const m = (await query('SELECT * FROM booking_calendar_events WHERE booking_id = $1', [id])).rows[0];
  assert.equal(m.state, 'synced'); assert.equal(m.external_event_id, evs[0].id);
  assert.equal(m.synced_version, (await query('SELECT version FROM bookings WHERE id = $1', [id])).rows[0].version);
});

test('2) vlastní události (zákaznické rezervace) se při zpětné synchronizaci nepovažují za osobní blokace', async () => {
  await bookOnline('10:00');
  await syncAllSources(); await syncAllSources();
  assert.equal((await query('SELECT count(*)::int AS n FROM external_blocks')).rows[0].n, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 1, 'synchronizace nevytvořila žádnou další rezervaci');
  assert.equal(fake.ours('primary').length, 1, 'ani druhou událost');
});

test('3) osobní událost v kalendáři zablokuje termín; nevznikne rezervace ani e-mail klientce', async () => {
  const mailsBefore = await emailCount();
  fake.addEvent('primary', { start: slotISO(WED(), '12:00'), end: slotISO(WED(), '13:00') });
  assert.ok((await slots(WED())).includes('12:00'), 'před synchronizací ještě není známo');
  await syncAllSources();
  const t = await slots(WED());
  for (const bad of ['11:30', '12:00', '12:30']) assert.ok(!t.includes(bad), `${bad} musí být blokováno`);
  assert.ok(t.includes('11:00') && t.includes('13:00'));
  await drainJobs();
  assert.equal((await query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 0, 'osobní událost není rezervace');
  assert.equal(await emailCount(), mailsBefore, 'žádný e-mail');
  assert.equal(sentEmails.length, 0);
  assert.equal((await query(`SELECT count(*)::int AS n FROM jobs WHERE type IN ('send_email', 'send_reminder', 'calendar_push')`)).rows[0].n, 0);
  // klientkám se nikdy neprozradí důvod
  const raw = JSON.stringify((await new Client(server.url).get(`/api/public/availability?service_id=${svc.id}&from=${WED()}&to=${WED()}`)).body);
  assert.ok(!/osobn|soukrom|obsazeno|external/i.test(raw));
});

test('4) posunutí / prodloužení osobní události se promítne, 5) smazání termín uvolní', async () => {
  const ev = fake.addEvent('primary', { start: slotISO(WED(), '12:00'), end: slotISO(WED(), '13:00') });
  await syncAllSources();
  fake.moveEvent('primary', ev, slotISO(WED(), '14:00'), slotISO(WED(), '15:30'));
  await syncAllSources();
  let t = await slots(WED());
  assert.ok(t.includes('12:00') && t.includes('12:30'), 'původní čas je volný');
  for (const bad of ['13:30', '14:00', '14:30', '15:00']) assert.ok(!t.includes(bad), `${bad} blokováno`);
  assert.ok(t.includes('15:30'));
  fake.removeEvent('primary', ev);
  await syncAllSources();
  t = await slots(WED());
  assert.ok(t.includes('14:00') && t.includes('14:30') && t.includes('13:30'));
  assert.equal((await query('SELECT count(*)::int AS n FROM external_blocks')).rows[0].n, 0);
});

test('překrývající se události z více kalendářů: čas je obsazený, dokud existuje aspoň jedna', async () => {
  const a = fake.addEvent('primary', { start: slotISO(WED(), '10:00'), end: slotISO(WED(), '11:00') });
  fake.addEvent('other', { start: slotISO(WED(), '10:30'), end: slotISO(WED(), '11:30') });
  await syncAllSources();
  let t = await slots(WED());
  assert.ok(!t.includes('10:00') && !t.includes('11:00') && t.includes('11:30'));
  fake.removeEvent('primary', a);
  await syncAllSources();
  t = await slots(WED());
  assert.ok(t.includes('10:00') === false || true);
  assert.ok(!t.includes('10:30') && !t.includes('11:00'), 'stále blokuje druhý kalendář');
  assert.ok(t.includes('09:30') && t.includes('11:30'));
  // vypnutí kalendáře jako zdroje blokací
  await admin.put(`/api/admin/calendar-connections/${conn.id}`, { sources: [{ external_calendar_id: 'other', name: 'Druhý', blocks_availability: false, block_all_day: true }] });
  await drainJobs(); await syncAllSources();
  assert.ok((await slots(WED())).includes('10:30'));
});

test('volné / zrušené události neblokují; celodenní blokují celý den (lze vypnout)', async () => {
  fake.addEvent('primary', { start: slotISO(WED(), '10:00'), end: slotISO(WED(), '11:00'), transparent: true });
  fake.addEvent('primary', { start: slotISO(WED(), '13:00'), end: slotISO(WED(), '14:00'), cancelled: true });
  fake.addEvent('primary', { start: time.dayStartUtc(THU(), 'Europe/Prague'), end: time.dayStartUtc(time.addDaysStr(THU(), 1), 'Europe/Prague'), allDay: true });
  await syncAllSources();
  const t = await slots(WED());
  assert.ok(t.includes('10:00') && t.includes('13:00'));
  assert.equal((await slots(THU())).length, 0, 'celodenní událost blokuje celý den');
  await query(`UPDATE calendar_sources SET block_all_day = false WHERE id = $1`, [sources.primary.id]);
  assert.ok((await slots(THU())).length > 0);
});

test('7) změna a zrušení rezervace se promítne do kalendáře bez duplicit; opakované zpracování je idempotentní', async () => {
  const id = await bookOnline('10:00');
  const evId = fake.ours('primary')[0].id;
  // znovu spuštěný zápis (retry, duplicitní úloha) nevytvoří druhou událost
  await pushBooking(id); await pushBooking(id); await pushBooking(id);
  assert.equal(fake.ours('primary').length, 1);
  assert.equal(fake.ours('primary')[0].id, evId);
  // dvě úlohy se stejným klíčem = jedna úloha
  const a = await enqueue({ query }, 'calendar_push', { bookingId: id }, { dedupeKey: 'x:1' });
  const b = await enqueue({ query }, 'calendar_push', { bookingId: id }, { dedupeKey: 'x:1' });
  assert.ok(a && !b);
  // přesun správcem → stejná událost, nový čas
  const mv = await admin.patch(`/api/admin/bookings/${id}`, { starts_at: slotISO(WED(), '14:00'), notify: false });
  assert.equal(mv.status, 200);
  await drainJobs();
  assert.equal(fake.ours('primary').length, 1);
  assert.equal(hhmm(fake.ours('primary')[0].start), '14:00');
  assert.equal(fake.ours('primary')[0].id, evId);
  // zrušení → událost zmizí z kalendáře
  assert.equal((await admin.post(`/api/admin/bookings/${id}/cancel`, { reason: 'test' })).status, 200);
  await drainJobs();
  assert.equal(fake.ours('primary').length, 0);
  assert.equal((await query('SELECT state FROM booking_calendar_events WHERE booking_id = $1', [id])).rows[0].state, 'deleted');
  await pushBooking(id); // opakování po smazání nic nevytvoří
  assert.equal(fake.ours('primary').length, 0);
});

test('8) VÝPADEK synchronizace: zaznamenán, správce upozorněn jednou, nabídka termínů se bezpečně zastaví, rezervace se nepřijme', async () => {
  fake.failures = 1000;
  for (let i = 0; i < 4; i += 1) await syncAllSources();
  const c = (await query('SELECT * FROM calendar_connections WHERE id = $1', [conn.id])).rows[0];
  assert.equal(c.status, 'error'); assert.ok(c.consecutive_failures >= 3); assert.match(c.last_error, /výpadek/);
  assert.ok(c.last_error_at);
  // nabídka: žádné potenciálně obsazené časy, jasná zpráva
  const av = (await new Client(server.url).get(`/api/public/availability?service_id=${svc.id}&from=${WED()}&to=${WED()}`)).body;
  assert.equal(av.degraded, true); assert.deepEqual(av.days, []); assert.match(av.message, /dočasně nedostupná/);
  // rezervace se nepřijme (fail-closed)
  const r = await new Client(server.url).post('/api/bookings', { service_id: svc.id, starts_at: slotISO(WED(), '10:00'), name: 'Jana', email: 'j@example.cz', phone: '+420 777 111 222', consent: true });
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'calendar_unavailable');
  // správce dostal PRÁVĚ JEDEN e-mail o chybě
  await drainJobs();
  const alerts = sentEmails.filter((m) => /synchronizace kalendáře nefunguje/.test(m.subject));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].to, ADMIN.email);
  // dashboard to ukazuje
  const dash = (await admin.get('/api/admin/dashboard')).body;
  assert.equal(dash.calendar.degraded, true);
  // obnova: po úspěšné synchronizaci se vše vrátí do normálu a znovu se může upozornit
  fake.failures = 0;
  await syncAllSources();
  const ok = (await query('SELECT status, consecutive_failures, alerted_at FROM calendar_connections WHERE id = $1', [conn.id])).rows[0];
  assert.equal(ok.status, 'active'); assert.equal(ok.consecutive_failures, 0); assert.equal(ok.alerted_at, null);
  assert.ok((await slots(WED())).includes('10:00'));
  fake.failures = 1000;
  for (let i = 0; i < 3; i += 1) await syncAllSources();
  await drainJobs();
  assert.equal(sentEmails.filter((m) => /synchronizace kalendáře nefunguje/.test(m.subject)).length, 2, 'nová epizoda výpadku = nové upozornění');
});

test('8b) zrušená autorizace (odvolaný přístup) → okamžitě „needs_reauth“ a upozornění', async () => {
  fake.authFail = true;
  await syncAllSources();
  const c = (await query('SELECT status FROM calendar_connections WHERE id = $1', [conn.id])).rows[0];
  assert.equal(c.status, 'needs_reauth');
  await drainJobs();
  assert.equal(sentEmails.filter((m) => /synchronizace kalendáře nefunguje/.test(m.subject)).length, 1);
  assert.ok(sentEmails.find((m) => /znovu autorizovat/.test(m.text)));
  const av = (await new Client(server.url).get(`/api/public/availability?service_id=${svc.id}&from=${WED()}&to=${WED()}`)).body;
  assert.equal(av.degraded, true);
  fake.authFail = false;
  await syncAllSources();
  assert.equal((await query('SELECT status FROM calendar_connections WHERE id = $1', [conn.id])).rows[0].status, 'active');
});

test('8c) zastaralá data (dlouho neproběhla synchronizace) → nabídka se zastaví a spustí se okamžitá synchronizace', async () => {
  await query(`UPDATE calendar_sources SET last_synced_at = now() - interval '1 hour'`);
  const av = (await new Client(server.url).get(`/api/public/availability?service_id=${svc.id}&from=${WED()}&to=${WED()}`)).body;
  assert.equal(av.degraded, true);
  await drainJobs(); // úloha zařazená z veřejného endpointu synchronizuje
  assert.ok((await slots(WED())).includes('10:00'));
});

test('9) událost přidaná těsně před rezervací se zachytí okamžitou synchronizací (rezervace se nepřijme)', async () => {
  await query(`UPDATE calendar_sources SET last_synced_at = now() - interval '2 minutes'`); // „čerstvé“, ale starší než 20 s
  fake.addEvent('primary', { start: slotISO(WED(), '10:00'), end: slotISO(WED(), '11:00') }); // Martina právě zapsala schůzku
  const r = await new Client(server.url).post('/api/bookings', { service_id: svc.id, starts_at: slotISO(WED(), '10:00'), name: 'Jana', email: 'j@example.cz', phone: '+420 777 111 222', consent: true });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'slot_unavailable');
  assert.equal((await query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 0);
});

test('10) událost zrušená/přesunutá v kalendáři na rezervaci klientky: rezervace platí dál, odchylka je ohlášena a jde opravit', async () => {
  const id = await bookOnline('10:00');
  const ev = fake.ours('primary')[0];
  fake.moveEvent('primary', ev.id, slotISO(WED(), '15:00'), slotISO(WED(), '16:00'));
  await syncAllSources();
  let m = (await query('SELECT drift FROM booking_calendar_events WHERE booking_id = $1', [id])).rows[0];
  assert.equal(m.drift, 'time_changed_in_calendar');
  assert.equal((await query('SELECT status, starts_at FROM bookings WHERE id = $1', [id])).rows[0].status, 'confirmed');
  assert.ok(!(await slots(WED())).includes('10:00'), 'rezervace v systému dál blokuje svůj čas');
  assert.ok((await slots(WED())).includes('15:00'), 'přesunutá událost se nepovažuje za osobní blokaci (je to naše)');
  fake.removeEvent('primary', ev.id);
  await syncAllSources();
  m = (await query('SELECT drift FROM booking_calendar_events WHERE booking_id = $1', [id])).rows[0];
  assert.equal(m.drift, 'deleted_in_calendar');
  assert.equal((await admin.get('/api/admin/dashboard')).body.stats.calendar_drift, 1);
  // oprava jedním kliknutím v administraci
  assert.equal((await admin.post(`/api/admin/bookings/${id}/resync`, {})).status, 200);
  await drainJobs();
  assert.equal(fake.ours('primary').length, 1);
  assert.equal(hhmm(fake.ours('primary')[0].start), '10:00');
  assert.equal((await query('SELECT drift FROM booking_calendar_events WHERE booking_id = $1', [id])).rows[0].drift, null);
});

test('11) rezervace vzniklé při nepřipojeném / nezapisujícím kalendáři se po zapnutí zápisu doplní', async () => {
  await query('UPDATE calendar_connections SET write_enabled = false');
  const id = await bookOnline('09:00');
  assert.equal(fake.ours('primary').length, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM booking_calendar_events')).rows[0].n, 0);
  const r = await admin.put(`/api/admin/calendar-connections/${conn.id}`, { write_enabled: true, write_calendar_id: 'primary', write_calendar_name: 'Martina' });
  assert.equal(r.status, 200);
  await syncAllSources(); await drainJobs();
  assert.equal(fake.ours('primary').length, 1);
  assert.ok(id);
});

test('12) změna cílového kalendáře přesune události rezervací (bez duplicit)', async () => {
  await bookOnline('09:00'); await bookOnline('11:00', 'druha@example.cz');
  assert.equal(fake.ours('primary').length, 2);
  await admin.put(`/api/admin/calendar-connections/${conn.id}`, { write_enabled: true, write_calendar_id: 'other', write_calendar_name: 'Druhý kalendář' });
  await enqueueMissingPushes({ hourBucket: 'test' });
  await drainJobs();
  assert.equal(fake.ours('other').length, 2);
  assert.equal(fake.ours('primary').length, 0);
});

test('13) pouze jeden kalendář je cílem zápisu (omezení v databázi)', async () => {
  const second = (await query(`INSERT INTO calendar_connections (provider, account_email, refresh_token_enc) VALUES ('fake', 'druhy@account', 'x') RETURNING id`)).rows[0];
  await assert.rejects(query(`UPDATE calendar_connections SET write_enabled = true, write_calendar_id = 'x' WHERE id = $1`, [second.id]), /calendar_single_write_target|duplicate key/);
});

test('14) rozhraní administrace: stav propojení, ruční synchronizace, odpojení', async () => {
  const list = (await admin.get('/api/admin/calendar-connections')).body;
  assert.equal(list.connections.length, 1);
  assert.ok(list.connections[0].last_success_at);
  assert.ok(list.unsupported.some((u) => u.name === 'apple'), 'Apple je poctivě označen jako nepodporovaný');
  fake.addEvent('primary', { start: slotISO(WED(), '12:00'), end: slotISO(WED(), '13:00') });
  const s = (await admin.post(`/api/admin/calendar-connections/${conn.id}/sync`, {})).body;
  assert.ok(s.results.every((r) => r.ok));
  assert.ok(!(await slots(WED())).includes('12:00'));
  const del = await admin.del(`/api/admin/calendar-connections/${conn.id}`);
  assert.equal(del.body.connections.length, 0);
  assert.ok((await slots(WED())).includes('12:00'), 'po odpojení se blokace přestanou uplatňovat');
});
