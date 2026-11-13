// Úvodní stránka (návrh B). Obsah se načítá stejně jako dřív z /api/public/bootstrap – texty, služby, ceny,
// galerie i kontakt se dál spravují v administraci. Žádné inline styly ani skripty (platí přísné CSP).
import { $, $$, h, initPage, telHref, mapsDir, api, dur, money, WD, dateParts } from './common.js';

const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const SPEED = [-0.5, 0.35, -0.2, 0.5, -0.35];

function serviceRow(s) {
  const im = h('img', { class: 'hb-thumb', src: s.image_url || '/img/ilu-klasicka.svg', alt: '', loading: 'lazy', width: 64, height: 64 });
  im.addEventListener('error', () => { if (!im.src.endsWith('.svg')) im.src = '/img/ilu-klasicka.svg'; });
  return h('li', { class: 'hb-row' }, im,
    h('div', {}, h('h4', { text: s.name }), s.description ? h('p', { text: s.description }) : ''),
    h('span', { class: 't', text: dur(s.duration_minutes) }),
    h('span', { class: 'p', text: s.price_czk != null ? `${s.price_from ? 'od ' : ''}${money(s.price_czk)}` : '' }),
    h('a', { class: 'hb-rz', href: `/rezervace?sluzba=${s.id}`, 'aria-label': `Rezervovat: ${s.name}` }, 'Rezervovat'));
}
/** Prvních pět fotek jako „prsty“ (tvar nehtu), zbytek do běžné mřížky. */
function fingers(box, items) {
  box.replaceChildren(items.slice(0, 5).map((it) => {
    const img = h('img', { src: it.src, alt: it.alt, loading: 'lazy' });
    return it.href ? h('a', { class: 'hb-fg', href: it.href, rel: 'noopener', target: '_blank' }, img) : h('div', { class: 'hb-fg' }, img);
  }));
  box.hidden = !items.length;
}

const boot = await initPage('/');
// Záhlaví úvodní stránky: vidět je jen „Rezervovat“, ostatní odkazy jsou schované pod tlačítkem Menu.
{
  const nav = $('#mainnav'); const top = nav && $('.btn', nav); const mb = $('.menu-btn');
  if (nav && top && mb) {
    mb.before(top);
    const close = () => { nav.classList.remove('open'); mb.setAttribute('aria-expanded', 'false'); };
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('header.site')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
}
if (boot) {
  const c = boot.content;
  const sub = c.hero_subtitle || '';
  const longSub = sub.length > 140;
  $('#hero-title').textContent = c.hero_title;
  $('#hero-sub').textContent = longSub ? '' : sub; $('#hero-sub').hidden = longSub || !sub;
  if (c.contact_phone) {
    for (const id of ['#hero-call', '#mb-call', '#call-btn']) $(id).href = telHref(c.contact_phone);
    $('#hero-call').textContent = `Zavolat ${c.contact_phone}`; $('#hero-call').hidden = false;
  } else { $('#mb-call').hidden = true; }

  // O mně: delší úvodní text se čte jako velký odstavec vedle fotky; „O studiu“ z administrace se zobrazí pod ním.
  const bioText = longSub ? sub : (c.about_text || '');
  $('#about').hidden = !bioText;
  $('#about-title').textContent = c.about_text ? c.about_title : ''; $('#about-title').hidden = !(c.about_text && c.about_title);
  $('#bio').replaceChildren(bioText.trim().split(/\s+/).filter(Boolean).flatMap((w) => [h('span', { text: w }), ' ']));
  const extra = longSub && c.about_text ? c.about_text : '';
  $('#about-text').textContent = extra; $('#about-text').hidden = !extra;
  // Fotka: v administraci (Galerie) jde zvolit „Použít jako fotku O mně“; jinak výchozí fotka.
  const hero = boot.gallery.find((g) => g.is_hero);
  if (hero) $('#bio-img').src = `/media/${hero.id}`;
  $('#bio-img').alt = (hero && hero.alt) || c.contact_name || 'HASNAILS';
  $('#bio-img').addEventListener('error', () => { $('#bio-img').closest('figure').hidden = true; });

  $('#svc-intro').textContent = c.services_intro; $('#svc-intro').hidden = !c.services_intro;
  const box = $('#services'); box.replaceChildren();
  if (!boot.categories.length) box.append(h('p', { class: 'muted', text: 'Ceník bude brzy doplněn. Služby a ceny vám rádi sdělíme telefonicky.' }));
  for (const cat of boot.categories) box.append(h('div', { class: 'hb-cat' }, h('h3', { text: cat.name }), h('ul', {}, cat.services.map(serviceRow))));

  const photos = boot.gallery.filter((g) => !g.is_hero);
  if (photos.length) {
    const items = photos.map((g) => ({ src: `/media/${g.id}`, alt: g.alt || 'Ukázka práce – HASNAILS' }));
    $('#galerie').hidden = false; $('#gal-title').textContent = c.gallery_title;
    fingers($('#gallery'), items);
    const rest = items.slice(5);
    $('#gallery-more').replaceChildren(rest.map((it) => h('img', { src: it.src, alt: it.alt, loading: 'lazy' }))); $('#gallery-more').hidden = !rest.length;
  }
  const igLink = () => { $('#instagram').hidden = false; $('#ig-title').textContent = c.instagram_title; $('#ig-link').href = c.instagram_url; };
  if (boot.instagram.configured) {
    api('/api/public/instagram').then(({ posts }) => {
      if (!posts?.length) { if (c.instagram_url) igLink(); return; }
      igLink();
      fingers($('#ig-posts'), posts.slice(0, 5).map((p) => ({ src: p.url || p.media_url, href: p.permalink, alt: p.caption ? p.caption.slice(0, 80) : 'Příspěvek z Instagramu' })));
      relayout();
    }).catch(() => { if (c.instagram_url) igLink(); });
  } else if (c.instagram_url) igLink();

  // Nejbližší volný termín: stačí nejkratší služba – kdy je volno pro ni, je to nejbližší volno vůbec.
  const all = boot.categories.flatMap((k) => k.services);
  if (boot.booking.enabled && all.length) {
    const s = all.reduce((a, b) => (b.duration_minutes < a.duration_minutes ? b : a));
    api(`/api/public/availability?service_id=${encodeURIComponent(s.id)}`).then((r) => {
      const d = (r.days || []).find((x) => x.slots.length); if (!d) return;
      const p = dateParts(d.date);
      $('#next-link').textContent = `Nejbližší volný termín: ${WD[p.wd]} ${p.d}. ${p.m}. v ${d.slots[0].time}`;
      $('#next').hidden = false;
    }).catch(() => {});
  }

  $('#info').hidden = !(c.client_info_text || c.cancellation_text); $('#info-title').textContent = c.client_info_text ? c.client_info_title : ''; $('#info-title').hidden = !c.client_info_text; $('#info-text').textContent = c.client_info_text;
  $('#cancel-card').hidden = !c.cancellation_text; $('#cancel-text').textContent = c.cancellation_text;
  $('#addr').textContent = `${c.contact_name}, ${c.contact_address}`;
  $('#tel').textContent = c.contact_phone; $('#tel').href = telHref(c.contact_phone);
  $('#nav-btn').href = mapsDir(c);
} else {
  $('#services').textContent = 'Obsah se nepodařilo načíst. Zkuste stránku obnovit.';
  $('#mb-call').hidden = true; $('#call-btn').hidden = true;
}

// ---- Tah lakem: křivka přes celou stránku, která se dokresluje podle scrollu ----
const svg = $('#rib'); const r1 = $('#r1'); const r2 = $('#r2'); const drop = $('#drop'); const main = $('#main');
let L = 0; let ys = []; let cur = 0; let target = 0; let raf = 0; let H = 0; let built = false;
const pageTop = (e) => e.getBoundingClientRect().top + scrollY;
const pageBottom = (e) => e.getBoundingClientRect().bottom + scrollY;

let lastW = 0; let lastH = 0;
function build() {
  const W = document.documentElement.clientWidth;
  H = Math.ceil(pageBottom(main));
  // mobilní prohlížeče hlásí „resize“ i při schování adresního řádku – zbytečně nepřepočítávat
  if (built && W === lastW && Math.abs(H - lastH) < 4) return;
  lastW = W; lastH = H;
  svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  $('#hb-lg').setAttribute('y2', H);
  const mobile = W < 820;
  const w = mobile ? 30 : clamp(W * 0.05, 30, 84); const eL = W < 1260 ? 0 : (W - 1140) / 2 * 0.5; const eR = W - eL;
  const side = (right) => (right ? eR : eL);
  let right = true;
  const pts = [[eL + W * 0.06, -90]];
  const push = (x, y) => { if (y > pts[pts.length - 1][1] + 8) pts.push([x, y]); };
  let oy = 0; for (let e = drop; e; e = e.offsetParent) oy += e.offsetTop;
  if (mobile) {
    // na mobilu tah teče středem stránky za obsahem (jemnější, viz home.css) a vlní se ze strany na stranu
    pts[0] = [W * 0.22, -90];
    const stepY = innerHeight * 0.62; const stop = oy - Math.min(innerHeight * 0.3, 260);
    for (let y = innerHeight * 0.34; y < stop - stepY * 0.4; y += stepY) { push(right ? W * 0.84 : W * 0.16, y); right = !right; }
  } else {
  // úvod: přechod zleva doprava nad nadpisem
  push(side(right), pageTop($('#hero-title')) - 28);
  for (const sec of $$('[data-cross]')) {
    if (sec.hidden) continue;
    const head = $('h2:not([hidden])', sec); const zone = $('.hb-hz', sec);
    push(side(right), pageTop(sec) + 10);
    right = !right;
    push(side(right), (head ? pageTop(head) : pageBottom(zone)) - 28);
  }
  }
  if (!mobile) push(side(right), oy - Math.min(innerHeight * 0.3, 260));
  push(W / 2, oy + drop.offsetHeight * 0.3);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i]; const m = (y0 + y1) / 2; d += ` C${x0},${m} ${x1},${m} ${x1},${y1}`; }
  r1.setAttribute('d', d); r1.setAttribute('stroke-width', w);
  r2.setAttribute('d', d); r2.setAttribute('stroke-width', w * 0.12); r2.setAttribute('transform', `translate(${-w * 0.22},0)`);
  L = r1.getTotalLength();
  r1.style.strokeDasharray = `${L} ${L}`; r2.style.strokeDasharray = `${L} ${L}`;
  const N = 700; ys = []; let mx = -1e9;
  for (let i = 0; i <= N; i++) { mx = Math.max(mx, r1.getPointAtLength(L * i / N).y); ys.push(mx); }
  onScroll(built); built = true;
}
function lookup(Y) {
  if (Y >= ys[ys.length - 1]) return L;
  let lo = 0; let hi = ys.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ys[m] >= Y) hi = m; else lo = m + 1; }
  return L * lo / (ys.length - 1);
}
function draw(l) {
  r1.style.strokeDashoffset = L - l; r2.style.strokeDashoffset = L - l;
  drop.classList.toggle('in', l >= L - 8);
}
function step() {
  cur += (target - cur) * 0.14; if (Math.abs(target - cur) < 0.8) cur = target;
  draw(cur); raf = cur === target ? 0 : requestAnimationFrame(step);
}
function onScroll(snap) {
  const y = scrollY; const vh = innerHeight;
  const doc = document.documentElement.scrollHeight;
  target = RM || y + vh >= doc - 4 ? L : lookup(y + vh * 0.72);
  if (RM || snap === true) { cur = target; draw(cur); } else if (!raf) raf = requestAnimationFrame(step);
  const words = $$('#bio span');
  if (words.length) {
    const b = $('#bio').getBoundingClientRect(); const bp = RM ? 1 : clamp((vh * 0.86 - b.top) / (b.height + vh * 0.2));
    words.forEach((s, i) => s.classList.toggle('on', i / words.length < bp));
  }
  if (!RM) {
    for (const f of $$('.hb-fingers')) {
      if (f.hidden) continue;
      const r = f.getBoundingClientRect(); const fp = (r.top + r.height / 2 - vh / 2) / vh;
      $$('.hb-fg', f).forEach((e, i) => { e.style.transform = `translateY(${(fp * SPEED[i % 5] * 130).toFixed(1)}px)`; });
    }
  }
  const dr = drop.getBoundingClientRect();
  $('#mb').classList.toggle('show', y > vh * 0.7 && !(dr.top < vh && dr.bottom > 0));
}
let rs = 0;
function relayout() { clearTimeout(rs); rs = setTimeout(build, 150); }
let tk = false;
addEventListener('scroll', () => { if (!tk) { tk = true; requestAnimationFrame(() => { onScroll(); tk = false; }); } }, { passive: true });
addEventListener('resize', relayout);
addEventListener('load', relayout);
if ('ResizeObserver' in window) new ResizeObserver(relayout).observe(main);
build();
