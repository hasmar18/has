import { $, h, api, initPage, serviceCard, money, dur, dateCs, dateParts, WD, showErr, clear, setCsrf, telHref } from './common.js';
const boot = await initPage('/rezervace');
const view = $('#view'); const msg = $('#msg');
const st = { svc: null, day: null, slot: null, days: [], from: null, user: null, booking: null };
const setStep = (n) => $('#steps').querySelectorAll('li').forEach((li, i) => { li.className = i === n ? 'on' : i < n ? 'done' : ''; li.toggleAttribute('aria-current', i === n); });
const contactBox = () => h('p', { class: 'small muted' }, 'Potřebujete poradit? Zavolejte na ', h('a', { href: telHref(boot?.content.contact_phone) }, boot?.content.contact_phone || ''), '.');

try { const me = await api('/api/auth/me'); st.user = me.user; if (me.csrf_token) setCsrf(me.csrf_token); } catch {}

function renderServices() {
  setStep(0); clear(msg);
  if (!boot) return view.replaceChildren(h('div', { class: 'alert err', text: 'Obsah se nepodařilo načíst. Zkuste stránku obnovit.' }));
  if (!boot.booking.enabled) return view.replaceChildren(h('div', { class: 'alert info' }, 'Online rezervace zatím není spuštěna. Termín si prosím domluvte telefonicky.'), contactBox());
  if (!boot.categories.length) return view.replaceChildren(h('div', { class: 'alert info', text: 'Nabídka služeb se připravuje.' }), contactBox());
  const pick = (s) => { st.svc = s; st.day = null; st.slot = null; st.from = null; st.month = null; renderDates(); };
  view.replaceChildren(h('h2', { text: 'Vyberte službu' }), boot.categories.map((c) => [h('h3', { class: 'cat-title', text: c.name }), c.services.map((s) => serviceCard(s, { onclick: () => pick(s) }))]));
  const pre = new URLSearchParams(location.search).get('sluzba');
  if (pre && !st.preDone) { st.preDone = true; const s = boot.categories.flatMap((c) => c.services).find((x) => x.id === pre); if (s) pick(s); }
}

const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
const pad = (n) => String(n).padStart(2, '0');
const tzToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: boot?.booking?.timezone || 'Europe/Prague' }).format(new Date());
const addMonth = (ym, k) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + k, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const plusDays = (iso, n) => { const p = dateParts(iso); return new Date(Date.UTC(p.y, p.m - 1, p.d + n)).toISOString().slice(0, 10); };
const monthCache = new Map();
async function loadMonth(ym) {
  const key = `${st.svc.id}|${ym}`;
  if (monthCache.has(key)) return monthCache.get(key);
  const today = tzToday(); const first = `${ym}-01`; const to = monthEnd(ym);
  if (to < today) return { days: [] };
  const q = new URLSearchParams({ service_id: st.svc.id, from: first > today ? first : today, to });
  const r = await api(`/api/public/availability?${q}`);
  if (!r.disabled && !r.degraded) monthCache.set(key, r);
  return r;
}
const hasFree = (r) => (r.days || []).some((d) => d.slots.length);

async function renderDates() {
  setStep(1); clear(msg); monthCache.clear();
  view.replaceChildren(h('button', { class: 'btn ghost sm', type: 'button', onclick: renderServices }, '← Jiná služba'), h('h2', { text: `${st.svc.name}` }), h('p', { class: 'muted', text: [dur(st.svc.duration_minutes), st.svc.price_czk != null ? money(st.svc.price_czk) : ''].filter(Boolean).join(' · ') }), h('div', { id: 'avail' }, h('span', { class: 'spin' })));
  try {
    const box = $('#avail');
    const start = st.month || tzToday().slice(0, 7);
    let ym = start; let r = await loadMonth(ym);
    if (r.disabled || r.degraded) { box.replaceChildren(h('div', { class: 'alert info', text: r.message || 'Online rezervace je dočasně nedostupná.' }), contactBox()); return; }
    if (!st.month && !hasFree(r)) {
      for (let i = 0; i < 3; i += 1) { const n = addMonth(ym, 1); const nr = await loadMonth(n); if (nr.disabled || nr.degraded) break; ym = n; r = nr; if (hasFree(r)) break; }
      if (!hasFree(r)) { box.replaceChildren(h('div', { class: 'alert info', text: 'V nejbližších měsících nejsou volné termíny.' }), contactBox()); return; }
    }
    st.month = ym; drawMonth(box);
  } catch (e) { showErr(msg, e); $('#avail')?.replaceChildren(contactBox()); }
}

async function goMonth(box, k) {
  const ym = addMonth(st.month, k);
  box.setAttribute('aria-busy', 'true');
  try { const r = await loadMonth(ym); if (r.disabled || r.degraded) throw new Error(r.message || 'Online rezervace je dočasně nedostupná.'); st.month = ym; st.day = null; drawMonth(box); }
  catch (e) { showErr(msg, e); } finally { box.removeAttribute('aria-busy'); }
}

function drawMonth(box) {
  const r = monthCache.get(`${st.svc.id}|${st.month}`) || { days: [] };
  const byDate = new Map((r.days || []).map((d) => [d.date, d.slots]));
  if (!st.day || !st.day.startsWith(st.month) || !(byDate.get(st.day) || []).length) st.day = [...byDate.entries()].find(([, sl]) => sl.length)?.[0] || null;
  const [y, m] = st.month.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = tzToday();
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(h('span', { class: 'mc empty' }));
  for (let d = 1; d <= dim; d += 1) {
    const date = `${st.month}-${pad(d)}`; const free = (byDate.get(date) || []).length > 0;
    cells.push(h('button', { class: `mc${free ? ' free' : ''}${date === st.day ? ' sel' : ''}${date === today ? ' today' : ''}`, type: 'button', disabled: !free, 'aria-pressed': date === st.day, 'aria-label': free ? dateCs(date) : `${dateCs(date)} – bez volných termínů`, onclick: () => { st.day = date; drawMonth(box); } }, String(d)));
  }
  const canPrev = st.month > today.slice(0, 7);
  const canNext = `${addMonth(st.month, 1)}-01` <= plusDays(today, boot?.booking?.max_advance_days || 60);
  const slots = st.day ? byDate.get(st.day) || [] : [];
  box.replaceChildren(h('div', { class: 'pick' },
    h('div', { class: 'mcal' },
      h('div', { class: 'mhead' },
        h('button', { class: 'mnav', type: 'button', disabled: !canPrev, 'aria-label': 'Předchozí měsíc', onclick: () => goMonth(box, -1) }, '‹'),
        h('strong', { text: `${MONTHS[m - 1]} ${y}`, 'aria-live': 'polite' }),
        h('button', { class: 'mnav', type: 'button', disabled: !canNext, 'aria-label': 'Další měsíc', onclick: () => goMonth(box, 1) }, '›')),
      h('div', { class: 'mwd' }, WD.map((w) => h('span', { text: w.toLowerCase() }))),
      h('div', { class: 'mgrid', role: 'group', 'aria-label': 'Vyberte den' }, cells)),
    h('div', { class: 'mtimes' },
      st.day ? [h('h3', { text: dateCs(st.day) }), h('div', { class: 'slots', role: 'group', 'aria-label': 'Volné časy' }, slots.map((sl) => h('button', { class: 'slot', type: 'button', onclick: () => { st.slot = sl; renderDetails(); } }, sl.time)))]
        : [h('p', { class: 'muted', text: 'V tomto měsíci nejsou volné termíny. Zkuste další měsíc.' })])));
}

function summary() {
  return h('dl', { class: 'summary card' }, h('dt', { text: 'Služba' }), h('dd', { text: st.svc.name }), h('dt', { text: 'Termín' }), h('dd', { text: `${dateCs(st.day)} v ${st.slot.time}` }), h('dt', { text: 'Délka a cena' }), h('dd', { text: [dur(st.svc.duration_minutes), st.svc.price_czk != null ? money(st.svc.price_czk) : ''].filter(Boolean).join(' · ') }));
}
function renderDetails() {
  setStep(2); clear(msg);
  const u = st.user;
  const f = h('form', { novalidate: true, onsubmit: submitDetails },
    h('label', { for: 'f-name', text: 'Jméno a příjmení' }), h('input', { id: 'f-name', name: 'name', autocomplete: 'name', required: true, value: u?.full_name || '' }),
    h('label', { for: 'f-email', text: 'E-mail' }), h('input', { id: 'f-email', name: 'email', type: 'email', autocomplete: 'email', required: true, value: u?.email || '' }),
    h('label', { for: 'f-phone', text: 'Telefon' }), h('input', { id: 'f-phone', name: 'phone', type: 'tel', autocomplete: 'tel', required: true, value: u?.phone || '', placeholder: '+420 …' }),
    h('label', { for: 'f-note', text: 'Poznámka (nepovinné)' }), h('textarea', { id: 'f-note', name: 'note', maxlength: 1000 }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'consent', required: true }), h('span', {}, 'Souhlasím s ', h('a', { href: '/podminky', target: '_blank' }, 'obchodními podmínkami'), ' a beru na vědomí ', h('a', { href: '/ochrana-udaju', target: '_blank' }, 'zásady zpracování osobních údajů'), '.')),
    h('div', { class: 'row', style: false }, h('button', { class: 'btn', type: 'submit', id: 'f-submit' }, u?.email_verified ? 'Potvrdit rezervaci' : 'Pokračovat'), h('button', { class: 'btn ghost', type: 'button', onclick: renderDates }, 'Změnit termín')));
  view.replaceChildren(h('h2', { text: 'Vaše údaje' }), summary(),
    u ? h('p', { class: 'small muted', text: `Přihlášena jako ${u.email}.` }) : h('p', { class: 'small' }, 'Máte účet? ', h('a', { href: '/ucet?zpet=/rezervace' }, 'Přihlaste se'), ' – údaje se vyplní samy. Rezervovat lze i bez účtu.'), f);
}
async function submitDetails(ev) {
  ev.preventDefault(); clear(msg);
  const f = ev.target; const fd = new FormData(f);
  if (!f.reportValidity()) return;
  const btn = $('#f-submit'); btn.disabled = true;
  try {
    const r = await api('/api/bookings', { method: 'POST', body: { service_id: st.svc.id, starts_at: st.slot.start, name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'), note: fd.get('note') || '', consent: true } });
    st.booking = r;
    if (r.needs_verification) renderVerify(fd.get('email')); else renderDone(r);
  } catch (e) {
    btn.disabled = false;
    if (e.code === 'slot_unavailable') { showErr(msg, new Error('Tento termín už bohužel není volný. Vyberte prosím jiný.')); st.slot = null; await renderDates(); showErr(msg, new Error('Tento termín už bohužel není volný. Vyberte prosím jiný.')); }
    else showErr(msg, e);
  }
}
function renderVerify(email) {
  setStep(3);
  const exp = new Date(st.booking.hold_expires_at);
  const f = h('form', { onsubmit: async (ev) => {
    ev.preventDefault(); clear(msg); const b = $('button[type=submit]', f); b.disabled = true;
    try { const r = await api(`/api/bookings/${st.booking.booking.id}/verify`, { method: 'POST', body: { code: $('#code').value.trim() } }); renderDone(r); }
    catch (e) { b.disabled = false; showErr(msg, e); if (e.status === 410) view.replaceChildren(h('button', { class: 'btn', onclick: renderServices }, 'Vybrat termín znovu')); }
  } },
    h('label', { for: 'code', text: 'Šestimístný kód z e-mailu' }), h('input', { id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '\\d{6}', maxlength: 6, required: true }),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Potvrdit rezervaci'),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { try { await api(`/api/bookings/${st.booking.booking.id}/resend`, { method: 'POST', body: {} }); msg.replaceChildren(h('div', { class: 'alert ok', text: 'Kód jsme poslali znovu.' })); msg.hidden = false; } catch (e) { showErr(msg, e); } } }, 'Poslat kód znovu')));
  view.replaceChildren(h('h2', { text: 'Ověřte e-mail' }), h('p', {}, `Na adresu ${email} jsme poslali kód. Termín je pro vás držen do ${exp.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}. Bez ověření se rezervace nepotvrdí.`), summary(), f);
}
function renderDone(r) {
  setStep(3); clear(msg);
  const b = r.booking;
  view.replaceChildren(h('div', { class: 'alert ok', role: 'status' }, h('strong', { text: 'Rezervace je potvrzena.' }), ' Potvrzení jsme vám poslali e-mailem.'),
    h('dl', { class: 'summary card' }, h('dt', { text: 'Služba' }), h('dd', { text: b.service_name }), h('dt', { text: 'Termín' }), h('dd', { text: `${b.date_label} v ${b.local_time}` }), h('dt', { text: 'Adresa' }), h('dd', { text: boot.content.contact_address })),
    h('p', { class: 'small muted' }, `Zrušit rezervaci lze nejpozději ${b.cancel_hours_before} hodin předem pomocí odkazu v e-mailu nebo v účtu.`),
    h('div', { class: 'row' }, r.manage_url ? h('a', { class: 'btn ghost', href: new URL(r.manage_url, location.href).pathname + new URL(r.manage_url, location.href).search }, 'Spravovat rezervaci') : '', h('a', { class: 'btn ghost', href: '/' }, 'Zpět na úvod')));
}
renderServices();
