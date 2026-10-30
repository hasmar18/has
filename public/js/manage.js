import { $, h, api, initPage, showErr, clear, durPrice, telHref, dateCs, WD } from './common.js';
const boot = await initPage('');
const view = $('#view'); const msg = $('#msg');
const token = new URL(location.href).searchParams.get('token');
history.replaceState(null, '', location.pathname); // token nezůstává v adresním řádku ani v historii
const info = (t, c = 'ok') => { msg.replaceChildren(h('div', { class: `alert ${c}`, role: 'status', text: t })); msg.hidden = false; };
async function load() {
  if (!token) return view.replaceChildren(h('div', { class: 'alert err', text: 'Odkaz není úplný. Použijte prosím odkaz z potvrzovacího e-mailu.' }));
  try { const r = await api('/api/bookings/manage/view', { method: 'POST', body: { token } }); draw(r.booking, r.contact); }
  catch (e) { view.replaceChildren(h('div', { class: 'alert err', text: e.status === 404 ? 'Rezervace nebyla nalezena. Odkaz je neplatný nebo zastaralý.' : e.message })); }
}
function draw(b, c) {
  const cancelled = b.status === 'cancelled';
  view.replaceChildren(
    h('div', { class: 'card' }, h('span', { class: `tag ${cancelled ? 'cancelled' : ''}`, text: cancelled ? 'Zrušeno' : b.status === 'confirmed' ? 'Potvrzeno' : b.status }),
      h('h2', { text: b.service_name }), h('p', { text: `${b.date_label} v ${b.local_time}` }), h('p', { class: 'muted', text: durPrice(b.duration_minutes, b.price_czk) }),
      h('p', { class: 'small', text: `${boot?.content.contact_name || ''}, ${boot?.content.contact_address || ''}` })),
    cancelled ? h('p', { class: 'muted', text: 'Tato rezervace byla zrušena.' }) : h('div', {},
      b.can_cancel ? h('button', { class: 'btn danger', onclick: cancel }, 'Zrušit rezervaci') : h('p', { class: 'alert info', text: `Online zrušení je možné nejpozději ${b.cancel_hours_before} hodin před termínem. Zavolejte prosím do studia.` }),
      b.can_reschedule ? h('button', { class: 'btn', style: 'margin-left:8px', onclick: () => pickDate(b, c) }, 'Změnit termín') : '',
      b.can_request_change && !b.can_reschedule ? h('div', { style: false }, h('h3', { text: 'Potřebujete jiný termín?' }),
        h('form', { onsubmit: reschedule }, h('label', { for: 'm', text: 'Napište, kdy by vám to vyhovovalo' }), h('textarea', { id: 'm', required: true, minlength: 3, maxlength: 1000 }), h('button', { class: 'btn ghost', type: 'submit' }, 'Odeslat žádost o změnu'))) : '',
      h('p', { class: 'small' }, 'Telefon: ', h('a', { href: telHref(c?.phone || boot?.content.contact_phone) }, c?.phone || boot?.content.contact_phone || ''))));
}
async function cancel() {
  if (!confirm('Opravdu chcete rezervaci zrušit?')) return; clear(msg);
  try { const r = await api('/api/bookings/manage/cancel', { method: 'POST', body: { token } }); draw(r.booking, null); info('Rezervace byla zrušena. Potvrzení jsme poslali e-mailem.'); } catch (e) { showErr(msg, e); }
}
async function reschedule(ev) {
  ev.preventDefault(); clear(msg);
  try { await api('/api/bookings/manage/reschedule-request', { method: 'POST', body: { token, message: $('#m').value } }); $('#m').value = ''; info('Žádost jsme odeslali. Ozveme se vám s potvrzením nového termínu. Dosavadní rezervace platí, dokud ji nepotvrdíme jinak.'); } catch (e) { showErr(msg, e); }
}

const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
const pad = (n) => String(n).padStart(2, '0');
const tz = boot?.booking?.timezone || 'Europe/Prague';
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date());
const addMonth = (ym, k) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + k, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
function pickDate(b, c) {
  clear(msg);
  const st = { month: today().slice(0, 7), day: null, cache: new Map() };
  const box = h('div', {}, h('span', { class: 'spin' }));
  view.replaceChildren(h('button', { class: 'btn ghost sm', type: 'button', onclick: () => draw(b, c) }, '← Zpět'), h('h2', { text: 'Změna termínu' }),
    h('p', { class: 'muted', text: `${b.service_name} – nyní ${b.date_label} v ${b.local_time}` }), box);
  const load = async (ym) => {
    if (st.cache.has(ym)) return st.cache.get(ym);
    const t = today(); const first = `${ym}-01`; const to = monthEnd(ym);
    if (to < t) return { days: [] };
    const r = await api('/api/bookings/manage/availability', { method: 'POST', body: { token, from: first > t ? first : t, to } });
    if (!r.degraded) st.cache.set(ym, r);
    return r;
  };
  const render = () => {
    const r = st.cache.get(st.month) || { days: [] };
    const byDate = new Map((r.days || []).map((d) => [d.date, d.slots]));
    if (!st.day || !st.day.startsWith(st.month) || !(byDate.get(st.day) || []).length) st.day = [...byDate.entries()].find(([, sl]) => sl.length)?.[0] || null;
    const [y, m] = st.month.split('-').map(Number);
    const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < lead; i += 1) cells.push(h('span', { class: 'mc empty' }));
    for (let d = 1; d <= dim; d += 1) {
      const date = `${st.month}-${pad(d)}`; const free = (byDate.get(date) || []).length > 0;
      cells.push(h('button', { class: `mc${free ? ' free' : ''}${date === st.day ? ' sel' : ''}${date === today() ? ' today' : ''}`, type: 'button', disabled: !free, 'aria-pressed': date === st.day, onclick: () => { st.day = date; render(); } }, String(d)));
    }
    const go = async (k) => { const ym = addMonth(st.month, k); try { await load(ym); st.month = ym; st.day = null; render(); } catch (e) { showErr(msg, e); } };
    const slots = st.day ? byDate.get(st.day) || [] : [];
    box.replaceChildren(h('div', { class: 'pick' },
      h('div', { class: 'mcal' },
        h('div', { class: 'mhead' },
          h('button', { class: 'mnav', type: 'button', disabled: st.month <= today().slice(0, 7), 'aria-label': 'Předchozí měsíc', onclick: () => go(-1) }, '‹'),
          h('strong', { text: `${MONTHS[m - 1]} ${y}` }),
          h('button', { class: 'mnav', type: 'button', 'aria-label': 'Další měsíc', onclick: () => go(1) }, '›')),
        h('div', { class: 'mwd' }, WD.map((w) => h('span', { text: w.toLowerCase() }))),
        h('div', { class: 'mgrid' }, cells)),
      h('div', { class: 'mtimes' }, st.day ? [h('h3', { text: dateCs(st.day) }), h('div', { class: 'slots' }, slots.map((sl) => h('button', { class: 'slot', type: 'button', onclick: () => confirmMove(b, c, st.day, sl) }, sl.time)))] : [h('p', { class: 'muted', text: 'V tomto měsíci nejsou volné termíny. Zkuste další měsíc.' })])));
  };
  load(st.month).then((r) => {
    if (r.degraded) return box.replaceChildren(h('div', { class: 'alert info', text: r.message }));
    render();
  }).catch((e) => { showErr(msg, e); box.replaceChildren(); });
}
async function confirmMove(b, c, day, sl) {
  if (!confirm(`Přesunout rezervaci na ${dateCs(day)} v ${sl.time}?`)) return; clear(msg);
  try { const r = await api('/api/bookings/manage/reschedule', { method: 'POST', body: { token, starts_at: sl.start } }); draw(r.booking, c); info('Termín je změněn. Nové potvrzení jsme poslali e-mailem.'); }
  catch (e) { showErr(msg, e); if (e.code === 'slot_unavailable' || e.code === 'slot_taken') pickDate(b, c); }
}
load();
