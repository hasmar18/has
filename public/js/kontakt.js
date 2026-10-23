import { $, h, initPage, telHref, mapsDir } from './common.js';
const boot = await initPage('/kontakt');
if (boot) {
  const c = boot.content;
  $('#name').textContent = c.contact_name; $('#addr').textContent = c.contact_address;
  $('#tel').textContent = c.contact_phone; $('#tel').href = telHref(c.contact_phone); $('#call-btn').href = telHref(c.contact_phone);
  $('#nav-btn').href = mapsDir(c); $('#ig').href = c.instagram_url;
  if (c.contact_email) { const m = $('#mail'); m.hidden = false; m.append(h('a', { href: `mailto:${c.contact_email}`, text: c.contact_email })); }
  $('#map').src = `https://maps.google.com/maps?q=${encodeURIComponent(c.contact_lat)},${encodeURIComponent(c.contact_lng)}&z=16&output=embed`;
  for (const d of boot.hours) $('#hours').append(h('tr', {}, h('td', { text: d.label }), h('td', { text: d.ranges.map((r) => `${r.from}–${r.to}`).join(', ') })));
  $('#hours-note').textContent = c.contact_hours_text;
}
