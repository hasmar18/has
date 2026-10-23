import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, resetDb, closePool, seedBasics, futureDate, slotISO, time } from './helpers.js';
import { computeAvailability, isSlotOffered } from '../src/services/availability.js';
import { getSettings, updateSettings, invalidateSettings } from '../src/services/settings.js';

const TZ = 'Europe/Prague';
let svc, svc30;
before(async () => { await resetDb(); ({ svc, svc30 } = await seedBasics()); });
after(closePool);

const NOW = new Date('2026-10-20T06:00:00Z'); // úterý ráno – pevný „teď“ pro deterministické testy
const avail = async (date, dur = 60, now = NOW, to = date) => {
  invalidateSettings();
  const settings = await getSettings();
  const { days } = await computeAvailability({ query }, { durationMinutes: dur, fromDate: date, toDate: to, now, settings });
  return days;
};
const times = (day) => day.slots.map((s) => s.time);

test('pracovní den 9–17, služba 60 min → poslední začátek v 16:00', async () => {
  const [d] = await avail('2026-10-21');
  assert.equal(times(d)[0], '09:00');
  assert.equal(times(d).at(-1), '16:00');
  assert.equal(d.slots.length, 15); // po 30 minutách
});

test('víkend je zavřený', async () => {
  const [sat] = await avail('2026-10-24');
  assert.equal(sat.slots.length, 0);
});

test('kratší služba nabídne i poslední půlhodinu', async () => {
  const [d] = await avail('2026-10-21', 30);
  assert.equal(times(d).at(-1), '16:30');
});

test('přestávka (dva úseky pracovní doby) není nabízena', async () => {
  await query('DELETE FROM working_hours WHERE weekday = 3');
  await query(`INSERT INTO working_hours (weekday, start_time, end_time) VALUES (3, '09:00', '12:00'), (3, '13:00', '17:00')`);
  const [d] = await avail('2026-10-21'); // středa
  const t = times(d);
  assert.ok(t.includes('11:00'));        // 11:00–12:00 se vejde
  assert.ok(!t.includes('11:30'));       // 11:30–12:30 zasahuje do přestávky
  assert.ok(!t.includes('12:00'));
  assert.ok(t.includes('13:00'));
  await query('DELETE FROM working_hours WHERE weekday = 3');
  await query(`INSERT INTO working_hours (weekday, start_time, end_time) VALUES (3, '09:00', '17:00')`);
});

test('rezervace 10:00–11:30 vyřadí všechny kolidující začátky (i pro různé délky služeb)', async () => {
  const s = new Date(slotISO('2026-10-21', '10:00')); const e = new Date(slotISO('2026-10-21', '11:30'));
  await query(`INSERT INTO bookings (service_id, service_name, service_duration_minutes, client_name, client_email, starts_at, ends_at, blocked_until, status)
    VALUES ($1, 'x', 90, 'A', 'a@a.cz', $2, $3, $3, 'confirmed')`, [svc.id, s, e]);
  const [d60] = await avail('2026-10-21', 60);
  const t60 = times(d60);
  for (const bad of ['09:30', '10:00', '10:30', '11:00']) assert.ok(!t60.includes(bad), `60 min: ${bad} má být obsazeno`);
  assert.ok(t60.includes('09:00')); assert.ok(t60.includes('11:30'));
  const [d30] = await avail('2026-10-21', 30);
  const t30 = times(d30);
  assert.ok(t30.includes('09:30')); assert.ok(!t30.includes('10:00')); assert.ok(!t30.includes('11:00')); assert.ok(t30.includes('11:30'));
  await query('DELETE FROM bookings');
});

test('rezerva mezi klientkami se započítává za procedurou i před další rezervací', async () => {
  await updateSettings({ query }, { buffer_minutes: 15 });
  const s = new Date(slotISO('2026-10-21', '10:00')); const e = new Date(slotISO('2026-10-21', '11:00'));
  await query(`INSERT INTO bookings (service_id, service_name, service_duration_minutes, client_name, client_email, starts_at, ends_at, blocked_until, status)
    VALUES ($1, 'x', 60, 'A', 'a@a.cz', $2, $3, $4, 'confirmed')`, [svc.id, s, e, new Date(e.getTime() + 15 * 60000)]);
  const [d] = await avail('2026-10-21', 60);
  const t = times(d);
  assert.ok(!t.includes('11:00'), 'v 11:00 ještě běží rezerva');
  assert.ok(t.includes('11:30'));
  assert.ok(!t.includes('09:30'), '09:30 + 60 min + rezerva zasahuje do 10:00');
  assert.ok(!t.includes('09:00'), '09:00 + 60 min + 15 min rezervy zasahuje do rezervace v 10:00');
  assert.ok(t.includes('11:30'));
  await query('DELETE FROM bookings');
  await updateSettings({ query }, { buffer_minutes: 0 });
});

test('osobní blokace, externí událost a celodenní blokace', async () => {
  const [a1, b1] = [slotISO('2026-10-21', '13:00'), slotISO('2026-10-21', '14:00')];
  await query(`INSERT INTO time_blocks (starts_at, ends_at, reason) VALUES ($1, $2, 'soukromé')`, [a1, b1]);
  const conn = (await query(`INSERT INTO calendar_connections (provider, account_email, refresh_token_enc) VALUES ('fake', 'x@y', 'x') RETURNING id`)).rows[0];
  const src = (await query(`INSERT INTO calendar_sources (connection_id, external_calendar_id, blocks_availability, block_all_day) VALUES ($1, 'c', true, true) RETURNING id`, [conn.id])).rows[0];
  await query(`INSERT INTO external_blocks (source_id, external_event_id, starts_at, ends_at) VALUES ($1, 'e1', $2, $3)`, [src.id, slotISO('2026-10-21', '15:00'), slotISO('2026-10-21', '15:30')]);
  await query(`INSERT INTO external_blocks (source_id, external_event_id, starts_at, ends_at, is_all_day) VALUES ($1, 'e2', $2, $3, true)`,
    [src.id, time.dayStartUtc('2026-10-22', TZ), time.dayStartUtc('2026-10-23', TZ)]);
  const [d21, d22] = await avail('2026-10-21', 60, NOW, '2026-10-22');
  const t = times(d21);
  for (const bad of ['12:30', '13:00', '13:30', '14:30', '15:00']) assert.ok(!t.includes(bad), `${bad} má být obsazeno`);
  for (const good of ['12:00', '14:00', '15:30']) assert.ok(t.includes(good), `${good} má být volné`);
  assert.equal(d22.slots.length, 0, 'celodenní událost blokuje celý den');
  // blokace jen pro zdroj, který nemá blokovat dostupnost → nic se neblokuje
  await query(`UPDATE calendar_sources SET blocks_availability = false WHERE id = $1`, [src.id]);
  assert.ok((await avail('2026-10-22', 60, NOW))[0].slots.length > 0);
  // celodenní ignorovat, ale běžné blokovat
  await query(`UPDATE calendar_sources SET blocks_availability = true, block_all_day = false WHERE id = $1`, [src.id]);
  assert.ok((await avail('2026-10-22', 60, NOW))[0].slots.length > 0, 'celodenní události lze vypnout');
  await query('DELETE FROM external_blocks'); await query('DELETE FROM calendar_connections'); await query('DELETE FROM time_blocks');
});

test('dovolená (zavřeno) a mimořádné hodiny', async () => {
  await query(`INSERT INTO schedule_exceptions (kind, date_from, date_to, note) VALUES ('closed', '2026-10-26', '2026-10-28', 'dovolená')`);
  const days = await avail('2026-10-26', 60, NOW, '2026-10-29');
  assert.equal(days[0].slots.length, 0); assert.equal(days[1].slots.length, 0); assert.equal(days[2].slots.length, 0);
  assert.ok(days[3].slots.length > 0);
  // mimořádně otevřeno v sobotu 8–10
  await query(`INSERT INTO schedule_exceptions (kind, date_from, date_to, start_time, end_time) VALUES ('open', '2026-10-31', '2026-10-31', '08:00', '10:00')`);
  const [sat] = await avail('2026-10-31', 60);
  assert.deepEqual(times(sat), ['08:00', '08:30', '09:00']);
  // explicitní otevření uvnitř dovolené přebije zavřeno jen pro ten den
  await query(`INSERT INTO schedule_exceptions (kind, date_from, date_to, start_time, end_time) VALUES ('open', '2026-10-27', '2026-10-27', '10:00', '12:00')`);
  const [tue] = await avail('2026-10-27', 60);
  assert.deepEqual(times(tue), ['10:00', '10:30', '11:00']);
  await query('DELETE FROM schedule_exceptions');
});

test('minimální předstih a nejzazší termín', async () => {
  await updateSettings({ query }, { min_notice_hours: 24, max_advance_days: 3 });
  const now = new Date('2026-10-21T07:00:00Z'); // 9:00 místního času
  const days = await avail('2026-10-21', 60, now, '2026-10-30');
  assert.equal(days.length, 4, 'dnes + 3 dny');
  assert.equal(days[0].slots.length, 0, 'dnes už nelze (předstih 24 h)');
  assert.equal(times(days[1])[0], '09:00', 'zítra v 9:00 je přesně 24 h – povoleno, dřív ne');
  assert.equal(days.at(-1).date, '2026-10-24', 'nejzazší den = dnes + 3');
  await updateSettings({ query }, { min_notice_hours: 1, max_advance_days: 120 });
});

test('přechod na zimní čas: noční okno 0–6 h má 7 reálných hodin (14 půlhodinových slotů)', async () => {
  await query(`INSERT INTO schedule_exceptions (kind, date_from, date_to, start_time, end_time) VALUES ('open', '2026-10-25', '2026-10-25', '00:00', '06:00')`);
  const [d] = await avail('2026-10-25', 30);
  assert.equal(d.slots.length, 12 + 2, 'o hodinu navíc');
  // dva sloty mají stejný místní čas 02:00 / 02:30 (opakovaná hodina) – ale různé okamžiky
  const uniq = new Set(d.slots.map((s) => s.start));
  assert.equal(uniq.size, d.slots.length);
  await query('DELETE FROM schedule_exceptions');
});

test('přechod na letní čas: noční okno 0–6 h má jen 5 reálných hodin (10 půlhodinových slotů)', async () => {
  await updateSettings({ query }, { max_advance_days: 365 });
  await query(`INSERT INTO schedule_exceptions (kind, date_from, date_to, start_time, end_time) VALUES ('open', '2027-03-28', '2027-03-28', '00:00', '06:00')`);
  const [d] = await avail('2027-03-28', 30, NOW);
  assert.equal(d.slots.length, 10);
  assert.ok(!times(d).includes('02:00') && !times(d).includes('02:30'), 'neexistující hodina');
  await query('DELETE FROM schedule_exceptions');
});

test('běžný pracovní den po změně času zůstává 9:00–17:00 místního času', async () => {
  const [before, after] = await avail('2026-10-23', 60, NOW, '2026-10-26'); // pátek (letní), pondělí (zimní)
  const mon = (await avail('2026-10-26', 60, NOW))[0];
  assert.equal(before.slots[0].time, '09:00'); assert.equal(before.slots[0].start, '2026-10-23T07:00:00.000Z');
  assert.equal(mon.slots[0].time, '09:00'); assert.equal(mon.slots[0].start, '2026-10-26T08:00:00.000Z');
});

test('isSlotOffered odmítne čas mimo mřížku i obsazený čas', async () => {
  invalidateSettings();
  const settings = await getSettings();
  const ok = (iso) => isSlotOffered({ query }, { startsAt: new Date(iso), durationMinutes: 60, settings, now: NOW });
  assert.equal(await ok(slotISO('2026-10-21', '10:00')), true);
  assert.equal(await ok(slotISO('2026-10-21', '10:10')), false, 'mimo mřížku');
  assert.equal(await ok(slotISO('2026-10-21', '07:00')), false, 'mimo pracovní dobu');
  assert.equal(await ok(slotISO('2026-10-24', '10:00')), false, 'sobota');
});
