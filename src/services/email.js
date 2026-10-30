import { query } from '../db.js';
import { config } from '../config.js';
import { log } from '../lib/log.js';
import { enqueue, PermanentError } from './jobs.js';
import { DEFAULT_TEMPLATES } from './templates.js';
import { getContent } from './content.js';

// ---- Transport (Brevo API); v testech nahraditelný ---------------------------------
let transport = null;
export const setTransport = (fn) => { transport = fn; };

export function emailProviderConfigured() {
  return Boolean(transport) || Boolean(config.brevo.apiKey && config.brevo.fromEmail);
}

async function brevoTransport({ to, subject, html, text }) {
  const body = {
    sender: { name: config.brevo.fromName, email: config.brevo.fromEmail },
    to: [{ email: to }],
    subject,
    htmlContent: html,
    textContent: text,
  };
  if (config.brevo.replyTo) body.replyTo = { email: config.brevo.replyTo };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': config.brevo.apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const txt = await res.text();
  if (!res.ok) {
    const err = new Error(`Brevo ${res.status}: ${txt.slice(0, 300)}`);
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
    throw err;
  }
  let id = null;
  try { id = JSON.parse(txt).messageId || null; } catch { /* ignore */ }
  return { messageId: id };
}

// ---- Vykreslení ---------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (tpl, vars) => String(tpl).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));

const BUTTONS = {
  booking_confirmed: ['Spravovat rezervaci', 'manage_url'],
  booking_rescheduled: ['Spravovat rezervaci', 'manage_url'],
  booking_reminder: ['Zobrazit / zrušit rezervaci', 'manage_url'],
  account_verify: ['Ověřit e-mail', 'verify_url'],
  password_reset: ['Nastavit nové heslo', 'reset_url'],
};

const CAL_TEMPLATES = new Set(['booking_confirmed', 'booking_rescheduled', 'booking_reminder']);

function calendarLinks(templateKey, vars) {
  if (!CAL_TEMPLATES.has(templateKey) || !vars.cal_start || !vars.cal_end) return [];
  const g = new URLSearchParams({ action: 'TEMPLATE', text: `HASNAILS – ${vars.service_name || 'rezervace'}`, dates: `${vars.cal_start}/${vars.cal_end}`, details: 'Rezervace v HASNAILS', location: vars.address || '' });
  const out = [['Přidat do Google kalendáře', `https://calendar.google.com/calendar/render?${g}`]];
  if (vars.ics_url) out.push(['Přidat do kalendáře (iPhone, Outlook)', vars.ics_url]);
  return out;
}

export function renderEmail(templateKey, tpl, vars, content) {
  const subject = fill(tpl.subject, vars).replace(/[\r\n]+/g, ' ').trim();
  const bodyText = fill(tpl.body, vars);
  const paragraphs = bodyText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const btn = BUTTONS[templateKey];
  const btnUrl = btn && vars[btn[1]];
  const codeLine = templateKey === 'booking_verify' && vars.code;

  // Záměrně jednoduchý vzhled (jako běžná osobní pošta): bez tabulek, pozadí, obrázků a tlačítek.
  // Poštovní služby (Gmail, Seznam) hodně stylizované zprávy řadí do „Hromadných“/spamu.
  const htmlParas = paragraphs.map((p) => {
    if (codeLine && p === String(vars.code)) return `<p style="margin:16px 0;font-size:24px"><b>${esc(p)}</b></p>`;
    return `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`;
  }).join('');
  const calLinks = calendarLinks(templateKey, vars);
  const links = [...(btnUrl ? [[btn[0], btnUrl]] : []), ...calLinks];
  const linksHtml = links.length ? `<p style="margin:0 0 14px">${links.map(([t, u]) => `${esc(t)}: <a href="${esc(u)}">${esc(u.length > 60 ? t : u)}</a>`).join('<br>')}</p>` : '';
  const html = `<!doctype html><html lang="cs"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">${htmlParas}${linksHtml}<p style="margin:20px 0 0;font-size:13px;color:#555">HASNAILS${content.contact_name ? ` · ${esc(content.contact_name)}` : ''}<br>${esc(content.contact_address || '')}<br>${esc(content.contact_phone || '')}</p></body></html>`;
  const text = `${bodyText}${btnUrl ? `\n\n${btn[0]}: ${btnUrl}` : ''}${calLinks.map(([t, u]) => `\n${t}: ${u}`).join('')}\n\n--\nHASNAILS · ${content.contact_address || ''} · ${content.contact_phone || ''}\n`;
  return { subject, html, text };
}

export async function loadTemplate(db, key) {
  const row = (await db.query('SELECT subject, body, enabled FROM email_templates WHERE key = $1', [key])).rows[0];
  if (row) return row;
  const d = DEFAULT_TEMPLATES[key];
  if (!d) throw new Error(`Neznámá e-mailová šablona: ${key}`);
  return { subject: d.subject, body: d.body, enabled: true };
}

/**
 * Zařadí e-mail k odeslání. Idempotentní podle dedupeKey – opakované volání nevytvoří druhou zprávu.
 * Volá se uvnitř transakce, která mění stav (outbox).
 */
export async function queueEmail(db, { templateKey, to, vars = {}, dedupeKey, bookingId = null }) {
  const [tpl, content] = await Promise.all([loadTemplate(db, templateKey), getContent(db)]);
  const base = {
    studio_name: 'HASNAILS', address: content.contact_address, phone: content.contact_phone,
    cancel_policy: content.cancellation_text, ...vars,
  };
  const r = renderEmail(templateKey, tpl, base, content);
  const status = tpl.enabled ? 'pending' : 'skipped';
  const ins = await db.query(
    `INSERT INTO email_log (dedupe_key, template_key, to_email, subject, html, text_body, status, booking_id, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [dedupeKey, templateKey, to, r.subject, r.html, r.text, status, bookingId, tpl.enabled ? null : 'Šablona je vypnutá'],
  );
  if (!ins.rows[0]) return { id: null, duplicate: true };
  const id = ins.rows[0].id;
  if (tpl.enabled) await enqueue(db, 'send_email', { emailId: id }, { dedupeKey: `send_email:${id}` });
  return { id, duplicate: false };
}

export async function sendEmailById(id) {
  const row = (await query(
    `UPDATE email_log SET status = 'sending', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'failed') RETURNING *`, [id],
  )).rows[0];
  if (!row) return { skipped: true }; // už odesláno nebo právě odesíláno jinde → žádná duplicita

  if (!emailProviderConfigured()) {
    await query(`UPDATE email_log SET status = 'skipped', last_error = $2, updated_at = now() WHERE id = $1`,
      [id, 'E-mailová služba není nakonfigurována (BREVO_API_KEY, MAIL_FROM_EMAIL).']);
    log.warn(`E-mail #${id} nebyl odeslán – chybí konfigurace Brevo.`);
    return { skipped: true };
  }
  try {
    const send = transport || brevoTransport;
    const res = await send({ to: row.to_email, subject: row.subject, html: row.html, text: row.text_body });
    await query(
      `UPDATE email_log SET status = 'sent', provider_message_id = $2, sent_at = now(), html = NULL, text_body = NULL,
       last_error = NULL, updated_at = now() WHERE id = $1`, [id, res?.messageId || null]);
    return { sent: true };
  } catch (err) {
    await query(`UPDATE email_log SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [id, String(err.message).slice(0, 500)]);
    if (err.permanent) throw new PermanentError(err.message);
    throw err;
  }
}

/** Ruční opakování z administrace (znovu zařadí jen neúspěšné nebo přeskočené zprávy s uloženým obsahem). */
export async function retryEmail(db, id) {
  const r = await db.query(
    `UPDATE email_log SET status = 'pending', last_error = NULL, updated_at = now()
     WHERE id = $1 AND status IN ('failed', 'skipped') AND html IS NOT NULL RETURNING id`, [id]);
  if (!r.rows[0]) return false;
  await db.query(`DELETE FROM jobs WHERE dedupe_key = $1`, [`send_email:${id}`]);
  await enqueue(db, 'send_email', { emailId: id }, { dedupeKey: `send_email:${id}` });
  return true;
}

/** Stav doručení z Brevo webhooků */
export async function applyBrevoEvent(db, ev) {
  const mid = ev['message-id'] || ev.messageId;
  if (!mid) return;
  const event = String(ev.event || '').toLowerCase();
  let status = null;
  if (event === 'delivered') status = 'delivered';
  else if (['hard_bounce', 'hardbounce', 'blocked', 'invalid', 'invalid_email', 'error', 'soft_bounce', 'softbounce'].includes(event)) status = 'bounced';
  if (!status) return;
  await db.query(
    `UPDATE email_log SET status = $2, last_error = CASE WHEN $2 = 'bounced' THEN $3 ELSE last_error END, updated_at = now()
     WHERE provider_message_id = $1 AND (status IN ('sent', 'delivered') OR $2 = 'bounced')`,
    [String(mid), status, `Brevo: ${event}${ev.reason ? ' – ' + String(ev.reason).slice(0, 200) : ''}`],
  );
}
