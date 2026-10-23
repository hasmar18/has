import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, resetDb, closePool, startServer, Client, createAdmin, ADMIN } from './helpers.js';
import { seedServices } from '../src/services/seed.js';
import { loadOAuthCreds } from '../src/services/oauthCreds.js';
import { config } from '../src/config.js';
import { registerProvider } from '../src/calendar/providers.js';
import { google } from '../src/calendar/google.js';

let server; let admin;
before(async () => { registerProvider(google); await resetDb(); server = await startServer(); await createAdmin(); admin = new Client(server.url); await admin.login(ADMIN.email, ADMIN.password); });
after(async () => { await server.close(); await closePool(); });

test('výchozí služby: založí se jednou, bez cen, správné délky; smazání se nevrací', async () => {
  assert.equal(await seedServices(), true);
  assert.equal(await seedServices(), false, 'podruhé nic');
  const r = (await query(`SELECT name, duration_minutes, price_czk, image_url FROM services ORDER BY sort_order`)).rows;
  assert.deepEqual(r.map((x) => [x.name, x.duration_minutes]), [['Gellak', 120], ['Klasická manikúra', 30], ['COMBO Mani a Pedi', 240], ['Přístrojová pedikúra', 60], ['Přístrojová pedikúra + gellak', 120], ['Úprava nehtů + gellak (bez ošetření chodidel)', 90], ['COMBO Mani a Pedi', 240]]);
  assert.ok(r.every((x) => x.price_czk === null), 'ceny se nevymýšlejí');
  await query('DELETE FROM services');
  assert.equal(await seedServices(), false, 'smazané služby se znovu nezakládají');
  const boot = (await new Client(server.url).get('/api/public/bootstrap')).body;
  assert.equal(boot.hours, undefined, 'otevírací doba se veřejně nevydává');
  assert.deepEqual(boot.categories, []);
});

test('legální texty obsahují údaje provozovatele z ARES', async () => {
  const c = (await new Client(server.url).get('/api/public/bootstrap')).body.content;
  for (const t of [c.terms_text, c.privacy_text]) { assert.match(t, /24568902/); assert.match(t, /K nádraží 268, 747 66 Dolní Lhota/); }
});

test('Google údaje zadané v administraci: uloží se šifrovaně, aktivují poskytovatele, bez nich se nedá propojit', async () => {
  const before = (await admin.get('/api/admin/calendar-oauth')).body;
  assert.equal(before.google.configured, false);
  assert.equal((await admin.post('/api/admin/calendar/connect', { provider: 'google' })).status, 400);
  assert.equal((await admin.put('/api/admin/calendar-oauth/google', { client_id: 'abc', client_secret: '' })).status, 400, 'obě hodnoty nebo žádná');
  const r = await admin.put('/api/admin/calendar-oauth/google', { client_id: 'id-123.apps.googleusercontent.com', client_secret: 'tajne-456' });
  assert.equal(r.status, 200); assert.equal(r.body.configured, true);
  const raw = (await query(`SELECT value_enc FROM secrets WHERE key = 'oauth_google'`)).rows[0].value_enc;
  assert.ok(!raw.includes('tajne-456') && !raw.includes('id-123'), 'v databázi je zašifrováno');
  assert.ok(!JSON.stringify((await admin.get('/api/admin/calendar-oauth')).body).includes('tajne-456'), 'secret se nikdy nevrací');
  const c = await admin.post('/api/admin/calendar/connect', { provider: 'google' });
  assert.equal(c.status, 200); assert.match(c.body.url, /accounts\.google\.com/); assert.match(c.body.url, /client_id=id-123/);
  config.google.clientId = ''; config.google.clientSecret = ''; await loadOAuthCreds();
  assert.equal(config.google.clientId, 'id-123.apps.googleusercontent.com', 'po restartu se načte z databáze');
  await admin.put('/api/admin/calendar-oauth/google', { client_id: '', client_secret: '' });
  assert.equal((await admin.get('/api/admin/calendar-oauth')).body.google.configured, false);
  assert.equal((await new Client(server.url).get('/api/admin/calendar-oauth')).status, 401, 'jen správce');
});

test('logo: jedna fotka může být logem, do galerie se nezobrazuje', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const up = await admin.req('POST', '/api/admin/gallery?alt=profil', png, { raw: true, headers: { 'content-type': 'image/png' } });
  assert.equal(up.status, 200);
  assert.equal((await admin.patch(`/api/admin/gallery/${up.body.id}`, { is_logo: true })).status, 200);
  const boot = (await new Client(server.url).get('/api/public/bootstrap')).body;
  assert.equal(boot.logo_id, up.body.id); assert.equal(boot.gallery.length, 0);
});
