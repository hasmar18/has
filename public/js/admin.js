import { $, h, api, setCsrf, money, dur, WD } from './common.js';

const app = $('#app');
let TZ = 'Europe/Prague';
let me = null;
const toast = (t, bad) => { const el = h('div', { class: 'toast', role: 'status', style: false, text: t }); if (bad) el.style.setProperty('background', '#a3263d'); document.body.append(el); setTimeout(() => el.remove(), 3500); };
const fail = (e) => toast(e.message || 'Chyba', true);
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { fail(e); } };

// ---------- čas v časové zóně studia ----------
const fmt = (opts) => new Intl.DateTimeFormat('cs-CZ', { timeZone: TZ, ...opts });
function parts(d) { const o = {}; for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(d))) o[p.type] = p.value; return o; }
const ymd = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const hm = (d) => { const p = parts(d); return `${p.hour}:${p.minute}`; };
const offsetMs = (utcMs) => { const p = parts(utcMs); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(utcMs / 60000) * 60000; };
function localToUtc(date, time) { const [y, m, d] = date.split('-').map(Number); const [hh, mm] = (time || '00:00').split(':').map(Number); const guess = Date.UTC(y, m - 1, d, hh, mm); let t = guess - offsetMs(guess); t = guess - offsetMs(t); return new Date(t); }
const addDays = (date, n) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const wdOf = (date) => { const [y, m, d] = date.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; };
const mondayOf = (date) => addDays(date, -wdOf(date));
const dLabel = (date) => { const [y, m, d] = date.split('-').map(Number); return `${WD[wdOf(date)]} ${d}. ${m}.`; };
const dtLabel = (iso) => `${dLabel(ymd(iso))} ${hm(iso)}`;
const today = () => ymd(new Date());

// ---------- UI pomůcky ----------
function modal(title, content, { wide } = {}) {
  const close = () => { m.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const m = h('div', { class: 'modal', onclick: (e) => { if (e.target === m) close(); } }, h('div', { class: 'box', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('div', { class: 'row sp' }, h('h2', { text: title, style: false }), h('button', { class: 'btn ghost xs', onclick: close, 'aria-label': 'Zavřít' }, '✕')), content));
  document.addEventListener('keydown', esc); document.body.append(m); return { close, el: m };
}
const fld = (label, input, id) => [h('label', { for: id, text: label }), input];
const inp = (id, v = '', a = {}) => h('input', { id, value: v ?? '', ...a });
const sel = (id, opts, v) => h('select', { id }, opts.map(([val, t]) => h('option', { value: val, ...(String(val) === String(v) ? { selected: true } : {}) }, t)));
const chkbox = (id, label, on) => h('label', { class: 'check' }, h('input', { type: 'checkbox', id, ...(on ? { checked: true } : {}) }), h('span', { text: label }));
const status = { confirmed: ['Potvrzeno', ''], held: ['Čeká na ověření', 'warn'], cancelled: ['Zrušeno', 'bad'], completed: ['Proběhlo', 'good'], no_show: ['Nedostavila se', 'bad'] };
const pill = (s) => h('span', { class: `pill ${status[s]?.[1] || ''}`, text: status[s]?.[0] || s });

// ---------- přihlášení ----------
async function boot() {
  try { const r = await api('/api/auth/me'); if (r.user?.role === 'admin') { me = r.user; setCsrf(r.csrf_token); return shell(); } } catch {}
  loginView();
}
function loginView(note) {
  const err = h('div', { hidden: true, 'aria-live': 'polite' });
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true;
    try { const r = await api('/api/auth/login', { method: 'POST', body: { email: $('#e').value, password: $('#p').value } }); setCsrf(r.csrf_token);
      if (r.user.role !== 'admin') { await api('/api/auth/logout', { method: 'POST', body: {} }); throw new Error('Tento účet nemá přístup do administrace.'); }
      me = r.user; shell(); } catch (x) { err.replaceChildren(h('div', { class: 'alert err', text: x.message })); err.hidden = false; }
  } }, ...fld('E-mail', inp('e', '', { type: 'email', autocomplete: 'username', required: true }), 'e'), ...fld('Heslo', inp('p', '', { type: 'password', autocomplete: 'current-password', required: true }), 'p'), err, h('p', {}, h('button', { class: 'btn', type: 'submit' }, 'Přihlásit se')));
  app.replaceChildren(h('div', { class: 'wrap narrow', style: false }, h('div', { class: 'panel', style: false }, h('h1', { text: 'Administrace' }), note ? h('div', { class: 'alert info', text: note }) : '', f)));
  app.firstChild.style.setProperty('margin-top', '8vh');
}

// ---------- kostra a router ----------
const ROUTES = [['prehled', 'Přehled', dashboard], ['kalendar', 'Kalendář', calendarView], ['rezervace', 'Rezervace', bookingsView], ['sluzby', 'Služby', servicesView], ['doba', 'Doba rezervací', hoursView], ['galerie', 'Galerie', galleryView], ['obsah', 'Obsah webu', contentView], ['emaily', 'E-maily', emailsView], ['klientky', 'Klientky', clientsView], ['nastaveni', 'Nastavení', settingsView], ['protokol', 'Protokol změn', auditView]];
let mainEl;
function shell() {
  if (me.must_change_password) return forcePassword();
  const side = h('nav', { class: 'side', 'aria-label': 'Administrace' }, h('div', { class: 'brand', text: 'HASNAILS' }), ROUTES.map(([k, t]) => h('a', { href: `#/${k}`, 'data-k': k }, t)),
    h('a', { href: '/', target: '_blank' }, 'Zobrazit web ↗'), h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {}); setCsrf(null); me = null; loginView(); } }, 'Odhlásit'));
  mainEl = h('main', { class: 'main', id: 'main' });
  app.replaceChildren(h('div', { class: 'shell' }, side, mainEl));
  window.removeEventListener('hashchange', route); window.addEventListener('hashchange', route); route();
}
function forcePassword() {
  const f = h('form', { onsubmit: guard(async (e) => { e.preventDefault(); await api('/api/auth/change-password', { method: 'POST', body: { current_password: $('#c').value, new_password: $('#n').value } }); me.must_change_password = false; toast('Heslo změněno'); shell(); }) },
    ...fld('Současné (úvodní) heslo', inp('c', '', { type: 'password', required: true }), 'c'), ...fld('Nové heslo (min. 10 znaků)', inp('n', '', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), 'n'), h('p', {}, h('button', { class: 'btn', type: 'submit' }, 'Změnit heslo')));
  app.replaceChildren(h('div', { class: 'wrap narrow' }, h('div', { class: 'panel' }, h('h1', { text: 'Nastavte si vlastní heslo' }), h('p', { text: 'Úvodní heslo z nastavení serveru je nutné před dalším použitím změnit.' }), f)));
}
function route() {
  const [path, qs] = (location.hash.replace(/^#\/?/, '') || 'prehled').split('?');
  const r = ROUTES.find((x) => x[0] === path) || ROUTES[0];
  document.querySelectorAll('.side a[data-k]').forEach((a) => a.classList.toggle('on', a.dataset.k === r[0]));
  mainEl.replaceChildren(h('h1', { text: r[1] }), h('span', { class: 'spin' }));
  r[2](new URLSearchParams(qs || '')).catch((e) => { mainEl.replaceChildren(h('h1', { text: r[1] }), h('div', { class: 'alert err', text: e.status === 401 ? 'Platnost přihlášení vypršela – přihlaste se znovu.' : e.message })); if (e.status === 401) loginView('Platnost přihlášení vypršela.'); });
}
const page = (title, ...kids) => mainEl.replaceChildren(h('h1', { text: title }), ...kids);

// ---------- Přehled ----------
const OKL = { services: 'Služby zadány', prices: 'Ceny doplněny', hours: 'Dny a časy rezervací nastaveny', email: 'Odesílání e-mailů nastaveno', calendar: 'Kalendář propojen', calendar_write: 'Zápis do kalendáře nastaven', reviewed: 'Nastavení zkontrolováno', encryption: 'Šifrovací klíč nastaven', https: 'Adresa webu je https', enabled: 'Online rezervace zapnuty' };
async function dashboard() {
  const d = await api('/api/admin/dashboard');
  const s = d.stats;
  page('Přehled',
    d.calendar.degraded ? h('div', { class: 'alert err', role: 'alert' }, h('strong', { text: 'Synchronizace kalendáře nefunguje. ' }), 'Online rezervace jsou bezpečně pozastaveny, dokud se spojení neobnoví. ', d.calendar.stale.map((x) => `${x.name}: ${x.last_error || x.status}`).join('; '), ' ', h('a', { href: '#/nastaveni' }, 'Otevřít nastavení kalendáře')) : '',
    h('div', { class: 'grid2' }, [['Rezervace příštích 7 dní', s.upcoming_week, '#/rezervace'], ['Žádosti o změnu termínu', s.open_requests, '#/rezervace'], ['Neodeslané e-maily (7 dní)', s.failed_emails, '#/emaily'], ['Rozdíly s kalendářem', s.calendar_drift, '#/kalendar']].map(([t, n, href]) => h('a', { class: 'stat', href, style: false }, h('b', { text: n }), t))),
    h('div', { class: 'panel', style: false }, h('h2', { text: 'Kontrolní seznam spuštění' }), d.checklist.map((c) => h('div', { class: `chk ${c.ok ? 'ok' : c.optional ? 'opt' : 'bad'}` }, h('i', { text: c.ok ? '✔' : c.optional ? '○' : '✖' }), h('span', { text: c.ok ? (OKL[c.key] || 'Hotovo') : c.label })))),
    h('p', { class: 'small muted', text: d.online_booking_enabled ? 'Online rezervace jsou zapnuté.' : 'Online rezervace jsou VYPNUTÉ – veřejnost si zatím termín neobjedná.' }));
}

// ---------- Kalendář ----------
const cal = { mode: window.innerWidth < 700 ? 'day' : 'week', date: today() };
async function calendarView() {
  const s = await api('/api/admin/settings'); TZ = s.settings.timezone;
  const hours = await api('/api/admin/hours');
  const draw = guard(async () => {
    let first; let n;
    if (cal.mode === 'day') { first = cal.date; n = 1; } else if (cal.mode === 'week') { first = mondayOf(cal.date); n = 7; } else { const [y, m] = cal.date.split('-'); first = mondayOf(`${y}-${m}-01`); n = 42; }
    const data = await api(`/api/admin/calendar?from=${localToUtc(first, '00:00').toISOString()}&to=${localToUtc(addDays(first, n), '00:00').toISOString()}`);
    const step = (dir) => { cal.date = cal.mode === 'month' ? (() => { const [y, m] = cal.date.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10); })() : addDays(cal.date, dir * (cal.mode === 'week' ? 7 : 1)); draw(); };
    const modes = h('div', { class: 'tabs', style: false }, [['day', 'Den'], ['week', 'Týden'], ['month', 'Měsíc']].map(([k, t]) => h('button', { 'aria-selected': String(cal.mode === k), onclick: () => { cal.mode = k; draw(); } }, t)));
    const nav = h('div', { class: 'bar' }, h('button', { class: 'btn ghost sm', onclick: () => step(-1) }, '←'), h('button', { class: 'btn ghost sm', onclick: () => { cal.date = today(); draw(); } }, 'Dnes'), h('button', { class: 'btn ghost sm', onclick: () => step(1) }, '→'), modes,
      h('button', { class: 'btn sm', onclick: () => bookingForm(null, { date: cal.date }, draw) }, '+ Rezervace'), h('button', { class: 'btn ghost sm', onclick: () => blockForm(cal.date, draw) }, '+ Blokace'));
    const body = cal.mode === 'month' ? monthGrid(first, data, draw) : timeGrid(first, n, data, hours.hours, draw);
    const lg = h('p', { class: 'small muted' }, 'Legenda: ', h('span', { class: 'pill', text: 'rezervace' }), ' ', h('span', { class: 'pill warn', text: 'čeká na ověření' }), ' ', h('span', { class: 'pill', style: false, text: 'blokace' }), ' osobní události z propojeného kalendáře jsou modré.');
    page('Kalendář', nav, body, lg);
  });
  await draw();
}
const H0 = 7; const H1 = 21; const PX = 48;
function timeGrid(first, n, data, wh, draw) {
  const grid = h('div', { class: 'cal' }); grid.style.setProperty('grid-template-columns', `44px repeat(${n}, 1fr)`);
  grid.append(h('div', { class: 'hd' }));
  const days = Array.from({ length: n }, (_, i) => addDays(first, i));
  for (const d of days) grid.append(h('div', { class: `hd${d === today() ? ' today' : ''}`, text: dLabel(d) }));
  const gutter = h('div', { class: 'col' }); gutter.style.setProperty('height', `${(H1 - H0) * PX}px`);
  for (let hh = H0; hh < H1; hh += 1) { const l = h('div', { class: 'hr', text: `${hh}:00` }); l.style.setProperty('top', `${(hh - H0) * PX}px`); gutter.append(l); }
  grid.append(gutter);
  const place = (col, d, s, e, cls, label, onclick) => {
    const day0 = localToUtc(d, '00:00').getTime();
    const sm = Math.max((new Date(s).getTime() - day0) / 60000, H0 * 60); const em = Math.min((new Date(e).getTime() - day0) / 60000, H1 * 60);
    if (em <= sm) return; const el = h('div', { class: `ev ${cls}`, title: label, ...(onclick ? { tabindex: 0, role: 'button', onclick, onkeydown: (k) => { if (k.key === 'Enter') onclick(); } } : {}) }, label);
    el.style.setProperty('top', `${(sm - H0 * 60) / 60 * PX}px`); el.style.setProperty('height', `${Math.max((em - sm) / 60 * PX - 2, 16)}px`); col.append(el);
  };
  for (const d of days) {
    const col = h('div', { class: 'col', onclick: (e) => { if (e.target !== col) return; const y = e.offsetY; const mins = Math.round((y / PX * 60 + H0 * 60) / 15) * 15; bookingForm(null, { date: d, time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` }, draw); } });
    col.style.setProperty('height', `${(H1 - H0) * PX}px`);
    for (let hh = H0; hh < H1; hh += 1) { const l = h('div', { class: 'hr' }); l.style.setProperty('top', `${(hh - H0) * PX}px`); col.append(l); }
    // mimo pracovní dobu = šedě
    const wd = wdOf(d) + 1; const ranges = wh.filter((x) => x.weekday === wd);
    for (const x of data.external.filter((e) => ymd(e.starts_at) <= d && ymd(new Date(new Date(e.ends_at).getTime() - 1)) >= d)) place(col, d, x.starts_at, x.ends_at, 'ext', `${x.calendar_name}${x.blocking ? '' : ' (neblokuje)'}`);
    for (const b of data.blocks.filter((e) => ymd(e.starts_at) <= d && ymd(new Date(new Date(e.ends_at).getTime() - 1)) >= d)) place(col, d, b.starts_at, b.ends_at, 'blk', `Blokace${b.reason ? `: ${b.reason}` : ''}`, guard(async () => { if (!confirm('Smazat tuto blokaci?')) return; await api(`/api/admin/blocks/${b.id}`, { method: 'DELETE' }); draw(); }));
    for (const b of data.bookings.filter((e) => e.local_date === d)) place(col, d, b.starts_at, b.ends_at, `bk${b.held ? ' held' : ''}${b.status !== 'confirmed' && !b.held ? ' done' : ''}`, `${b.local_time} ${b.client_name} – ${b.service_name}${b.cal_drift ? ' ⚠' : ''}`, () => bookingForm(b.id, {}, draw));
    if (!ranges.length) col.style.setProperty('background', '#faf6f3');
    grid.append(col);
  }
  const wrap = h('div', { class: 'tblw' }, grid); grid.style.setProperty('min-width', n === 1 ? '0' : '760px'); return wrap;
}
function monthGrid(first, data, draw) {
  const g = h('div', { class: 'month' }); const [, mm] = cal.date.split('-');
  WD.forEach((w) => g.append(h('div', { class: 'hd', text: w })));
  for (let i = 0; i < 42; i += 1) {
    const d = addDays(first, i); const cnt = data.bookings.filter((b) => b.local_date === d && b.status === 'confirmed').length;
    g.append(h('div', { class: `c${d.slice(5, 7) !== mm ? ' o' : ''}`, tabindex: 0, role: 'button', onclick: () => { cal.mode = 'day'; cal.date = d; draw(); } }, h('b', { text: +d.slice(8) }), cnt ? h('span', { class: 'n', text: `${cnt}× rezervace` }) : ''));
  }
  return g;
}

// ---------- formuláře rezervace / blokace ----------
let SERVICES = [];
async function loadServices() { SERVICES = (await api('/api/admin/services')).services; return SERVICES; }
async function bookingForm(id, pre, done) {
  await loadServices().catch(() => {});
  let b = null; let detail = null;
  if (id) { detail = await api(`/api/admin/bookings/${id}`); b = detail.booking; }
  const d0 = b ? b.local_date : (pre.date || today()); const t0 = b ? b.local_time : (pre.time || '10:00');
  const svcSel = sel('b-svc', [['', '— vlastní / bez služby —'], ...SERVICES.filter((s) => s.is_active || s.id === b?.service_id).map((s) => [s.id, `${s.name} (${dur(s.duration_minutes)})`])], b?.service_id || '');
  const form = h('form', { novalidate: true },
    b ? h('p', {}, pill(b.status), ' ', b.cal_state ? '' : '') : '',
    h('div', { class: 'f2' }, h('div', {}, ...fld('Služba', svcSel, 'b-svc')), h('div', {}, ...fld('Název (bez služby)', inp('b-sname', b?.service_name || ''), 'b-sname')),
      h('div', {}, ...fld('Datum', inp('b-date', d0, { type: 'date', required: true }), 'b-date')), h('div', {}, ...fld('Začátek', inp('b-time', t0, { type: 'time', required: true }), 'b-time')),
      h('div', {}, ...fld('Délka (min)', inp('b-dur', b?.duration_minutes || '', { type: 'number', min: 5, max: 720 }), 'b-dur')), h('div', {}, ...fld('Cena (Kč)', inp('b-price', b?.price_czk ?? '', { type: 'number', min: 0 }), 'b-price')),
      h('div', {}, ...fld('Jméno', inp('b-name', b?.client_name || '', { required: true }), 'b-name')), h('div', {}, ...fld('Telefon', inp('b-phone', b?.client_phone || '', { type: 'tel' }), 'b-phone')),
      h('div', {}, ...fld('E-mail (pro potvrzení)', inp('b-email', b?.client_email || '', { type: 'email' }), 'b-email'))),
    ...fld('Poznámka klientky', h('textarea', { id: 'b-cnote' }, b?.client_note || ''), 'b-cnote'), ...fld('Interní poznámka (klientka ji nevidí)', h('textarea', { id: 'b-anote' }, b?.admin_note || ''), 'b-anote'),
    chkbox('b-notify', 'Poslat klientce e-mail o změně', true), h('div', { id: 'b-err', hidden: true }));
  const err = $('#b-err', form);
  const save = (force) => guard(async () => {
    err.hidden = true;
    const starts = localToUtc($('#b-date', form).value, $('#b-time', form).value).toISOString();
    const body = { starts_at: starts, name: $('#b-name', form).value, email: $('#b-email', form).value.trim(), phone: $('#b-phone', form).value.trim(), client_note: $('#b-cnote', form).value, admin_note: $('#b-anote', form).value, force: !!force, notify: $('#b-notify', form).checked };
    const dm = $('#b-dur', form).value; if (dm) body.duration_minutes = +dm; const pr = $('#b-price', form).value; if (pr !== '') body.price_czk = +pr;
    try {
      if (b) await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body });
      else { const sid = svcSel.value; if (sid) body.service_id = sid; else body.service_name = $('#b-sname', form).value || 'Rezervace'; if (!body.duration_minutes && !sid) body.duration_minutes = 60; await api('/api/admin/bookings', { method: 'POST', body }); }
      m.close(); toast('Uloženo'); done?.();
    } catch (e) {
      if (e.code === 'conflict_detected') { err.replaceChildren(h('div', { class: 'alert err' }, h('strong', { text: 'Kolize s jiným záznamem. ' }), (e.data.conflicts || []).map((c) => `${c.label || c.kind} (${dtLabel(c.starts_at)})`).join('; '), ' ', e.data.can_override ? h('button', { class: 'btn danger xs', type: 'button', onclick: save(true) }, 'Přesto uložit (vědomě přepsat)') : '')); err.hidden = false; } else throw e;
    }
  });
  const actions = h('div', { class: 'row', style: false }, h('button', { class: 'btn', type: 'button', onclick: save(false) }, 'Uložit'));
  if (b && b.client_email) actions.append(h('button', { class: 'btn ghost', type: 'button', onclick: () => { m.close(); repeatForm(b, done); } }, 'Zopakovat rezervaci'));
  if (b && b.status === 'confirmed') actions.append(h('button', { class: 'btn danger', type: 'button', onclick: guard(async () => { const reason = prompt('Důvod zrušení (uvidí ho klientka v e-mailu):', ''); if (reason === null) return; await api(`/api/admin/bookings/${b.id}/cancel`, { method: 'POST', body: { reason, notify: $('#b-notify', form).checked } }); m.close(); toast('Zrušeno'); done?.(); }) }, 'Zrušit rezervaci'),
    h('button', { class: 'btn ghost', type: 'button', onclick: guard(async () => { await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { status: 'completed', notify: false } }); m.close(); done?.(); }) }, 'Označit jako proběhlé'),
    h('button', { class: 'btn ghost', type: 'button', onclick: guard(async () => { await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { status: 'no_show', notify: false } }); m.close(); done?.(); }) }, 'Nedostavila se'));
  const extra = [];
  if (detail) {
    if (detail.calendar) extra.push(h('p', { class: 'small' }, 'Kalendář: ', h('span', { class: `pill ${detail.calendar.drift || detail.calendar.last_error ? 'bad' : 'good'}`, text: detail.calendar.drift === 'deleted_in_calendar' ? 'událost v kalendáři smazána' : detail.calendar.drift === 'time_changed_in_calendar' ? 'čas v kalendáři změněn' : detail.calendar.last_error ? 'chyba zápisu' : detail.calendar.state === 'synced' ? 'zapsáno' : detail.calendar.state }), ' ', h('button', { class: 'btn ghost xs', type: 'button', onclick: guard(async () => { await api(`/api/admin/bookings/${b.id}/resync`, { method: 'POST', body: {} }); toast('Zápis do kalendáře zařazen'); }) }, 'Znovu zapsat do kalendáře')));
    for (const r of detail.reschedule_requests.filter((x) => x.status === 'open')) extra.push(h('div', { class: 'alert info' }, h('strong', { text: 'Žádost klientky o změnu: ' }), r.message, ' ', h('button', { class: 'btn ghost xs', type: 'button', onclick: guard(async () => { await api(`/api/admin/reschedule-requests/${r.id}`, { method: 'PATCH', body: { status: 'done' } }); toast('Vyřízeno'); m.close(); done?.(); }) }, 'Označit jako vyřízenou')));
    extra.push(h('details', {}, h('summary', { text: 'Historie' }), detail.history.map((x) => h('div', { class: 'small', text: `${dtLabel(x.at)} · ${x.actor} · ${x.action}` }))));
  }
  const m = modal(b ? 'Rezervace' : 'Nová rezervace', h('div', {}, form, ...extra, actions));
}
function repeatForm(b, done) {
  const svcSel = sel('r-svc', [['', '— stejná jako původní —'], ...SERVICES.filter((s) => s.is_active).map((s) => [s.id, `${s.name} (${dur(s.duration_minutes)})`])], b.service_id || '');
  const form = h('form', { novalidate: true },
    h('p', { class: 'muted', text: `${b.client_name}${b.client_email ? ' · ' + b.client_email : ''}` }),
    h('div', { class: 'f2' }, h('div', {}, ...fld('Služba', svcSel, 'r-svc')), h('div', {}),
      h('div', {}, ...fld('Datum', inp('r-date', today(), { type: 'date', required: true }), 'r-date')), h('div', {}, ...fld('Začátek', inp('r-time', '10:00', { type: 'time', required: true }), 'r-time'))),
    h('div', { id: 'r-err' }));
  const go = (force) => guard(async () => {
    const body = { starts_at: localToUtc($('#r-date', form).value, $('#r-time', form).value).toISOString(), name: b.client_name, email: b.client_email || '', phone: b.client_phone || '', force: !!force, notify: true };
    if (svcSel.value) body.service_id = svcSel.value;
    else if (b.service_id) body.service_id = b.service_id;
    else { body.service_name = b.service_name; body.duration_minutes = b.duration_minutes; }
    try { await api('/api/admin/bookings', { method: 'POST', body }); m.close(); toast('Rezervace vytvořena, klientce odešlo potvrzení'); done?.(); }
    catch (e) {
      if (e.code === 'conflict_detected') $('#r-err', form).replaceChildren(h('div', { class: 'alert err' }, e.message, ' ', h('button', { class: 'btn danger xs', type: 'button', onclick: go(true) }, 'Přesto vytvořit')));
      else throw e;
    }
  });
  const m = modal('Zopakovat rezervaci', h('div', {}, form, h('p', { class: 'small muted', text: 'Klientce se odešle potvrzovací e-mail.' }), h('p', {}, h('button', { class: 'btn', type: 'button', onclick: go(false) }, 'Vytvořit'))));
}
function blockForm(date, done) {
  const form = h('form', {}, h('div', { class: 'f2' }, h('div', {}, ...fld('Datum', inp('k-date', date, { type: 'date' }), 'k-date')), h('div', {}), h('div', {}, ...fld('Od', inp('k-from', '09:00', { type: 'time' }), 'k-from')), h('div', {}, ...fld('Do', inp('k-to', '12:00', { type: 'time' }), 'k-to'))), ...fld('Důvod (vidíte jen vy)', inp('k-reason', ''), 'k-reason'), h('div', { id: 'k-err' }));
  const go = (force) => guard(async () => {
    try { await api('/api/admin/blocks', { method: 'POST', body: { starts_at: localToUtc($('#k-date', form).value, $('#k-from', form).value).toISOString(), ends_at: localToUtc($('#k-date', form).value, $('#k-to', form).value).toISOString(), reason: $('#k-reason', form).value, force } }); m.close(); toast('Blokace vytvořena'); done?.(); }
    catch (e) { if (e.code === 'conflict_detected') $('#k-err', form).replaceChildren(h('div', { class: 'alert err' }, e.message, ' ', h('button', { class: 'btn danger xs', type: 'button', onclick: go(true) }, 'Přesto vytvořit'))); else throw e; }
  });
  const m = modal('Soukromá blokace', h('div', {}, form, h('p', {}, h('button', { class: 'btn', onclick: go(false) }, 'Vytvořit'))));
}

// ---------- Rezervace (seznam) ----------
async function bookingsView() {
  await loadServices().catch(() => {});
  const f = { q: '', status: '', range: 'future' };
  const box = h('div', { class: 'panel tblw' });
  const load = guard(async () => {
    const p = new URLSearchParams(); if (f.q) p.set('q', f.q); if (f.status) p.set('status', f.status);
    if (f.range === 'future') p.set('from', new Date().toISOString()); if (f.range === 'past') p.set('to', new Date().toISOString());
    const { bookings } = await api(`/api/admin/bookings?${p}`);
    if (f.range === 'future') bookings.reverse();
    box.replaceChildren(bookings.length ? h('div', { class: 'bk-list' }, bookings.map((b) => h('div', { class: 'bk-card' },
      h('div', { class: 'bk-top' }, h('strong', { text: dtLabel(b.starts_at) }), pill(b.status), b.cal_drift ? h('span', { class: 'pill bad', text: 'rozdíl v kalendáři' }) : b.cal_error ? h('span', { class: 'pill bad', text: 'chyba kalendáře' }) : ''),
      h('div', { class: 'bk-name', text: b.client_name }), h('div', { class: 'small muted', text: b.service_name }),
      h('div', { class: 'small muted', text: [b.client_phone, b.client_email].filter(Boolean).join(' · ') }),
      h('div', { class: 'bk-btns' }, h('button', { class: 'btn ghost sm', onclick: () => bookingForm(b.id, {}, load) }, 'Detail'),
        b.client_email ? h('button', { class: 'btn sm', onclick: () => repeatForm(b, load) }, 'Zopakovat') : '')))) : h('p', { class: 'muted', text: 'Žádné rezervace.' }));
  });
  page('Rezervace', h('div', { class: 'bar stack' }, h('input', { type: 'search', placeholder: 'Hledat jméno, e-mail, telefon', 'aria-label': 'Hledat', oninput: (e) => { f.q = e.target.value; clearTimeout(bookingsView.t); bookingsView.t = setTimeout(load, 300); } }),
    h('select', { 'aria-label': 'Období', onchange: (e) => { f.range = e.target.value; load(); } }, [['future', 'Nadcházející'], ['past', 'Minulé'], ['all', 'Všechny']].map(([v, t]) => h('option', { value: v, text: t }))),
    h('select', { 'aria-label': 'Stav', onchange: (e) => { f.status = e.target.value; load(); } }, [['', 'Všechny stavy'], ['confirmed', 'Potvrzeno'], ['held', 'Čeká na ověření'], ['cancelled', 'Zrušeno'], ['completed', 'Proběhlo'], ['no_show', 'Nedostavila se']].map(([v, t]) => h('option', { value: v, text: t }))),
    h('button', { class: 'btn sm', onclick: () => bookingForm(null, {}, load) }, '+ Nová rezervace')), box);
  load();
}

// ---------- Služby ----------
async function servicesView() {
  const draw = guard(async () => {
    const { services, categories } = await api('/api/admin/services');
    const catName = (id) => categories.find((c) => c.id === id)?.name || '—';
    page('Služby',
      h('div', { class: 'alert info', text: 'Ceník ani služby nejsou předvyplněné – doplňte je podle skutečné nabídky. Služba označená „ověřeno“ znamená, že údaje potvrdila majitelka studia.' }),
      h('div', { class: 'bar' }, h('button', { class: 'btn sm', onclick: () => serviceForm(null, categories, draw) }, '+ Nová služba'), h('button', { class: 'btn ghost sm', onclick: guard(async () => { const n = prompt('Název nové kategorie:'); if (!n) return; await api('/api/admin/categories', { method: 'POST', body: { name: n, sort_order: categories.length } }); draw(); }) }, '+ Kategorie')),
      h('div', { class: 'panel' }, h('h2', { text: 'Kategorie' }), categories.length ? categories.map((c) => h('div', { class: 'row', style: false }, h('span', { text: c.name }), h('button', { class: 'btn ghost xs', onclick: guard(async () => { const n = prompt('Nový název:', c.name); if (!n) return; await api(`/api/admin/categories/${c.id}`, { method: 'PATCH', body: { name: n } }); draw(); }) }, 'Přejmenovat'), h('button', { class: 'btn ghost xs', onclick: guard(async () => { if (!confirm('Smazat kategorii? Služby zůstanou.')) return; await api(`/api/admin/categories/${c.id}`, { method: 'DELETE' }); draw(); }) }, 'Smazat'))) : h('p', { class: 'muted small', text: 'Zatím žádné.' })),
      h('div', { class: 'panel tblw' }, services.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Služba', 'Kategorie', 'Délka', 'Cena', 'Stav', ''].map((t) => h('th', { text: t })))), h('tbody', {}, services.map((s) => h('tr', {},
        h('td', {}, h('strong', { text: s.name }), s.description ? h('div', { class: 'small muted', text: s.description.slice(0, 90) }) : ''), h('td', { text: catName(s.category_id) }), h('td', { text: dur(s.duration_minutes) }), h('td', { text: s.price_czk == null ? 'neuvedeno' : `${s.price_from ? 'od ' : ''}${money(s.price_czk)}` }),
        h('td', {}, s.is_active ? h('span', { class: 'pill good', text: 'aktivní' }) : h('span', { class: 'pill', text: 'skrytá' }), ' ', s.is_verified ? '' : h('span', { class: 'pill warn', text: 'neověřeno' })),
        h('td', {}, h('button', { class: 'btn ghost xs', onclick: () => serviceForm(s, categories, draw) }, 'Upravit')))))) : h('p', { class: 'muted', text: 'Zatím žádné služby. Přidejte první tlačítkem nahoře.' })));
  });
  await draw();
}
async function serviceForm(s, categories, done) {
  try { window.__gallery = (await api('/api/admin/gallery')).images.filter((g) => !g.is_logo); } catch { window.__gallery = []; }
  const f = h('form', {}, ...fld('Název', inp('s-n', s?.name || '', { required: true }), 's-n'), ...fld('Popis (zobrazí se v ceníku)', h('textarea', { id: 's-d' }, s?.description || ''), 's-d'),
    h('div', { class: 'f2' }, h('div', {}, ...fld('Délka (minuty)', inp('s-m', s?.duration_minutes || 60, { type: 'number', min: 5, max: 720 }), 's-m')), h('div', {}, ...fld('Cena (Kč)', inp('s-p', s?.price_czk ?? '', { type: 'number', min: 0 }), 's-p')),
      h('div', {}, ...fld('Obrázek', sel('s-img', [['', '— výchozí ilustrace —'], ['/img/ilu-gellak.svg', 'Ilustrace: ruka – gellak'], ['/img/ilu-klasicka.svg', 'Ilustrace: ruka – klasická'], ['/img/ilu-pedikura.svg', 'Ilustrace: pedikúra'], ['/img/ilu-pedikura-gellak.svg', 'Ilustrace: pedikúra – gellak'], ['/img/ilu-combo.svg', 'Ilustrace: combo'], ...(s?.image_url && !/^\/img\/|^\/media\//.test(s.image_url) ? [[s.image_url, 'Aktuální ilustrační fotografie (Unsplash)']] : []), ...(window.__gallery || []).map((g) => [`/media/${g.id}`, `Fotka z galerie: ${g.alt || g.id.slice(0, 6)}`])], s?.image_url || ''), 's-img'), h('div', {}, ...fld('…nebo nahrát vlastní obrázek (JPEG/PNG/WebP, zmenší se automaticky)', h('input', { type: 'file', id: 's-file', accept: 'image/jpeg,image/png,image/webp' }), 's-file'))),
      h('div', {}, ...fld('Kategorie', sel('s-c', [['', '— bez kategorie —'], ...categories.map((c) => [c.id, c.name])], s?.category_id || ''), 's-c'))),
    chkbox('s-from', 'Cena „od“', s?.price_from), chkbox('s-a', 'Aktivní (nabízet při rezervaci)', s ? s.is_active : true), chkbox('s-v', 'Údaje ověřeny majitelkou', s?.is_verified), ...fld('Poznámka o zdroji údajů', inp('s-src', s?.source_note || ''), 's-src'));
  const save = guard(async () => {
    let imageUrl = $('#s-img', f).value || null;
    const up = $('#s-file', f).files[0];
    if (up) {
      const blob = await resizeImage(up, 1000);
      const r = await fetch(`/api/admin/gallery?hidden=1&alt=${encodeURIComponent($('#s-n', f).value)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'image/jpeg', 'x-csrf-token': sessionStorage.getItem('csrf') || '' }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || 'Nahrání obrázku se nezdařilo.');
      imageUrl = `/media/${j.id}`;
    }
    const body = { name: $('#s-n', f).value, description: $('#s-d', f).value, duration_minutes: +$('#s-m', f).value, price_czk: $('#s-p', f).value === '' ? null : +$('#s-p', f).value, price_from: $('#s-from', f).checked, category_id: $('#s-c', f).value || null, image_url: imageUrl, is_active: $('#s-a', f).checked, is_verified: $('#s-v', f).checked, source_note: $('#s-src', f).value || null };
    if (s) await api(`/api/admin/services/${s.id}`, { method: 'PATCH', body }); else await api('/api/admin/services', { method: 'POST', body });
    m.close(); toast('Uloženo'); done();
  });
  const m = modal(s ? 'Upravit službu' : 'Nová služba', h('div', {}, f, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: save }, 'Uložit'), s ? h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm('Službu archivovat? Dosavadní rezervace zůstanou beze změny.')) return; await api(`/api/admin/services/${s.id}`, { method: 'DELETE' }); m.close(); done(); }) }, 'Archivovat') : '')));
}

// ---------- Pracovní doba ----------
const WDN = ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];
async function hoursView() {
  const draw = guard(async () => {
    const { hours, exceptions } = await api('/api/admin/hours');
    const st = {}; for (let d = 1; d <= 7; d += 1) st[d] = hours.filter((x) => x.weekday === d).map((x) => ({ ...x }));
    const dayBox = h('div', {});
    const redraw = () => dayBox.replaceChildren(...WDN.map((n, i) => { const d = i + 1;
      return h('div', { class: 'panel' }, h('div', { class: 'row sp' }, h('strong', { text: n }), h('button', { class: 'btn ghost xs', onclick: () => { st[d].push({ weekday: d, start: st[d].length ? st[d].at(-1).end : '09:00', end: st[d].length ? '18:00' : '17:00' }); redraw(); } }, '+ Úsek')),
        st[d].length ? st[d].map((r, k) => h('div', { class: 'row' }, h('input', { type: 'time', value: r.start, 'aria-label': `${n} od`, style: false, onchange: (e) => { r.start = e.target.value; } }), '–', h('input', { type: 'time', value: r.end, 'aria-label': `${n} do`, onchange: (e) => { r.end = e.target.value; } }), h('button', { class: 'btn ghost xs', onclick: () => { st[d].splice(k, 1); redraw(); } }, 'Odebrat'))) : h('p', { class: 'muted small', text: 'Zavřeno. Neaktivní den = nelze rezervovat. Více úseků v jednom dni vytvoří pauzu mezi nimi (např. 9–12 a 13–17).' })); }));
    redraw();
    page('Doba rezervací',
      h('p', { class: 'muted', text: 'Zde nastavte, které dny a v jakých hodinách mohou klientky zadávat rezervace. Nikde na webu se nezobrazuje. Počáteční časy se nabízejí tak, aby služba skončila nejpozději na konci úseku.' }), dayBox,
      h('p', {}, h('button', { class: 'btn', onclick: guard(async () => { await api('/api/admin/hours', { method: 'PUT', body: { hours: Object.values(st).flat().map((x) => ({ weekday: x.weekday, start: x.start, end: x.end })) } }); toast('Uloženo'); }) }, 'Uložit dny a časy')),
      h('div', { class: 'panel' }, h('h2', { text: 'Dovolená, volno a mimořádné termíny' }), h('div', { class: 'bar' }, h('button', { class: 'btn sm', onclick: () => exceptionForm('closed', draw) }, '+ Zavřeno (dovolená, svátek)'), h('button', { class: 'btn ghost sm', onclick: () => exceptionForm('open', draw) }, '+ Mimořádné hodiny')),
        exceptions.length ? h('table', { class: 'tbl' }, h('tbody', {}, exceptions.map((x) => h('tr', {}, h('td', { text: x.date_from === x.date_to ? x.date_from : `${x.date_from} – ${x.date_to}` }), h('td', { text: x.kind === 'closed' ? 'Zavřeno' : `Otevřeno ${x.start}–${x.end}` }), h('td', { text: x.note || '' }), h('td', {}, h('button', { class: 'btn ghost xs', onclick: guard(async () => { await api(`/api/admin/exceptions/${x.id}`, { method: 'DELETE' }); draw(); }) }, 'Smazat')))))) : h('p', { class: 'muted small', text: 'Žádné výjimky.' })));
  });
  await draw();
}
function exceptionForm(kind, done) {
  const f = h('form', {}, h('div', { class: 'f2' }, h('div', {}, ...fld(kind === 'closed' ? 'Od data' : 'Datum', inp('x-f', today(), { type: 'date' }), 'x-f')), kind === 'closed' ? h('div', {}, ...fld('Do data', inp('x-t', today(), { type: 'date' }), 'x-t')) : h('div', {}),
    ...(kind === 'open' ? [h('div', {}, ...fld('Od', inp('x-s', '09:00', { type: 'time' }), 'x-s')), h('div', {}, ...fld('Do', inp('x-e', '17:00', { type: 'time' }), 'x-e'))] : [])), ...fld('Poznámka', inp('x-n', ''), 'x-n'));
  const m = modal(kind === 'closed' ? 'Zavřeno' : 'Mimořádné hodiny', h('div', {}, f, h('p', {}, h('button', { class: 'btn', onclick: guard(async () => {
    const date_from = $('#x-f', f).value; const body = { kind, date_from, date_to: kind === 'closed' ? $('#x-t', f).value : date_from, note: $('#x-n', f).value };
    if (kind === 'open') { body.start = $('#x-s', f).value; body.end = $('#x-e', f).value; }
    const r = await api('/api/admin/exceptions', { method: 'POST', body }); m.close(); toast(r.affected_bookings ? `Uloženo. Pozor: v tomto období už je ${r.affected_bookings} potvrzených rezervací – zůstávají beze změny.` : 'Uloženo'); done();
  }) }, 'Uložit'))));
}

// ---------- Galerie ----------
async function resizeImage(file, max = 1600) {
  const bmp = await createImageBitmap(file); const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Obrázek se nepodařilo zpracovat.'))), 'image/jpeg', 0.85));
}
async function galleryView() {
  const draw = guard(async () => {
    const { images } = await api('/api/admin/gallery');
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, 'aria-label': 'Vybrat fotografie' });
    page('Galerie', h('p', { class: 'muted', text: 'Nahrajte vlastní fotografie. Zmenšují se automaticky. Logo: nahrajte profilovou fotku z Instagramu a u fotky zvolte „Použít jako logo“ (do galerie na webu se pak nezobrazí). Fotografie z cizích zdrojů (např. Instagramu) nahrávejte jen se svolením autora.' }),
      h('div', { class: 'bar' }, file, h('button', { class: 'btn sm', onclick: guard(async () => {
        for (const f of file.files) { const blob = await resizeImage(f); const alt = prompt(`Popis fotografie ${f.name} (pro nevidomé, nepovinné):`, '') || '';
          const r = await fetch(`/api/admin/gallery?alt=${encodeURIComponent(alt)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'image/jpeg', 'x-csrf-token': sessionStorage.getItem('csrf') || '' }, body: blob });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || 'Nahrání se nezdařilo.'); }
        toast('Nahráno'); draw(); }) }, 'Nahrát')),
      images.length ? h('div', { class: 'thumbs' }, images.map((i) => h('div', { class: 't' }, h('img', { src: `/media/${i.id}`, alt: i.alt || '' }), h('div', { class: 'small', text: i.alt || '(bez popisu)' }),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost xs', onclick: guard(async () => { await api(`/api/admin/gallery/${i.id}`, { method: 'PATCH', body: { is_visible: !i.is_visible } }); draw(); }) }, i.is_visible ? 'Skrýt' : 'Zobrazit'),
          h('button', { class: 'btn ghost xs', onclick: guard(async () => { await api(`/api/admin/gallery/${i.id}`, { method: 'PATCH', body: { is_logo: !i.is_logo } }); toast(i.is_logo ? 'Logo odebráno' : 'Nastaveno jako logo'); draw(); }) }, i.is_logo ? '★ Je logo (zrušit)' : 'Použít jako logo'),
          h('button', { class: 'btn ghost xs', onclick: guard(async () => { const a = prompt('Popis:', i.alt || ''); if (a === null) return; await api(`/api/admin/gallery/${i.id}`, { method: 'PATCH', body: { alt: a } }); draw(); }) }, 'Popis'),
          h('button', { class: 'btn ghost xs', onclick: guard(async () => { if (!confirm('Smazat fotografii?')) return; await api(`/api/admin/gallery/${i.id}`, { method: 'DELETE' }); draw(); }) }, 'Smazat'))))) : h('p', { class: 'muted', text: 'Galerie je prázdná.' }));
  });
  await draw();
}

// ---------- Obsah webu ----------
function pricelistPanel(content) {
  const cur = /^[0-9a-f-]{36}$/.test(content.pricelist_image || '') ? content.pricelist_image : '';
  const img = h('img', { src: cur ? `/media/${cur}` : '/img/cenik.jpg', alt: 'Aktuální ceník', style: 'max-width:200px;width:100%;border-radius:10px;border:1px solid var(--line,#ddd)' });
  const file = h('input', { type: 'file', accept: 'image/*', id: 'pl-file' });
  const save = h('button', { class: 'btn', onclick: guard(async () => {
    const f = file.files[0]; if (!f) throw new Error('Vyberte obrázek ceníku.');
    const blob = await resizeImage(f, 2000);
    const r = await fetch('/api/admin/gallery?hidden=1&alt=Cen%C3%ADk', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'image/jpeg', 'x-csrf-token': sessionStorage.getItem('csrf') || '' }, body: blob });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || 'Nahrání se nezdařilo.');
    await api('/api/admin/content', { method: 'PUT', body: { pricelist_image: j.id || j.image?.id } });
    if (cur) { try { await api(`/api/admin/gallery/${cur}`, { method: 'DELETE' }); } catch { /* starý obrázek může chybět */ } }
    toast('Ceník nahrán'); contentView();
  }) }, 'Nahrát nový ceník');
  const reset = cur ? h('button', { class: 'btn ghost', onclick: guard(async () => {
    await api('/api/admin/content', { method: 'PUT', body: { pricelist_image: '' } });
    try { await api(`/api/admin/gallery/${cur}`, { method: 'DELETE' }); } catch { /* ignore */ }
    toast('Vrácen původní ceník'); contentView();
  }) }, 'Vrátit původní') : '';
  return h('div', { class: 'panel' }, h('h3', { text: 'Ceník (obrázek na stránce Ceník)' }),
    h('p', { class: 'muted', text: 'Nahrajte fotku nebo obrázek ceníku. Nahradí ten stávající.' }), img, h('div', { class: 'row' }, file, save, reset));
}
async function contentView() {
  const { content, fields } = await api('/api/admin/content');
  const inputs = {};
  page('Obsah webu', h('p', { class: 'muted', text: 'Texty na webu. Právní texty (podmínky, ochrana údajů) jsou jen výchozí šablona – nechte je před spuštěním zkontrolovat.' }),
    pricelistPanel(content),
    h('div', { class: 'panel' }, fields.filter((f) => f.key !== 'pricelist_image').map((f) => { inputs[f.key] = f.multiline ? h('textarea', { id: `c-${f.key}`, class: f.key.endsWith('_text') && f.multiline ? 'big' : '' }, content[f.key] || '') : inp(`c-${f.key}`, content[f.key] || ''); return h('div', {}, ...fld(f.label, inputs[f.key], `c-${f.key}`)); })),
    h('p', {}, h('button', { class: 'btn', onclick: guard(async () => { const patch = {}; for (const f of fields.filter((x) => x.key !== 'pricelist_image')) if (inputs[f.key].value !== (content[f.key] || '')) patch[f.key] = inputs[f.key].value; await api('/api/admin/content', { method: 'PUT', body: patch }); toast('Uloženo'); contentView(); }) }, 'Uložit texty')));
}

// ---------- E-maily ----------
async function emailsView() {
  const [{ templates, vars, provider_configured, reminder_hours_before }, log] = await Promise.all([api('/api/admin/email/templates'), api('/api/admin/email/log')]);
  page('E-maily',
    provider_configured ? '' : h('div', { class: 'alert err' }, 'Odesílání e-mailů není nakonfigurováno (proměnné BREVO_API_KEY a MAIL_FROM_EMAIL). Dokud nebudou nastaveny, e-maily se neodesílají.'),
    h('div', { class: 'panel' }, h('h2', { text: 'Šablony' }), h('details', {}, h('summary', { class: 'small', text: 'Dostupné proměnné' }), Object.entries(vars).map(([k, d]) => h('div', { class: 'small', text: `{{${k}}} – ${d}` }))), templates.map((t) => h('div', { class: 'row sp', style: false }, h('span', {}, t.label, ' ', t.customized ? h('span', { class: 'pill', text: 'upraveno' }) : '', t.enabled ? '' : h('span', { class: 'pill warn', text: 'vypnuto' })), h('span', {}, h('button', { class: 'btn ghost xs', onclick: () => templateForm(t) }, 'Upravit'), ' ', h('button', { class: 'btn ghost xs', onclick: guard(async () => { await api('/api/admin/email/test', { method: 'POST', body: { template_key: t.key } }); toast(`Zkušební e-mail zařazen k odeslání na ${me.email}`); }) }, 'Poslat zkušební'))))),
    h('div', { class: 'panel tblw' }, h('h2', { text: 'Odeslané a neodeslané zprávy' }), log.emails.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Kdy', 'Komu', 'Předmět', 'Stav', ''].map((t) => h('th', { text: t })))), h('tbody', {}, log.emails.map((e) => h('tr', {}, h('td', { text: dtLabel(e.created_at) }), h('td', { text: e.to_email }), h('td', { text: e.subject }),
      h('td', {}, h('span', { class: `pill ${['sent', 'delivered'].includes(e.status) ? 'good' : ['failed', 'bounced'].includes(e.status) ? 'bad' : 'warn'}`, text: e.status }), e.last_error ? h('div', { class: 'small muted', text: e.last_error }) : ''),
      h('td', {}, e.retryable && ['failed', 'skipped'].includes(e.status) ? h('button', { class: 'btn ghost xs', onclick: guard(async () => { await api(`/api/admin/email/log/${e.id}/retry`, { method: 'POST', body: {} }); toast('Zařazeno k odeslání'); emailsView(); }) }, 'Odeslat znovu') : ''))))) : h('p', { class: 'muted', text: 'Zatím nic.' })));
}
function templateForm(t) {
  const f = h('form', {}, chkbox('t-en', 'Posílat tento e-mail', t.enabled), ...fld('Předmět', inp('t-s', t.subject), 't-s'), ...fld('Text', h('textarea', { id: 't-b', class: 'big' }, t.body), 't-b'));
  const m = modal(t.label, h('div', {}, f, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: guard(async () => { await api(`/api/admin/email/templates/${t.key}`, { method: 'PUT', body: { subject: $('#t-s', f).value, body: $('#t-b', f).value, enabled: $('#t-en', f).checked } }); m.close(); toast('Uloženo'); emailsView(); }) }, 'Uložit'), h('button', { class: 'btn ghost', onclick: guard(async () => { if (!confirm('Vrátit výchozí znění?')) return; await api(`/api/admin/email/templates/${t.key}/reset`, { method: 'POST', body: {} }); m.close(); emailsView(); }) }, 'Výchozí znění'))));
}

// ---------- Klientky / protokol ----------
async function clientsView() {
  const { clients } = await api('/api/admin/clients');
  page('Klientky', h('div', { class: 'panel tblw' }, clients.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Jméno', 'E-mail', 'Telefon', 'Rezervací', 'Poslední návštěva'].map((t) => h('th', { text: t })))), h('tbody', {}, clients.map((c) => h('tr', {}, h('td', { text: c.name }), h('td', { text: c.email }), h('td', { text: c.phone }), h('td', { text: c.bookings }), h('td', { text: dtLabel(c.last_visit) }))))) : h('p', { class: 'muted', text: 'Zatím žádné.' })));
}
async function auditView() {
  const { entries } = await api('/api/admin/audit');
  page('Protokol změn', h('div', { class: 'panel tblw' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Kdy', 'Kdo', 'Akce', 'Detail'].map((t) => h('th', { text: t })))), h('tbody', {}, entries.map((e) => h('tr', {}, h('td', { text: dtLabel(e.at) }), h('td', { text: e.actor || 'systém' }), h('td', { text: e.action }), h('td', { class: 'small', text: e.details ? JSON.stringify(e.details).slice(0, 160) : '' })))))));
}

// ---------- Nastavení (obecné, kalendář, Instagram) ----------
const SET_FIELDS = [['online_booking_enabled', 'Online rezervace zapnuté', 'bool'], ['slot_interval_minutes', 'Krok nabízených časů (minuty)', 'num'], ['buffer_minutes', 'Rezerva mezi klientkami (minuty)', 'num'], ['min_notice_hours', 'Nejkratší předstih rezervace (hodiny)', 'num'], ['max_advance_days', 'Nejdále dopředu (dny)', 'num'], ['cancel_hours_before', 'Zrušit online lze nejpozději (hodin předem)', 'num'], ['require_email_verification', 'Vyžadovat ověření e-mailu kódem před potvrzením rezervace (vypnuto = rezervace se potvrdí hned)', 'bool'], ['hold_minutes', 'Platnost čekající rezervace při ověření (minuty)', 'num'], ['reminder_hours_before', 'Upomínky (hodin před termínem, oddělte čárkou; prázdné = žádné)', 'list'], ['admin_alert_email', 'E-mail pro upozornění správce (jinak e-mail správce)', 'text'], ['fail_closed', 'Při výpadku synchronizace kalendáře pozastavit online rezervace (doporučeno)', 'bool'], ['retention_months', 'Uchovávat údaje o rezervacích (měsíce)', 'num'], ['settings_reviewed', 'Potvrzuji, že jsem nastavení a právní texty zkontrolovala', 'bool']];
async function settingsView(qs) {
  const [{ settings, theme_presets }, cc, ig] = await Promise.all([api('/api/admin/settings'), api('/api/admin/calendar-connections'), api('/api/admin/instagram')]);
  const ctl = {};
  const rows = SET_FIELDS.map(([k, label, t]) => {
    if (t === 'bool') { ctl[k] = h('input', { type: 'checkbox', id: `s-${k}`, ...(settings[k] ? { checked: true } : {}) }); return h('label', { class: 'check' }, ctl[k], h('span', { text: label })); }
    ctl[k] = inp(`s-${k}`, t === 'list' ? (settings[k] || []).join(', ') : settings[k], { type: t === 'num' ? 'number' : 'text', step: 'any' }); return h('div', {}, ...fld(label, ctl[k], `s-${k}`));
  });
  const calMsg = qs?.get('kalendar_chyba') ? h('div', { class: 'alert err', text: qs.get('kalendar_chyba') }) : qs?.get('kalendar') ? h('div', { class: 'alert ok', text: 'Kalendář byl propojen. Vyberte níže, které kalendáře blokují termíny a kam se zapisují rezervace.' }) : '';
  page('Nastavení', calMsg,
    h('div', { class: 'panel' }, h('h2', { text: 'Obecné' }), ...rows, h('p', {}, h('button', { class: 'btn', onclick: guard(async () => {
      const body = {}; for (const [k, , t] of SET_FIELDS) { const el = ctl[k]; body[k] = t === 'bool' ? el.checked : t === 'num' ? +el.value : t === 'list' ? el.value.split(',').map((x) => x.trim()).filter(Boolean).map(Number) : el.value.trim(); }
      await api('/api/admin/settings', { method: 'PUT', body }); toast('Nastavení uloženo'); }) }, 'Uložit nastavení'))),
    appearancePanel(settings),
    calendarPanel(cc), instagramPanel(ig));
}
function appearancePanel(settings) {
  const DEF = { light: '#8c5a68', dark: '#9a6174' };
  const custom = { light: settings.theme_light_custom || '', dark: settings.theme_dark_custom || '' };
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contrastWhite = (hex) => 1.05 / (lum(hex) + 0.05);
  const rows = h('div', {});
  const draw = () => rows.replaceChildren(...[['light', 'Světlý režim'], ['dark', 'Tmavý režim (výchozí na webu)']].map(([mode, label]) => {
    const cur = custom[mode] || DEF[mode];
    const picker = h('input', { type: 'color', value: cur, 'aria-label': `Barva – ${label}`, style: 'width:56px;height:56px;padding:0;border:0;background:none;cursor:pointer',
      onchange: (e) => { custom[mode] = e.target.value; draw(); } });
    return h('div', { style: 'margin:14px 0' },
      h('strong', { text: label }),
      h('div', { class: 'row', style: 'gap:12px;margin-top:8px;align-items:center;flex-wrap:wrap' },
        h('span', { style: 'display:inline-block;border-radius:50%;overflow:hidden;width:56px;height:56px;box-shadow:0 0 0 1px rgba(0,0,0,.25)' }, picker),
        h('span', { class: 'small muted', text: custom[mode] ? custom[mode].toUpperCase() : 'výchozí (růžová)' }),
        custom[mode] ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { custom[mode] = ''; draw(); } }, 'Vrátit výchozí') : ''),
      custom[mode] && contrastWhite(custom[mode]) < 3 ? h('p', { class: 'small', style: 'color:#a3263d;margin:6px 0 0', text: 'Tahle barva je příliš světlá – bílý text na tlačítkách bude špatně čitelný. Zvolte tmavší nebo sytější.' }) : '');
  }));
  draw();
  return h('div', { class: 'panel' }, h('h2', { text: 'Barvy webu' }),
    h('p', { class: 'muted small', text: 'Kliknutím na barevné kolečko vyberete libovolnou barvu tlačítek, odkazů a zvýraznění. Platí pro veřejný web (ne pro administraci), zvlášť pro světlý a tmavý režim.' }), rows,
    h('p', {}, h('button', { class: 'btn', onclick: guard(async () => { await api('/api/admin/settings', { method: 'PUT', body: { theme_light_custom: custom.light, theme_dark_custom: custom.dark } }); toast('Barvy uloženy – na webu se projeví po obnovení stránky'); }) }, 'Uložit barvy')));
}
function calendarPanel(cc) {
  const reload = () => settingsView();
  const g = cc.providers.find((p) => p.name === 'google'); const ms = cc.providers.find((p) => p.name === 'microsoft');
  const googleHas = cc.connections.some((c) => c.provider === 'google');
  const wizard = h('div', { id: 'g-wizard' });
  const drawWizard = async () => {
    const o = await api('/api/admin/calendar-oauth');
    const done = o.google.configured;
    wizard.replaceChildren(
      h('div', { class: 'row sp' }, h('strong', { text: 'Google Kalendář' }), done ? h('span', { class: 'pill good', text: 'připraveno k propojení' }) : h('span', { class: 'pill warn', text: 'vyžaduje jednorázové nastavení' })),
      done ? '' : h('div', {},
        h('p', { class: 'small', text: 'Google nedovoluje propojit kalendář bez vlastní „aplikace“ – její vytvoření je zdarma a stačí ho udělat jednou (cca 10 minut):' }),
        h('ol', { class: 'small' },
          h('li', {}, 'Otevřete ', h('a', { href: 'https://console.cloud.google.com/projectcreate', target: '_blank', rel: 'noopener' }, 'Google Cloud Console → nový projekt'), ' a vytvořte projekt (název libovolný).'),
          h('li', {}, 'Zapněte ', h('a', { href: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', target: '_blank', rel: 'noopener' }, 'Google Calendar API'), ' (tlačítko Enable).'),
          h('li', {}, 'V ', h('a', { href: 'https://console.cloud.google.com/auth/overview', target: '_blank', rel: 'noopener' }, 'Google Auth platform'), ' nastavte název aplikace, váš e-mail, typ „External“, přidejte scope pro Kalendář a ', h('strong', { text: 'aplikaci publikujte do produkce (Publish app)' }), ' – jinak přístup po 7 dnech vyprší.'),
          h('li', {}, 'V ', h('a', { href: 'https://console.cloud.google.com/auth/clients', target: '_blank', rel: 'noopener' }, 'Clients'), ' vytvořte „OAuth client ID“ typu Web application a jako Authorized redirect URI zadejte přesně: ', h('code', { text: o.redirect_uris.google })),
          h('li', {}, 'Zkopírujte Client ID a Client secret sem:')),
        h('div', { class: 'f2' }, h('div', {}, ...fld('Client ID', inp('g-id', '', { autocomplete: 'off' }), 'g-id')), h('div', {}, ...fld('Client secret', inp('g-secret', '', { type: 'password', autocomplete: 'off' }), 'g-secret'))),
        h('p', {}, h('button', { class: 'btn sm', onclick: guard(async () => { await api('/api/admin/calendar-oauth/google', { method: 'PUT', body: { client_id: $('#g-id').value, client_secret: $('#g-secret').value } }); toast('Uloženo'); reload(); }) }, 'Uložit'))),
      done ? h('div', { class: 'row' }, h('button', { class: 'btn', onclick: guard(async () => { const r = await api('/api/admin/calendar/connect', { method: 'POST', body: { provider: 'google' } }); location.href = r.url; }) }, googleHas ? 'Propojit další Google účet' : 'Propojit Google Kalendář'),
        o.google.source === 'admin' ? h('button', { class: 'btn ghost sm', onclick: guard(async () => { if (!confirm('Smazat uložené údaje aplikace? Již propojené kalendáře přestanou fungovat.')) return; await api('/api/admin/calendar-oauth/google', { method: 'PUT', body: { client_id: '', client_secret: '' } }); reload(); }) }, 'Změnit údaje aplikace') : h('span', { class: 'small muted', text: 'Údaje jsou nastaveny na serveru.' })) : '');
  };
  drawWizard().catch(fail);
  return h('div', { class: 'panel' }, h('h2', { text: 'Kalendář' }),
    h('p', { class: 'muted small', text: 'Propojením se osobní události v kalendáři stanou blokacemi termínů (klientky se o nich nedozví) a nové rezervace se do vybraného kalendáře zapíší. Změny se načítají každé 2 minuty.' }),
    wizard,
    ms && ms.configured ? h('div', { class: 'bar' }, h('button', { class: 'btn ghost sm', onclick: guard(async () => { const r = await api('/api/admin/calendar/connect', { method: 'POST', body: { provider: 'microsoft' } }); location.href = r.url; }) }, 'Propojit Outlook / Microsoft 365')) : h('p', { class: 'small muted', text: 'Outlook / Microsoft 365: dostupné po nastavení MS_CLIENT_ID a MS_CLIENT_SECRET na serveru (viz README).' }),
    cc.unsupported.map((u) => h('p', { class: 'small muted' }, h('strong', { text: `${u.label}: ` }), u.reason)),
    cc.connections.length ? h('h3', { text: 'Propojené kalendáře' }) : h('p', { class: 'muted', text: 'Žádný kalendář zatím není propojen.' }),
    cc.connections.map((c) => connectionBox(c, reload)));
}
function connectionBox(c, reload) {
  const stateTxt = { active: ['aktivní', 'good'], error: ['chyba synchronizace', 'bad'], needs_reauth: ['vyžaduje znovu přihlášení', 'bad'] }[c.status] || [c.status, 'warn'];
  const srcSel = {}; const box = h('div', { class: 'panel', style: false });
  const list = h('div', {}, c.sources.map((s) => { srcSel[s.external_calendar_id] = { b: h('input', { type: 'checkbox', ...(s.blocks_availability ? { checked: true } : {}) }), a: h('input', { type: 'checkbox', ...(s.block_all_day ? { checked: true } : {}) }) };
    return h('div', { class: 'row', style: false }, h('strong', { text: s.name || s.external_calendar_id }), h('label', { class: 'check' }, srcSel[s.external_calendar_id].b, h('span', { text: 'blokuje termíny' })), h('label', { class: 'check' }, srcSel[s.external_calendar_id].a, h('span', { text: 'i celodenní události' })),
      h('span', { class: 'small muted', text: s.last_synced_at ? `synchronizováno ${dtLabel(s.last_synced_at)}` : 'zatím nesynchronizováno' }), s.last_error ? h('span', { class: 'pill bad', text: s.last_error.slice(0, 80) }) : ''); }));
  const writeSel = sel(`w-${c.id}`, [['', '— nezapisovat —'], ...c.sources.map((s) => [s.external_calendar_id, s.name || s.external_calendar_id])], c.write_enabled ? c.write_calendar_id : '');
  box.append(h('div', { class: 'row sp' }, h('strong', { text: `${c.label} · ${c.account_email}` }), h('span', { class: `pill ${stateTxt[1]}`, text: stateTxt[0] })),
    h('p', { class: 'small muted', text: `Poslední úspěšná synchronizace: ${c.last_success_at ? dtLabel(c.last_success_at) : 'dosud žádná'}${c.last_error ? ` · poslední chyba: ${c.last_error}` : ''}` }), list,
    ...fld('Zapisovat nové rezervace do kalendáře', writeSel, `w-${c.id}`),
    h('div', { class: 'row', style: false }, h('button', { class: 'btn sm', onclick: guard(async () => {
      const sources = c.sources.map((s) => ({ external_calendar_id: s.external_calendar_id, name: s.name, blocks_availability: srcSel[s.external_calendar_id].b.checked, block_all_day: srcSel[s.external_calendar_id].a.checked }));
      const wid = writeSel.value; await api(`/api/admin/calendar-connections/${c.id}`, { method: 'PUT', body: { sources, write_enabled: !!wid, write_calendar_id: wid || null, write_calendar_name: wid ? (c.sources.find((s) => s.external_calendar_id === wid)?.name || '') : null } }); toast('Uloženo'); reload(); }) }, 'Uložit výběr'),
      h('button', { class: 'btn ghost sm', onclick: guard(async () => { const r = await api(`/api/admin/calendar-connections/${c.id}/sync`, { method: 'POST', body: {} }); toast(r.results.every((x) => !x.error) ? 'Synchronizováno' : `Chyba: ${r.results.find((x) => x.error).error}`, r.results.some((x) => x.error)); reload(); }) }, 'Synchronizovat ihned'),
      c.status !== 'active' ? h('button', { class: 'btn ghost sm', onclick: guard(async () => { const r = await api('/api/admin/calendar/connect', { method: 'POST', body: { provider: c.provider } }); location.href = r.url; }) }, 'Znovu autorizovat') : '',
      h('button', { class: 'btn danger sm', onclick: guard(async () => { if (!confirm('Odpojit kalendář? Blokace z něj přestanou platit (už vytvořené události zůstanou v kalendáři).')) return; await api(`/api/admin/calendar-connections/${c.id}`, { method: 'DELETE' }); toast('Odpojeno'); reload(); }) }, 'Odpojit')));
  return box;
}
function instagramPanel(ig) {
  const t = inp('ig-t', '', { type: 'password', autocomplete: 'off', placeholder: ig.configured ? '(token je nastaven – vložením nového ho nahradíte)' : 'Vložte přístupový token Instagram API' });
  return h('div', { class: 'panel' }, h('h2', { text: 'Instagram' }), h('p', { class: 'small muted', text: 'Zobrazení příspěvků používá pouze oficiální Instagram API (účet musí být profesionální a token vygenerován v Meta aplikaci). Bez tokenu se na webu zobrazí jen odkaz na profil a fotografie z galerie.' }),
    ...fld('Přístupový token', t, 'ig-t'), h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: guard(async () => { await api('/api/admin/instagram', { method: 'PUT', body: { access_token: t.value } }); toast('Uloženo'); settingsView(); }) }, 'Uložit token'), ig.configured ? h('button', { class: 'btn ghost sm', onclick: guard(async () => { await api('/api/admin/instagram', { method: 'PUT', body: { access_token: '' } }); settingsView(); }) }, 'Odebrat token') : ''));
}

boot();
