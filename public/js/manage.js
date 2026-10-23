import { $, h, api, initPage, showErr, clear, money, dur, telHref } from './common.js';
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
      h('h2', { text: b.service_name }), h('p', { text: `${b.date_label} v ${b.local_time}` }), h('p', { class: 'muted', text: `${dur(b.duration_minutes)} · ${money(b.price_czk)}` }),
      h('p', { class: 'small', text: `${boot?.content.contact_name || ''}, ${boot?.content.contact_address || ''}` })),
    cancelled ? h('p', { class: 'muted', text: 'Tato rezervace byla zrušena.' }) : h('div', {},
      b.can_cancel ? h('button', { class: 'btn danger', onclick: cancel }, 'Zrušit rezervaci') : h('p', { class: 'alert info', text: `Online zrušení je možné nejpozději ${b.cancel_hours_before} hodin před termínem. Zavolejte prosím do studia.` }),
      b.can_request_change ? h('div', { style: false }, h('h3', { text: 'Potřebujete jiný termín?' }),
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
load();
