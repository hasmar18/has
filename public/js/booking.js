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
  const pick = (s) => { st.svc = s; st.day = null; st.slot = null; st.from = null; renderDates(); };
  view.replaceChildren(h('h2', { text: 'Vyberte službu' }), boot.categories.map((c) => [h('h3', { class: 'cat-title', text: c.name }), c.services.map((s) => serviceCard(s, { onclick: () => pick(s) }))]));
  const pre = new URLSearchParams(location.search).get('sluzba');
  if (pre && !st.preDone) { st.preDone = true; const s = boot.categories.flatMap((c) => c.services).find((x) => x.id === pre); if (s) pick(s); }
}

async function renderDates() {
  setStep(1); clear(msg);
  view.replaceChildren(h('button', { class: 'btn ghost sm', type: 'button', onclick: renderServices }, '← Jiná služba'), h('h2', { text: `${st.svc.name}` }), h('p', { class: 'muted', text: [dur(st.svc.duration_minutes), st.svc.price_czk != null ? money(st.svc.price_czk) : ''].filter(Boolean).join(' · ') }), h('div', { id: 'avail' }, h('span', { class: 'spin' })));
  try {
    const q = new URLSearchParams({ service_id: st.svc.id }); if (st.from) q.set('from', st.from);
    const r = await api(`/api/public/availability?${q}`);
    const box = $('#avail');
    if (r.disabled || r.degraded) { box.replaceChildren(h('div', { class: 'alert info', text: r.message || 'Online rezervace je dočasně nedostupná.' }), contactBox()); return; }
    st.days = r.days;
    const free = r.days.filter((d) => d.slots.length);
    if (!free.length) {
      const last = r.days.at(-1)?.date;
      box.replaceChildren(h('div', { class: 'alert info', text: 'V tomto období nejsou volné termíny.' }),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { st.from = nextFrom(last); renderDates(); } }, 'Další dny →')),
        contactBox());
      return;
    }
    if (!st.day || !free.find((d) => d.date === st.day)) st.day = free[0].date;
    drawDays(box);
  } catch (e) { showErr(msg, e); $('#avail')?.replaceChildren(contactBox()); }
}
const nextFrom = (last) => { if (!last) return null; const p = dateParts(last); const d = new Date(Date.UTC(p.y, p.m - 1, p.d + 1)); return d.toISOString().slice(0, 10); };
function drawDays(box) {
  const day = st.days.find((d) => d.date === st.day);
  box.replaceChildren(
    h('div', { class: 'days', role: 'group', 'aria-label': 'Vyberte den' }, st.days.map((d) => { const p = dateParts(d.date);
      return h('button', { class: `day${d.date === st.day ? ' sel' : ''}`, type: 'button', disabled: !d.slots.length, 'aria-pressed': d.date === st.day, onclick: () => { st.day = d.date; drawDays(box); } }, WD[p.wd], h('b', { text: p.d }), `${p.m}.`); })),
    h('p', { class: 'small' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { st.from = nextFrom(st.days.at(-1).date); renderDates(); } }, 'Zobrazit další dny →'), st.from ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { st.from = null; renderDates(); } }, '← Zpět na nejbližší') : ''),
    h('h3', { text: dateCs(st.day) }),
    h('div', { class: 'slots', role: 'group', 'aria-label': 'Volné časy' }, day.slots.map((s) => h('button', { class: 'slot', type: 'button', onclick: () => { st.slot = s; renderDetails(); } }, s.time))));
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
