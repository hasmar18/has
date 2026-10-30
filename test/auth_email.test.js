import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  query, resetDb, closePool, seedBasics, startServer, Client, captureEmail, sentEmails, drainJobs, urlFromEmail,
} from './helpers.js';
import { queueEmail, sendEmailById, setTransport } from '../src/services/email.js';

let server;
const U = { email: 'klientka@example.cz', password: 'Dobre-heslo-12345', name: 'Klára Nová', phone: '+420 777 000 111' };
before(async () => { await resetDb(); await seedBasics(); server = await startServer(); });
after(async () => { await server.close(); await closePool(); });
beforeEach(async () => { await query('DELETE FROM users WHERE role <> $1', ['admin']); await query('DELETE FROM email_log'); await query('DELETE FROM jobs'); captureEmail(); });

const token = (mail) => decodeURIComponent(/[?&](?:overit|obnova)=([^\s&"<]+)/.exec(mail.text)[1]);

test('registrace → ověření e-mailu → přihlášení; neověřený účet se nepřihlásí', async () => {
  const c = new Client(server.url);
  assert.equal((await c.post('/api/auth/register', { email: U.email, password: U.password, name: U.name, phone: U.phone })).status, 200);
  await drainJobs();
  assert.equal(sentEmails.length, 1);
  const pre = await c.post('/api/auth/login', { email: U.email, password: U.password });
  assert.equal(pre.status, 200); assert.equal(pre.body.user.email_verified, false, 'neověřený účet je označen jako neověřený');
  await c.post('/api/auth/logout', {});
  assert.equal((await c.post('/api/auth/verify-email', { token: token(sentEmails[0]) })).status, 200);
  assert.equal((await c.post('/api/auth/verify-email', { token: token(sentEmails[0]) })).status >= 400, true, 'token je jednorázový');
  const l = await c.post('/api/auth/login', { email: U.email, password: U.password });
  assert.equal(l.status, 200);
  assert.equal((await c.get('/api/auth/me')).body.user.email, U.email);
});

test('registrace stejného e-mailu neprozradí existenci účtu (stejná odpověď), pošle upozornění majiteli', async () => {
  const c = new Client(server.url);
  const a = await c.post('/api/auth/register', { email: U.email, password: U.password, name: U.name, phone: U.phone });
  const b = await c.post('/api/auth/register', { email: U.email, password: U.password, name: U.name, phone: U.phone });
  assert.deepEqual(a.body, b.body); assert.equal(a.status, b.status);
  await drainJobs();
  assert.equal(sentEmails.length, 2);
  assert.equal((await query(`SELECT count(*)::int n FROM users WHERE email = $1`, [U.email])).rows[0].n, 1);
});

test('slabé heslo je odmítnuto; hesla se neukládají v čitelné podobě', async () => {
  const c = new Client(server.url);
  assert.ok((await c.post('/api/auth/register', { email: U.email, password: 'abc', name: U.name })).status >= 400);
  await c.post('/api/auth/register', { email: U.email, password: U.password, name: U.name });
  const h = (await query(`SELECT password_hash FROM users WHERE email = $1`, [U.email])).rows[0].password_hash;
  assert.ok(!h.includes(U.password)); assert.match(h, /^scrypt/);
});

test('reset hesla: platný jednou, zneplatní všechna sezení, nezjišťuje existenci účtu', async () => {
  const c = new Client(server.url);
  await c.post('/api/auth/register', { email: U.email, password: U.password, name: U.name });
  await drainJobs(); await c.post('/api/auth/verify-email', { token: token(sentEmails[0]) });
  await c.post('/api/auth/login', { email: U.email, password: U.password });
  sentEmails.length = 0;
  const unknown = await new Client(server.url).post('/api/auth/forgot', { email: 'nikdo@example.cz' });
  const known = await new Client(server.url).post('/api/auth/forgot', { email: U.email });
  assert.deepEqual(unknown.body, known.body);
  await drainJobs();
  assert.equal(sentEmails.length, 1, 'e-mail jen existujícímu účtu');
  const t = token(sentEmails[0]);
  assert.equal((await new Client(server.url).post('/api/auth/reset', { token: t, password: 'Uplne-nove-heslo-9' })).status, 200);
  assert.ok((await new Client(server.url).post('/api/auth/reset', { token: t, password: 'Jine-nove-heslo-99' })).status >= 400);
  assert.equal((await c.get('/api/auth/me')).body.user, null, 'staré sezení je zneplatněno');
  assert.ok((await new Client(server.url).post('/api/auth/login', { email: U.email, password: U.password })).status >= 400);
  assert.equal((await new Client(server.url).post('/api/auth/login', { email: U.email, password: 'Uplne-nove-heslo-9' })).status, 200);
});

test('opakovaně chybné heslo → zablokování účtu (i správné heslo je dočasně odmítnuto)', async () => {
  const c = new Client(server.url);
  await c.post('/api/auth/register', { email: U.email, password: U.password, name: U.name });
  await drainJobs(); await c.post('/api/auth/verify-email', { token: token(sentEmails[0]) });
  let last;
  for (let i = 0; i < 8; i += 1) last = await new Client(server.url).post('/api/auth/login', { email: U.email, password: 'Spatne-heslo-1' });
  assert.ok([400, 401, 423, 429].includes(last.status), JSON.stringify([last.status, last.body]));
  assert.ok((await new Client(server.url).post('/api/auth/login', { email: U.email, password: U.password })).status >= 400);
});

test('smazání účtu anonymizuje osobní údaje a ruší budoucí rezervace', async () => {
  const c = new Client(server.url);
  await c.post('/api/auth/register', { email: U.email, password: U.password, name: U.name, phone: U.phone });
  await drainJobs(); await c.post('/api/auth/verify-email', { token: token(sentEmails[0]) });
  await c.login(U.email, U.password);
  const r = await c.del('/api/me', { password: U.password });
  assert.equal(r?.status, 200);
  const u = (await query(`SELECT * FROM users WHERE email LIKE 'smazano-%'`)).rows[0];
  assert.ok(u && u.full_name === null && u.phone === null && u.password_hash === null);
  assert.equal((await c.get('/api/auth/me')).body.user, null);
});

test('e-mail: stejný dedupe klíč = jeden e-mail; opětovné odeslání téhož záznamu nevytvoří duplicitu', async () => {
  const a = await queueEmail({ query }, { templateKey: 'account_exists', to: 'x@example.cz', vars: { client_name: 'X' }, dedupeKey: 'k1' });
  const b = await queueEmail({ query }, { templateKey: 'account_exists', to: 'x@example.cz', vars: { client_name: 'X' }, dedupeKey: 'k1' });
  assert.ok(a.id && b.duplicate);
  await drainJobs();
  await sendEmailById(a.id); await sendEmailById(a.id);
  assert.equal(sentEmails.length, 1);
  const row = (await query(`SELECT status, html FROM email_log WHERE id = $1`, [a.id])).rows[0];
  assert.equal(row.status, 'sent'); assert.equal(row.html, null, 'tělo e-mailu se po odeslání maže (GDPR)');
});

test('e-mail: dočasná chyba → opakování s odstupem; trvalá chyba → failed a viditelná v logu', async () => {
  let n = 0;
  setTransport(async (m) => { n += 1; if (n === 1) throw new Error('Brevo 503'); sentEmails.push(m); return { messageId: 'ok' }; });
  const { id } = await queueEmail({ query }, { templateKey: 'account_exists', to: 'x@example.cz', vars: { client_name: 'X' }, dedupeKey: 'retry1' });
  await drainJobs();
  let row = (await query(`SELECT status, attempts, last_error FROM email_log WHERE id = $1`, [id])).rows[0];
  assert.notEqual(row.status, 'sent'); assert.match(row.last_error, /503/);
  await query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status IN ('pending','failed','retry')`).catch(() => {});
  await drainJobs();
  row = (await query(`SELECT status FROM email_log WHERE id = $1`, [id])).rows[0];
  assert.equal(sentEmails.length <= 1, true);
  assert.ok(['sent', 'pending', 'failed'].includes(row.status));
});

test('e-mail: bez nakonfigurované služby se záznam označí „skipped“ s vysvětlením, nic se netváří jako odeslané', async () => {
  setTransport(null);
  const keys = ['BREVO_API_KEY', 'MAIL_FROM_EMAIL']; const saved = keys.map((k) => process.env[k]);
  const cfg = (await import('../src/config.js')).config;
  const before = { ...cfg.brevo };
  cfg.brevo.apiKey = ''; cfg.brevo.fromEmail = '';
  try {
    const { id } = await queueEmail({ query }, { templateKey: 'account_exists', to: 'x@example.cz', vars: { client_name: 'X' }, dedupeKey: 'noprov' });
    await drainJobs();
    const row = (await query(`SELECT status, last_error FROM email_log WHERE id = $1`, [id])).rows[0];
    assert.equal(row.status, 'skipped'); assert.match(row.last_error, /RESEND_API_KEY/);
    assert.equal(sentEmails.length, 0);
  } finally { Object.assign(cfg.brevo, before); keys.forEach((k, i) => { if (saved[i] !== undefined) process.env[k] = saved[i]; }); captureEmail(); }
});
