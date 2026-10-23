// Práce s časovými zónami bez externích knihoven (Intl). Správně zvládá přechod na letní/zimní čas.
const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(date, tz) {
  const parts = {};
  for (const p of dtf(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
    isoWeekday: WD[parts.weekday],
  };
}

export function tzOffsetMinutes(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Místní čas ve studiu → okamžik (Date). Při neexistujícím čase (jarní posun) se posune dopředu. */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(t), tz);
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

export const pad2 = (n) => String(n).padStart(2, '0');

export function localDateStr(date, tz) {
  const p = localParts(date, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function parseDateStr(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return { y, mo, d };
}

export function parseTimeStr(s) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s || '');
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return { h, mi };
}

export function addDaysStr(dateStr, n) {
  const { y, mo, d } = parseDateStr(dateStr);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

export function isoWeekdayOfDateStr(dateStr) {
  const { y, mo, d } = parseDateStr(dateStr);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0 = neděle
  return wd === 0 ? 7 : wd;
}

export function dayStartUtc(dateStr, tz) {
  const { y, mo, d } = parseDateStr(dateStr);
  return zonedToUtc(y, mo, d, 0, 0, tz);
}

/** 'HH:MM' v místním čase studia ve vybrané datum → Date */
export function localToUtc(dateStr, timeStr, tz) {
  const { y, mo, d } = parseDateStr(dateStr);
  const t = parseTimeStr(timeStr);
  if (t.h === 24) return zonedToUtc(y, mo, d + 1, 0, 0, tz);
  return zonedToUtc(y, mo, d, t.h, t.mi, tz);
}

export function formatTimeCs(date, tz) {
  const p = localParts(date, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function formatDateCs(date, tz) {
  return new Intl.DateTimeFormat('cs-CZ', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

export function formatDateTimeCs(date, tz) {
  return `${formatDateCs(date, tz)} v ${formatTimeCs(date, tz)}`;
}

export const addMinutes = (date, m) => new Date(date.getTime() + m * 60000);
