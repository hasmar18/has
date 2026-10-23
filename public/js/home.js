import { $, h, initPage, money, dur, telHref, mapsDir, api } from './common.js';
const boot = await initPage('/');
if (boot) {
  const c = boot.content;
  $('#hero-title').textContent = c.hero_title; $('#hero-sub').textContent = c.hero_subtitle;
  $('#about-title').textContent = c.about_title; $('#about-text').textContent = c.about_text;
  $('#svc-intro').textContent = c.services_intro;
  const box = $('#services'); box.replaceChildren();
  if (!boot.categories.length) box.append(h('p', { class: 'muted', text: 'Ceník bude brzy doplněn. Služby a ceny vám rádi sdělíme telefonicky.' }));
  for (const cat of boot.categories) {
    box.append(h('div', { class: 'cat' }, h('h3', { text: cat.name }), cat.services.map((s) => h('div', { class: 'svc' },
      h('div', {}, h('div', { class: 'n', text: s.name }), s.description ? h('div', { class: 'd', text: s.description }) : ''),
      h('div', { class: 'p' }, h('div', { text: `${s.price_from ? 'od ' : ''}${money(s.price_czk)}` }), h('small', { text: dur(s.duration_minutes) }))))));
  }
  if (boot.gallery.length) {
    $('#galerie').hidden = false; $('#gal-title').textContent = c.gallery_title;
    $('#gallery').append(...boot.gallery.map((g) => h('img', { src: `/media/${g.id}`, alt: g.alt || 'Ukázka práce – HASNAILS', loading: 'lazy' })));
  }
  if (boot.instagram.configured) {
    api('/api/public/instagram').then(({ posts }) => {
      if (!posts?.length) return;
      $('#instagram').hidden = false; $('#ig-title').textContent = c.instagram_title; $('#ig-link').href = c.instagram_url;
      $('#ig-posts').append(...posts.slice(0, 8).map((p) => h('a', { href: p.permalink, rel: 'noopener', target: '_blank' }, h('img', { src: p.media_url, alt: p.caption ? p.caption.slice(0, 80) : 'Příspěvek z Instagramu', loading: 'lazy' }))));
    }).catch(() => {});
  } else if (c.instagram_url) {
    $('#instagram').hidden = false; $('#ig-title').textContent = c.instagram_title; $('#ig-link').href = c.instagram_url;
  }
  $('#info-title').textContent = c.client_info_title; $('#info-text').textContent = c.client_info_text; $('#cancel-text').textContent = c.cancellation_text;
  $('#addr').textContent = `${c.contact_name}, ${c.contact_address}`;
  $('#tel').textContent = c.contact_phone; $('#tel').href = telHref(c.contact_phone); $('#call-btn').href = telHref(c.contact_phone);
  $('#nav-btn').href = mapsDir(c);
  const t = $('#hours');
  if (!boot.hours.length) t.append(h('tr', {}, h('td', { colspan: 2, text: 'Termíny viz online rezervace.' })));
  for (const d of boot.hours) t.append(h('tr', {}, h('td', { text: d.label }), h('td', { text: d.ranges.map((r) => `${r.from}–${r.to}`).join(', ') })));
  $('#hours-note').textContent = c.contact_hours_text;
} else {
  $('#services').textContent = 'Obsah se nepodařilo načíst. Zkuste stránku obnovit.';
}
