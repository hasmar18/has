import { $, h, api, initPage, showErr, clear, setCsrf, money, dur, telHref } from './common.js';
const boot = await initPage('/ucet');
const view = $('#view'); const msg = $('#msg');
const url = new URL(location.href);
const verifyTok = url.searchParams.get('overit'); const resetTok = url.searchParams.get('obnova');
const back = (() => { const z = url.searchParams.get('zpet'); return z && /^\/[^/\\]/.test(z) ? z : null; })();
if (verifyTok || resetTok) history.replaceState(null, '', location.pathname);
const info = (t, c = 'ok') => { msg.replaceChildren(h('div', { class: `alert ${c}`, role: 'status', text: t })); msg.hidden = false; };
const field = (id, label, attrs = {}) => [h('label', { for: id, text: label }), h('input', { id, name: id, ...attrs })];
const pwHint = 'Alespoň 10 znaků, nesmí být příliš běžné ani obsahovat váš e-mail.';

async function start() {
  if (verifyTok) {
    try { await api('/api/auth/verify-email', { method: 'POST', body: { token: verifyTok } }); info('E-mail byl ověřen. Nyní se můžete přihlásit.'); } catch (e) { showErr(msg, e); }
  }
  if (resetTok) return drawReset();
  try { const me = await api('/api/auth/me'); if (me.user) { setCsrf(me.csrf_token); return drawAccount(me.user); } } catch {}
  drawLogin();
}
function form(fields, submitText, onSubmit, extra) {
  const f = h('form', { novalidate: true, onsubmit: async (ev) => { ev.preventDefault(); if (!f.reportValidity()) return; clear(msg); const b = $('button[type=submit]', f); b.disabled = true; try { await onSubmit(Object.fromEntries(new FormData(f))); } catch (e) { showErr(msg, e); } b.disabled = false; } }, fields, h('div', { class: 'row', style: false }, h('button', { class: 'btn', type: 'submit', text: submitText })), extra);
  return f;
}
function drawLogin() {
  view.replaceChildren(h('h2', { text: 'Přihlášení' }),
    form([field('email', 'E-mail', { type: 'email', autocomplete: 'username', required: true }), field('password', 'Heslo', { type: 'password', autocomplete: 'current-password', required: true })], 'Přihlásit se', async (d) => {
      const r = await api('/api/auth/login', { method: 'POST', body: d }); setCsrf(r.csrf_token);
      if (back) location.href = back; else drawAccount(r.user);
    }),
    h('p', { class: 'small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); drawForgot(); } }, 'Zapomenuté heslo'), ' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); drawRegister(); } }, 'Vytvořit účet')),
    h('p', { class: 'muted small', text: 'Účet není nutný – rezervovat můžete i jen s e-mailem.' }));
}
function drawRegister() {
  clear(msg);
  view.replaceChildren(h('h2', { text: 'Nový účet' }), form([
    field('name', 'Jméno a příjmení', { autocomplete: 'name', required: true }), field('email', 'E-mail', { type: 'email', autocomplete: 'email', required: true }),
    field('phone', 'Telefon', { type: 'tel', autocomplete: 'tel' }), field('password', 'Heslo', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 }), h('p', { class: 'small muted', text: pwHint }),
  ], 'Vytvořit účet', async (d) => { await api('/api/auth/register', { method: 'POST', body: d }); view.replaceChildren(h('div', { class: 'alert ok', text: 'Hotovo. Poslali jsme vám e-mail s odkazem pro ověření adresy. Po ověření se můžete přihlásit.' }), h('button', { class: 'btn ghost', onclick: drawLogin }, 'Přejít k přihlášení')); }),
    h('p', { class: 'small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); drawLogin(); } }, '← Zpět na přihlášení')));
}
function drawForgot() {
  clear(msg);
  view.replaceChildren(h('h2', { text: 'Obnova hesla' }), form([field('email', 'E-mail', { type: 'email', required: true })], 'Poslat odkaz', async (d) => {
    await api('/api/auth/forgot', { method: 'POST', body: d }); view.replaceChildren(h('div', { class: 'alert ok', text: 'Pokud k této adrese existuje účet, poslali jsme na ni odkaz pro nastavení nového hesla.' }));
  }), h('p', { class: 'small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); drawLogin(); } }, '← Zpět')));
}
function drawReset() {
  view.replaceChildren(h('h2', { text: 'Nové heslo' }), form([field('password', 'Nové heslo', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 }), h('p', { class: 'small muted', text: pwHint })], 'Nastavit heslo', async (d) => {
    await api('/api/auth/reset', { method: 'POST', body: { token: resetTok, password: d.password } }); info('Heslo bylo změněno. Přihlaste se prosím novým heslem.'); drawLogin();
  }));
}
async function drawAccount(user) {
  const tabs = ['Rezervace', 'Profil'];
  const body = h('div', {});
  const bar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map((t, i) => h('button', { role: 'tab', 'aria-selected': i === 0, onclick: (e) => { $$tabs(bar, e.currentTarget); (i === 0 ? drawBookings(body) : drawProfile(user, body)); } }, t)));
  view.replaceChildren(h('div', { class: 'row sp' }, h('p', { class: 'muted', text: user.email }), h('button', { class: 'btn ghost sm', onclick: async () => { await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {}); setCsrf(null); drawLogin(); } }, 'Odhlásit')),
    user.email_verified ? '' : h('div', { class: 'alert info' }, 'E-mail zatím není ověřen. ', h('button', { class: 'btn ghost sm', onclick: async () => { try { await api('/api/auth/resend-verification', { method: 'POST', body: {} }); info('Ověřovací e-mail jsme poslali znovu.'); } catch (e) { showErr(msg, e); } } }, 'Poslat znovu')),
    h('p', {}, h('a', { class: 'btn', href: '/rezervace' }, 'Nová rezervace')), bar, body);
  drawBookings(body);
}
const $$tabs = (bar, cur) => bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b === cur));
async function drawBookings(body) {
  body.replaceChildren(h('span', { class: 'spin' }));
  try {
    const r = await api('/api/me/bookings');
    const card = (b, upcoming) => h('div', { class: 'bk' }, h('div', { class: 'row sp' }, h('strong', { text: b.service_name }), h('span', { class: `tag ${b.status === 'cancelled' ? 'cancelled' : ''}`, text: { confirmed: 'Potvrzeno', cancelled: 'Zrušeno', completed: 'Proběhlo', no_show: 'Nedostavila se' }[b.status] || b.status })),
      h('div', { text: `${b.date_label} v ${b.local_time}` }), h('div', { class: 'small muted', text: `${dur(b.duration_minutes)} · ${money(b.price_czk)}` }),
      upcoming ? h('div', { class: 'row', style: false }, b.can_cancel ? h('button', { class: 'btn danger sm', onclick: async () => { if (!confirm('Opravdu zrušit rezervaci?')) return; try { await api(`/api/me/bookings/${b.id}/cancel`, { method: 'POST', body: {} }); info('Rezervace byla zrušena.'); drawBookings(body); } catch (e) { showErr(msg, e); } } }, 'Zrušit') : h('span', { class: 'small muted', text: `Zrušit online lze ${b.cancel_hours_before} h předem – zavolejte prosím do studia.` }),
        b.can_request_change ? h('button', { class: 'btn ghost sm', onclick: async () => { const m = prompt('Napište, kdy by vám vyhovoval jiný termín:'); if (!m || m.trim().length < 3) return; try { await api(`/api/me/bookings/${b.id}/reschedule-request`, { method: 'POST', body: { message: m } }); info('Žádost o změnu jsme odeslali.'); } catch (e) { showErr(msg, e); } } }, 'Požádat o změnu') : '') : '');
    body.replaceChildren(h('h2', { text: 'Nadcházející' }), r.upcoming.length ? r.upcoming.map((b) => card(b, true)) : h('p', { class: 'muted', text: 'Zatím nemáte žádnou nadcházející rezervaci.' }),
      h('h2', { text: 'Minulé' }), r.past.length ? r.past.map((b) => card(b, false)) : h('p', { class: 'muted', text: 'Žádné.' }));
  } catch (e) { body.replaceChildren(); showErr(msg, e); }
}
function drawProfile(user, body) {
  body.replaceChildren(
    h('h2', { text: 'Osobní údaje' }),
    form([field('name', 'Jméno a příjmení', { value: user.full_name || '', required: true, autocomplete: 'name' }), field('phone', 'Telefon', { type: 'tel', value: user.phone || '', autocomplete: 'tel' })], 'Uložit', async (d) => { await api('/api/me', { method: 'PATCH', body: d }); info('Údaje byly uloženy.'); }),
    h('h2', { text: 'Změna hesla' }),
    form([field('current_password', 'Současné heslo', { type: 'password', required: true, autocomplete: 'current-password' }), field('new_password', 'Nové heslo', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), h('p', { class: 'small muted', text: pwHint })], 'Změnit heslo', async (d) => { await api('/api/auth/change-password', { method: 'POST', body: d }); info('Heslo bylo změněno.'); }),
    h('h2', { text: 'Smazání účtu' }), h('p', { class: 'small muted', text: 'Smaže osobní údaje, zruší budoucí rezervace a odhlásí vás. Nelze vrátit.' }),
    form([field('password', 'Heslo pro potvrzení', { type: 'password', required: true })], 'Smazat účet', async (d) => { if (!confirm('Opravdu trvale smazat účet?')) return; await api('/api/me', { method: 'DELETE', body: d }); setCsrf(null); info('Účet byl smazán.'); drawLogin(); }));
}
start();
