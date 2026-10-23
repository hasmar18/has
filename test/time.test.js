import test from 'node:test';
import assert from 'node:assert/strict';
import { time } from './helpers.js';

const TZ = 'Europe/Prague';

test('místní čas → UTC respektuje letní a zimní čas', () => {
  // 24. 10. 2026 je ještě letní čas (UTC+2), 25. 10. v noci se přechází na zimní (UTC+1)
  assert.equal(time.localToUtc('2026-10-24', '09:00', TZ).toISOString(), '2026-10-24T07:00:00.000Z');
  assert.equal(time.localToUtc('2026-10-25', '09:00', TZ).toISOString(), '2026-10-25T08:00:00.000Z');
  // jarní přechod: 28. 3. 2027 (UTC+1 → UTC+2)
  assert.equal(time.localToUtc('2027-03-27', '09:00', TZ).toISOString(), '2027-03-27T08:00:00.000Z');
  assert.equal(time.localToUtc('2027-03-28', '09:00', TZ).toISOString(), '2027-03-28T07:00:00.000Z');
});

test('délka dne při změně času je 25 h (podzim) a 23 h (jaro)', () => {
  const h = (a, b) => (time.dayStartUtc(b, TZ) - time.dayStartUtc(a, TZ)) / 3600_000;
  assert.equal(h('2026-10-25', '2026-10-26'), 25);
  assert.equal(h('2027-03-28', '2027-03-29'), 23);
  assert.equal(h('2026-10-27', '2026-10-28'), 24);
});

test('formátování českého data a času', () => {
  const d = time.localToUtc('2026-10-23', '14:30', TZ);
  assert.equal(time.formatTimeCs(d, TZ), '14:30');
  assert.match(time.formatDateCs(d, TZ), /pátek 23\. října 2026/);
  assert.equal(time.localDateStr(new Date('2026-10-24T22:30:00Z'), TZ), '2026-10-25'); // po půlnoci místního času
});

test('neplatná data se odmítnou', () => {
  assert.equal(time.parseDateStr('2026-02-30'), null);
  assert.equal(time.parseDateStr('abc'), null);
  assert.deepEqual(time.parseDateStr('2026-02-28'), { y: 2026, mo: 2, d: 28 });
});
