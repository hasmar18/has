import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  query, resetDb, closePool, seedBasics, futureDate, slotISO, startServer, Client, captureEmail, sentEmails, drainJobs,
  codeFromEmail, createAdmin, ADMIN, updateSettings,
} from './helpers.js';
import { getPool } from '../src/db.js';

let server, svc, svc30;
const WED = () => futureDate(3, 5);
const body = (over = {}) => ({ service_id: svc.id, starts_at: slotISO(WED(), '10:00'), name: 'Jana Nováková', email: 'jana@example.cz', phone: '+420 777 111 222', note: '', consent: true, ...over });

before(async () => { await resetDb(); ({ svc, svc30 } = await seedBasics()); server = await startServer(); await createAdmin(); });
after(async () => { await server.close(); await closePool(); });
beforeEach(async () => {
  await query('DELETE FROM bookings'); await query('DELETE FROM email_log'); await query('DELETE FROM jobs'); await query('DELETE FROM time_blocks');
  captureEmail();
});

const slotsFor = async (c, date, service = svc) => (await c.get(`/api/public/availability?service_id=${service.id}&from=${date}&to=${date}`)).body.days[0].slots.map((s) => s.time);

test('klientka bez účtu: rezervace → kód v e-mailu → potvrzení → termín zmizí z nabídky', async () => {
  const c = new Client(server.url);
  assert.ok((await slotsFor(c, WED())).includes('10:00'));
  const r = await c.post('/api/bookings', body());
  assert.equal(r.status, 200); assert.equal(r.body.needs_verification, true);
  assert.equal(r.body.booking.status, 'held');
  await drainJobs();
  const mail = sentEmails.find((m) => m.to === 'jana@example.cz');
  assert.ok(mail, 'ověřovací e-mail odešel');
  const code = codeFromEmail(mail);
  assert.match(code, /^\d{6}$/);
  // během držení je termín (i překrývající) nedostupný
  const during = await slotsFor(c, WED());
  assert.ok(!during.includes('10:00') && !during.includes('10:30') && !during.includes('09:30'));
  // špatný kód
  assert.equal((await c.post(`/api/bookings/${r.body.booking.id}/verify`, { code: '000000' })).status, 400);
  const ok = await c.post(`/api/bookings/${r.body.booking.id}/verify`, { code });
  assert.equal(ok.status, 200); assert.equal(ok.body.booking.status, 'confirmed');
  assert.match(ok.body.manage_url, /\/rezervace\/sprava\?token=/);
  await drainJobs();
  assert.equal(sentEmails.filter((m) => m.to === 'jana@example.cz').length, 2, 'ověření + potvrzení');
  const after = await slotsFor(c, WED());
  assert.ok(!after.includes('10:00') && !after.includes('10:30') && after.includes('11:00') && after.includes('09:00'));
  // opakované ověření je idempotentní a nevyvolá další e-mail
  assert.equal((await c.post(`/api/bookings/${r.body.booking.id}/verify`, { code })).status, 200);
  await drainJobs();
  assert.equal(sentEmails.filter((m) => m.to === 'jana@example.cz').length, 2);
});

test('SOUBĚŽNOST: 20 klientek najednou chce stejný termín → uspěje právě jedna', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => new Client(server.url).post('/api/bookings', body({ email: `k${i}@example.cz`, name: `Klientka ${i}` }))));
  const ok = results.filter((r) => r.status === 200);
  const rejected = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, `uspěla ${ok.length}`);
  assert.equal(rejected.length, 19);
  assert.equal((await query(`SELECT count(*)::int AS n FROM bookings WHERE status IN ('held','confirmed')`)).rows[0].n, 1);
});

test('SOUBĚŽNOST: částečně se překrývající termíny (10:00 vs 10:30) – jen jeden projde', async () => {
  const times = ['10:00', '10:30', '10:00', '10:30', '09:30', '10:00'];
  const results = await Promise.all(times.map((t, i) => new Client(server.url).post('/api/bookings', body({ starts_at: slotISO(WED(), t), email: `p${i}@example.cz` }))));
  const okIdx = results.map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
  assert.ok(okIdx.length >= 1, 'aspoň jedna rezervace projde');
  // přijaté rezervace se nesmí překrývat (09:30 a 10:30 na sebe jen navazují – to je v pořádku)
  const rows = (await query(`SELECT starts_at, ends_at FROM bookings WHERE status IN ('held','confirmed') ORDER BY starts_at`)).rows;
  assert.equal(rows.length, okIdx.length);
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].starts_at >= rows[i - 1].ends_at, 'žádný překryv');
  for (const r of results.filter((x) => x.status !== 200)) assert.equal(r.status, 409);
});

test('SOUBĚŽNOST na úrovni databáze: omezení v PostgreSQL samo brání překryvu (i bez aplikační logiky)', async () => {
  const s = new Date(slotISO(WED(), '14:00')); const e = new Date(slotISO(WED(), '15:00'));
  const pool = getPool();
  const attempt = () => pool.query(
    `INSERT INTO bookings (service_id, service_name, service_duration_minutes, client_name, client_email, starts_at, ends_at, blocked_until, status)
     VALUES ($1, 'x', 60, 'A', 'a@a.cz', $2, $3, $3, 'confirmed')`, [svc.id, s, e]).then(() => 'ok', (err) => err.code);
  const res = await Promise.all(Array.from({ length: 12 }, attempt));
  // Při souběžných vloženích do GiST omezení může PostgreSQL místo 23P01 vrátit i detekovaný deadlock (40P01) – obojí je správné odmítnutí.
  assert.equal(res.filter((r) => r === 'ok').length, 1, JSON.stringify(res));
  assert.ok(res.filter((r) => r !== 'ok').every((r) => ['23P01', '40P01'].includes(r)), `ostatní selžou na omezení: ${JSON.stringify(res)}`);
  assert.equal((await query(`SELECT count(*)::int AS n FROM bookings WHERE starts_at = $1 AND status = 'confirmed'`, [s])).rows[0].n, 1);
});

test('držení termínu vyprší a termín se uvolní; vypršelou rezervaci nelze potvrdit', async () => {
  const c = new Client(server.url);
  const r = await c.post('/api/bookings', body());
  await drainJobs();
  const code = codeFromEmail(sentEmails[0]);
  await query(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [r.body.booking.id]);
  assert.ok((await slotsFor(c, WED())).includes('10:00'), 'po vypršení držení je termín znovu volný');
  assert.equal((await c.post(`/api/bookings/${r.body.booking.id}/verify`, { code })).status, 410);
  // jiná klientka si termín může vzít
  assert.equal((await new Client(server.url).post('/api/bookings', body({ email: 'jina@example.cz' }))).status, 200);
});

test('5 chybných kódů zneplatní rezervaci', async () => {
  const c = new Client(server.url);
  const r = await c.post('/api/bookings', body());
  for (let i = 0; i < 4; i += 1) assert.equal((await c.post(`/api/bookings/${r.body.booking.id}/verify`, { code: '111111' })).status, 400);
  assert.equal((await c.post(`/api/bookings/${r.body.booking.id}/verify`, { code: '111111' })).status, 410, '5. špatný pokus rezervaci zneplatní');
  assert.equal((await query(`SELECT status, verify_attempts FROM bookings WHERE id = $1`, [r.body.booking.id])).rows[0].status, 'expired');
  // ani správný kód už nepomůže
  await drainJobs();
  const code = codeFromEmail(sentEmails[0]);
  assert.equal((await c.post(`/api/bookings/${r.body.booking.id}/verify`, { code })).status, 410);
  assert.ok((await slotsFor(c, WED())).includes('10:00'), 'termín je znovu volný');
});

test('validace vstupu a omezení: bez souhlasu, špatný e-mail, mimo mřížku, neexistující služba', async () => {
  const c = new Client(server.url);
  assert.equal((await c.post('/api/bookings', body({ consent: false }))).status, 400);
  assert.equal((await c.post('/api/bookings', body({ email: 'neni-email' }))).status, 400);
  assert.equal((await c.post('/api/bookings', body({ starts_at: slotISO(WED(), '10:10') }))).status, 409);
  assert.equal((await c.post('/api/bookings', body({ starts_at: slotISO(WED(), '20:00') }))).status, 409);
  assert.equal((await c.post('/api/bookings', body({ service_id: '00000000-0000-4000-8000-000000000000' }))).status, 400);
  assert.equal((await c.post('/api/bookings', body({ name: '<script>' + 'x'.repeat(200) }))).status, 400);
});

test('max. 2 rozpracované rezervace na jeden e-mail (ochrana proti blokování kalendáře)', async () => {
  const c = new Client(server.url);
  assert.equal((await c.post('/api/bookings', body({ starts_at: slotISO(WED(), '09:00') }))).status, 200);
  assert.equal((await c.post('/api/bookings', body({ starts_at: slotISO(WED(), '11:00') }))).status, 200);
  assert.equal((await c.post('/api/bookings', body({ starts_at: slotISO(WED(), '13:00') }))).status, 429);
});

test('vypnuté online rezervace: nabídka je prázdná a vytvoření je odmítnuto', async () => {
  await updateSettings({ query }, { online_booking_enabled: false });
  const c = new Client(server.url);
  assert.equal((await c.get(`/api/public/availability?service_id=${svc.id}`)).body.disabled, true);
  assert.equal((await c.post('/api/bookings', body())).status, 503);
  await updateSettings({ query }, { online_booking_enabled: true });
});

test('registrovaná klientka s ověřeným e-mailem: rezervace je hned potvrzená, vidí jen své', async () => {
  const a = new Client(server.url); const b = new Client(server.url);
  for (const [cl, mail] of [[a, 'anna@example.cz'], [b, 'beata@example.cz']]) {
    assert.equal((await cl.post('/api/auth/register', { email: mail, password: 'Tajne-heslo-123', name: 'Test Klientka', phone: '' })).status, 200);
    await drainJobs();
    const link = sentEmails.filter((m) => m.to === mail).at(-1).text.match(/overit=([^\s&]+)/)[1];
    assert.equal((await cl.post('/api/auth/verify-email', { token: decodeURIComponent(link) })).status, 200);
    assert.equal((await cl.login(mail, 'Tajne-heslo-123')).status, 200);
  }
  const r = await a.post('/api/bookings', body({ email: 'anna@example.cz', name: 'Anna' }));
  assert.equal(r.status, 200); assert.equal(r.body.needs_verification, false); assert.equal(r.body.booking.status, 'confirmed');
  await drainJobs();
  assert.equal(sentEmails.filter((m) => m.to === 'anna@example.cz').at(-1).subject.startsWith('Rezervace potvrzena'), true);
  const mineA = (await a.get('/api/me/bookings')).body;
  const mineB = (await b.get('/api/me/bookings')).body;
  assert.equal(mineA.upcoming.length, 1); assert.equal(mineB.upcoming.length, 0);
  // IDOR: Beata nemůže zrušit ani požádat o změnu cizí rezervace
  const id = mineA.upcoming[0].id;
  assert.equal((await b.post(`/api/me/bookings/${id}/cancel`, {})).status, 404);
  assert.equal((await b.post(`/api/me/bookings/${id}/reschedule-request`, { message: 'chci jiný termín' })).status, 404);
  assert.equal((await query(`SELECT status FROM bookings WHERE id = $1`, [id])).rows[0].status, 'confirmed');
  // vlastní rezervaci zrušit může (termín je > 24 h v budoucnu)
  const cancel = await a.post(`/api/me/bookings/${id}/cancel`, {});
  assert.equal(cancel.status, 200); assert.equal(cancel.body.booking.status, 'cancelled');
  await drainJobs();
  assert.ok(sentEmails.some((m) => m.to === 'anna@example.cz' && /zrušena/i.test(m.subject)));
  assert.ok(sentEmails.some((m) => m.to === ADMIN.email && /Zrušená rezervace/.test(m.subject)), 'majitelka dostala upozornění o zrušení klientkou');
  // znovu zrušit = idempotentní, žádný druhý e-mail
  const n = sentEmails.length;
  assert.equal((await a.post(`/api/me/bookings/${id}/cancel`, {})).status, 200);
  await drainJobs();
  assert.equal(sentEmails.length, n);
  assert.ok((await slotsFor(a, WED())).includes('10:00'), 'zrušením se termín uvolní');
});

test('správa přes tajný odkaz: zobrazení, storno lhůta, žádost o změnu; cizí token nic neodhalí', async () => {
  const c = new Client(server.url);
  const r = await c.post('/api/bookings', body());
  await drainJobs();
  const v = await c.post(`/api/bookings/${r.body.booking.id}/verify`, { code: codeFromEmail(sentEmails[0]) });
  const token = new URL(v.body.manage_url).searchParams.get('token');
  const view = await c.post('/api/bookings/manage/view', { token });
  assert.equal(view.body.booking.service_name, 'Testovací služba');
  assert.equal(view.body.booking.client_email, undefined, 'e-mail se v klientském výstupu nevrací');
  assert.equal((await c.post('/api/bookings/manage/view', { token: 'neplatny-token-xxxxxxxx' })).status, 404);
  // storno lhůta: rezervace za < 24 h se online zrušit nedá
  await query(`UPDATE bookings SET starts_at = now() + interval '5 hours', ends_at = now() + interval '6 hours', blocked_until = now() + interval '6 hours' WHERE id = $1`, [r.body.booking.id]);
  const late = await c.post('/api/bookings/manage/cancel', { token });
  assert.equal(late.status, 403); assert.match(late.body.error.message, /zavolejte/);
  assert.equal((await c.post('/api/bookings/manage/reschedule-request', { token, message: 'Můžeme to posunout?' })).status, 200);
  await drainJobs();
  assert.ok(sentEmails.some((m) => /Žádost o změnu termínu/.test(m.subject)), 'majitelka dostala upozornění');
});

test('administrace: nepřihlášený 401, klientka 403, bez CSRF 403, správce projde', async () => {
  const anon = new Client(server.url);
  assert.equal((await anon.get('/api/admin/dashboard')).status, 401);
  const cl = new Client(server.url);
  await cl.post('/api/auth/register', { email: 'klientka@example.cz', password: 'Tajne-heslo-123', name: 'Klientka', phone: '' });
  await query(`UPDATE users SET email_verified_at = now() WHERE email = 'klientka@example.cz'`);
  assert.equal((await cl.login('klientka@example.cz', 'Tajne-heslo-123')).status, 200);
  assert.equal((await cl.get('/api/admin/dashboard')).status, 403);
  assert.equal((await cl.post('/api/admin/blocks', {})).status, 403);
  const admin = new Client(server.url);
  assert.equal((await admin.login(ADMIN.email, ADMIN.password)).status, 200);
  assert.equal((await admin.get('/api/admin/dashboard')).status, 200);
  const noCsrf = await admin.post('/api/admin/blocks', { starts_at: slotISO(WED(), '10:00'), ends_at: slotISO(WED(), '11:00') }, { headers: { 'x-csrf-token': 'spatny' } });
  assert.equal(noCsrf.status, 403);
  // Origin z cizí domény se odmítne
  const evil = await admin.post('/api/admin/blocks', { starts_at: slotISO(WED(), '10:00'), ends_at: slotISO(WED(), '11:00') }, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  // registrace nikdy nevytvoří správce
  assert.equal((await query(`SELECT role FROM users WHERE email = 'klientka@example.cz'`)).rows[0].role, 'client');
});

test('administrace: ruční rezervace kontroluje kolize, výjimku je třeba vědomě potvrdit', async () => {
  const admin = new Client(server.url); await admin.login(ADMIN.email, ADMIN.password);
  const first = await admin.post('/api/admin/bookings', { service_id: svc.id, starts_at: slotISO(WED(), '10:00'), name: 'Telefonická', phone: '+420 600 000 000', email: '', notify: false });
  assert.equal(first.status, 200);
  const clash = await admin.post('/api/admin/bookings', { service_id: svc.id, starts_at: slotISO(WED(), '10:30'), name: 'Kolize', email: '' });
  assert.equal(clash.status, 409); assert.equal(clash.body.error.code, 'conflict_detected'); assert.equal(clash.body.error.can_override, true);
  assert.equal(clash.body.error.conflicts.length, 1);
  const forced = await admin.post('/api/admin/bookings', { service_id: svc.id, starts_at: slotISO(WED(), '10:30'), name: 'Vědomá výjimka', email: '', force: true });
  assert.equal(forced.status, 200); assert.equal(forced.body.booking.conflict_override, true);
  // klientkám se oba časy dál nenabízejí
  const t = await slotsFor(new Client(server.url), WED());
  assert.ok(!t.includes('10:00') && !t.includes('10:30') && !t.includes('11:00'));
  // ruční blokace
  const blk = await admin.post('/api/admin/blocks', { starts_at: slotISO(WED(), '14:00'), ends_at: slotISO(WED(), '15:00'), reason: 'zubař' });
  assert.equal(blk.status, 200);
  const t2 = await slotsFor(new Client(server.url), WED());
  assert.ok(!t2.includes('14:00') && !t2.includes('13:30') && t2.includes('15:00'));
  assert.ok(!JSON.stringify((await new Client(server.url).get(`/api/public/availability?service_id=${svc.id}&from=${WED()}&to=${WED()}`)).body).includes('zubař'), 'důvod blokace se klientkám nikdy neprozradí');
  await admin.del(`/api/admin/blocks/${blk.body.id}`);
  assert.ok((await slotsFor(new Client(server.url), WED())).includes('14:00'));
});

test('administrace: přesun rezervace → historie, e-mail jen jednou, kolize se hlídají; změna délky', async () => {
  const admin = new Client(server.url); await admin.login(ADMIN.email, ADMIN.password);
  const c = new Client(server.url);
  const r = await c.post('/api/bookings', body());
  await drainJobs();
  await c.post(`/api/bookings/${r.body.booking.id}/verify`, { code: codeFromEmail(sentEmails[0]) });
  await drainJobs();
  const id = r.body.booking.id;
  const other = await admin.post('/api/admin/bookings', { service_id: svc.id, starts_at: slotISO(WED(), '13:00'), name: 'Jiná', email: '', notify: false });
  assert.equal(other.status, 200);
  const clash = await admin.patch(`/api/admin/bookings/${id}`, { starts_at: slotISO(WED(), '13:30') });
  assert.equal(clash.status, 409);
  const before = sentEmails.length;
  const moved = await admin.patch(`/api/admin/bookings/${id}`, { starts_at: slotISO(WED(), '15:00') });
  assert.equal(moved.status, 200); assert.equal(moved.body.booking.local_time, '15:00');
  await drainJobs();
  const resched = sentEmails.slice(before).filter((m) => /Změna termínu/.test(m.subject));
  assert.equal(resched.length, 1);
  // tentýž PATCH znovu = žádná změna, žádný další e-mail
  await admin.patch(`/api/admin/bookings/${id}`, { starts_at: slotISO(WED(), '15:00') });
  await drainJobs();
  assert.equal(sentEmails.slice(before).filter((m) => /Změna termínu/.test(m.subject)).length, 1, 'e-mail o změně termínu se neposílá duplicitně');
  // prodloužení na 120 minut
  const longer = await admin.patch(`/api/admin/bookings/${id}`, { duration_minutes: 120, notify: false });
  assert.equal(longer.body.booking.duration_minutes, 120);
  const hist = (await admin.get(`/api/admin/bookings/${id}`)).body.history.map((h) => h.action);
  assert.ok(hist.includes('created') && hist.includes('confirmed') && hist.includes('rescheduled'));
  // původní termín 10:00 je zase volný
  assert.ok((await slotsFor(c, WED())).includes('10:00'));
});

test('změna ceny/délky služby ani její odstranění nezmění historii rezervací', async () => {
  const admin = new Client(server.url); await admin.login(ADMIN.email, ADMIN.password);
  const created = await admin.post('/api/admin/services', { name: 'Dočasná služba', description: 'x', duration_minutes: 45, price_czk: 400, is_active: true });
  const sid = created.body.service.id;
  const b = await admin.post('/api/admin/bookings', { service_id: sid, starts_at: slotISO(WED(), '09:00'), name: 'Historie', email: '', notify: false });
  await admin.patch(`/api/admin/services/${sid}`, { price_czk: 999, duration_minutes: 90, name: 'Přejmenovaná' });
  await admin.del(`/api/admin/services/${sid}`);
  const row = (await query(`SELECT service_name, service_duration_minutes, price_czk FROM bookings WHERE id = $1`, [b.body.booking.id])).rows[0];
  assert.deepEqual(row, { service_name: 'Dočasná služba', service_duration_minutes: 45, price_czk: 400 });
  const pub = (await new Client(server.url).get('/api/public/bootstrap')).body;
  assert.ok(!JSON.stringify(pub.categories).includes('Dočasná'), 'archivovaná služba se nenabízí');
});

test('změna textu a služby v administraci se projeví na veřejném webu (API)', async () => {
  const admin = new Client(server.url); await admin.login(ADMIN.email, ADMIN.password);
  await admin.put('/api/admin/content', { hero_title: 'Nový nadpis úvodní stránky' });
  const s = await admin.post('/api/admin/services', { name: 'Nová služba z administrace', description: 'Popis', duration_minutes: 75, price_czk: 700, price_from: true });
  const pub = (await new Client(server.url).get('/api/public/bootstrap')).body;
  assert.equal(pub.content.hero_title, 'Nový nadpis úvodní stránky');
  const found = pub.categories.flatMap((c) => c.services).find((x) => x.id === s.body.service.id);
  assert.ok(found && found.price_czk === 700 && found.price_from === true && found.duration_minutes === 75);
  // vypnutí služby ji skryje
  await admin.patch(`/api/admin/services/${s.body.service.id}`, { is_active: false });
  assert.ok(!JSON.stringify((await new Client(server.url).get('/api/public/bootstrap')).body.categories).includes('Nová služba z administrace'));
});

test('bezpečnostní hlavičky a statické soubory: path traversal se neprojeví', async () => {
  const c = new Client(server.url);
  const h = await c.get('/healthz');
  assert.equal(h.status, 200);
  assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/src/config.js', '/admin/../../src/config.js']) {
    const r = await c.get(p);
    assert.ok([400, 404].includes(r.status) || !/loadConfig|"name": "hasnails"/.test(r.text), `path traversal ${p}`);
  }
  assert.equal((await c.get('/api/neexistuje')).status, 404);
});

test('bez vyžadovaného ověření e-mailu se rezervace potvrdí hned', async () => {
  await updateSettings({ query }, { require_email_verification: false });
  try {
    const c = new Client(server.url);
    const r = await c.post('/api/bookings', body({ email: 'novy@example.cz' }));
    assert.equal(r.status, 200); assert.equal(r.body.needs_verification, false); assert.equal(r.body.booking.status, 'confirmed');
    await drainJobs();
    assert.ok(sentEmails.find((m) => m.to === 'novy@example.cz'), 'potvrzovací e-mail odešel');
    assert.equal((await slotsFor(c, WED())).includes('10:00'), false, 'termín je obsazený');
  } finally { await updateSettings({ query }, { require_email_verification: true }); }
});

test('potvrzovací e-mail obsahuje odkazy do kalendáře a .ics funguje', async () => {
  await updateSettings({ query }, { require_email_verification: false });
  try {
    const c = new Client(server.url);
    const r = await c.post('/api/bookings', body({ email: 'ics@example.cz' }));
    assert.equal(r.status, 200);
    await drainJobs();
    const mail = sentEmails.find((m) => m.to === 'ics@example.cz');
    assert.ok(mail.html.includes('calendar.google.com/calendar/render'), 'odkaz Google kalendář');
    const m = mail.text.match(/kalendar\.ics\?token=[^\s]+/);
    assert.ok(m, 'odkaz na .ics');
    const res = await fetch(`${server.url}/rezervace/${m[0]}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/calendar/);
    const ics = await res.text();
    assert.ok(ics.includes('BEGIN:VEVENT') && ics.includes('DTSTART:'));
    assert.equal((await fetch(`${server.url}/rezervace/kalendar.ics?token=neplatny-token-123`)).status, 404);
  } finally { await updateSettings({ query }, { require_email_verification: true }); }
});
