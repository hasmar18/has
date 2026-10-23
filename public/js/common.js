// Společné funkce veřejné části webu. Žádné inline skripty/styly (CSP).
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if ((v === false && !k.startsWith('aria-')) || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? (k.startsWith('aria-') ? 'true' : '') : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
let csrf = null;
export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf) headers['x-csrf-token'] = csrf;
  let res;
  try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); }
  catch { throw Object.assign(new Error('Nepodařilo se spojit se serverem. Zkontrolujte připojení a zkuste to znovu.'), { network: true }); }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error || {};
    throw Object.assign(new Error(e.message || 'Něco se nepovedlo. Zkuste to prosím znovu.'), { status: res.status, code: e.code, data: e });
  }
  return data;
}
export const setCsrf = (t) => { csrf = t; try { sessionStorage.setItem('csrf', t || ''); } catch {} };
try { csrf = sessionStorage.getItem('csrf') || null; } catch {}
export const money = (n) => (n == null ? '' : `${Number(n).toLocaleString('cs-CZ')} Kč`);
export const durPrice = (m, p) => [dur(m), p != null ? money(p) : ''].filter(Boolean).join(' · ');
export const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
export const WD = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
export function dateParts(iso) { const [y, m, d] = iso.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return { y, m, d, wd: (dt.getUTCDay() + 6) % 7 }; }
export const dateCs = (iso) => { const p = dateParts(iso); return `${['pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota', 'neděle'][p.wd]} ${p.d}. ${p.m}. ${p.y}`; };

let bootP;
export const bootstrap = () => (bootP ||= api('/api/public/bootstrap'));

const LOGO = '<svg viewBox="0 0 22 28" aria-hidden="true"><path d="M3 27V10C3 4.5 6.5 1 11 1s8 3.5 8 9v17z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 27V11c0-3 1.7-5 4-5" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".5"/></svg>';
const NAV = [['/', 'Úvod'], ['/#sluzby', 'Služby'], ['/#galerie', 'Galerie'], ['/kontakt', 'Kontakt'], ['/ucet', 'Můj účet']];

export function chrome(active, content, logoId) {
  const hdr = h('header', { class: 'site' }, h('div', { class: 'wrap' },
    h('a', { class: 'logo', href: '/', 'aria-label': 'HASNAILS – úvodní stránka' }),
    h('button', { class: 'menu-btn', 'aria-expanded': 'false', 'aria-controls': 'mainnav', onclick: (e) => { const n = $('#mainnav'); const o = n.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', o); } }, 'Menu'),
    h('nav', { class: 'main', id: 'mainnav', 'aria-label': 'Hlavní navigace' },
      NAV.map(([href, t]) => h('a', { href, ...(href === active ? { 'aria-current': 'page' } : {}) }, t)),
      h('a', { class: 'btn sm', href: '/rezervace' }, 'Rezervovat'))));
  $('.logo', hdr).innerHTML = '<img class="logo-img" alt="HASNAILS" width="58" height="38">';
  $('.logo-img', hdr).src = logoId ? `/media/${logoId}` : '/img/logo.png';
  const c = content || {};
  const ftr = h('footer', { class: 'site' }, h('div', { class: 'wrap' }, h('div', { class: 'cols' },
    h('div', {}, h('strong', { text: 'HASNAILS' }), h('p', { class: 'small', text: c.contact_name || '' }), h('p', { class: 'small', text: c.contact_address || '' })),
    h('div', {}, h('p', { class: 'small' }, c.contact_phone ? h('a', { href: `tel:${(c.contact_phone || '').replace(/\s/g, '')}` }, c.contact_phone) : ''),
      c.instagram_url ? h('p', { class: 'small' }, h('a', { href: c.instagram_url, rel: 'noopener', target: '_blank' }, 'Instagram')) : ''),
    h('div', { class: 'small' }, h('p', {}, h('a', { href: '/podminky' }, 'Obchodní podmínky')), h('p', {}, h('a', { href: '/ochrana-udaju' }, 'Ochrana osobních údajů (GDPR)')), c.footer_note ? h('p', { text: c.footer_note }) : ''),
  ), h('p', { class: 'small', text: `© ${new Date().getFullYear()} HASNAILS · ilustrační fotografie: Unsplash` })));
  document.body.prepend(h('a', { class: 'skip', href: '#main' }, 'Přeskočit na obsah'), hdr);
  document.body.append(ftr);
}
export async function initPage(active) {
  let boot = null;
  try { boot = await bootstrap(); } catch { /* stránka funguje i bez dat */ }
  chrome(active, boot?.content, boot?.logo_id);
  return boot;
}
export function serviceCard(s, { onclick, href } = {}) {
  const plus = href ? h('a', { class: 'plus', href, 'aria-label': `Rezervovat: ${s.name}` }, '+') : h('button', { class: 'plus', type: 'button', onclick, 'aria-label': `Vybrat: ${s.name}` }, '+');
  return h('div', { class: 'svc-card' },
    (() => { const im = h('img', { class: 'svc-img', src: s.image_url || '/img/ilu-klasicka.svg', alt: '', loading: 'lazy', width: 96, height: 96 }); im.addEventListener('error', () => { if (!im.src.endsWith('.svg')) im.src = '/img/ilu-klasicka.svg'; }); return im; })(),
    h('div', { class: 'svc-body' }, h('h4', { text: s.name }), s.description ? h('p', { class: 'svc-desc', text: s.description }) : '',
      h('div', { class: 'svc-meta' }, h('span', { text: dur(s.duration_minutes) }), s.price_czk != null ? h('strong', { text: `${s.price_from ? 'od ' : ''}${money(s.price_czk)}` }) : '')),
    plus);
}
export const showErr = (box, e) => { box.replaceChildren(h('div', { class: 'alert err', role: 'alert', text: e.message || String(e) })); box.hidden = false; box.scrollIntoView({ block: 'nearest' }); };
export const clear = (el) => { el.replaceChildren(); el.hidden = true; };
export const telHref = (p) => `tel:${(p || '').replace(/[^+\d]/g, '')}`;
export const mapsDir = (c) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(c.contact_lat)},${encodeURIComponent(c.contact_lng)}`;

// replaceChildren/append/prepend přijímají i vnořená pole, null a false (pohodlné pro výpisy).
for (const m of ['replaceChildren', 'append', 'prepend']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function patched(...kids) {
    return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k && k.nodeType ? k : String(k))));
  };
}
