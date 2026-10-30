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

  const htmlParas = paragraphs.map((p) => {
    if (codeLine && p === String(vars.code)) {
      return `<p style="margin:24px 0;text-align:center"><span style="display:inline-block;font-size:32px;letter-spacing:8px;font-weight:700;padding:14px 22px;background:#f6ece8;border-radius:12px;color:#3b2430">${esc(p)}</span></p>`;
    }
    return `<p style="margin:0 0 16px;line-height:1.6">${esc(p).replace(/\n/g, '<br>')}</p>`;
  }).join('');
  const button = btnUrl
    ? `<p style="margin:28px 0;text-align:center"><a href="${esc(btnUrl)}" style="display:inline-block;background:#3b2430;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:600">${esc(btn[0])}</a></p>`
    : '';
  const calLinks = calendarLinks(templateKey, vars);
  const calHtml = calLinks.length ? `<p style="margin:0 0 24px;text-align:center;font-size:14px">${calLinks.map(([t, u]) => `<a href="${esc(u)}" style="display:inline-block;margin:4px 6px;padding:10px 18px;border:1px solid #3b2430;border-radius:999px;color:#3b2430;text-decoration:none;font-weight:600">${esc(t)}</a>`).join('')}</p>` : '';
  const studio = esc(content.contact_name || '');
  const html = `<!doctype html><html lang="cs"><body style="margin:0;background:#faf6f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2a2024">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden">
<tr><td style="padding:28px 32px 8px;text-align:center"><div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:6px;color:#3b2430">HASNAILS</div></td></tr>
<tr><td style="padding:16px 32px 8px;font-size:16px">${htmlParas}${button}${calHtml}</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:13px;color:#7a6a70;border-top:1px solid #f0e6e2">${studio}${studio ? ' · ' : ''}${esc(content.contact_address || '')}<br>${esc(content.contact_phone || '')}</td></tr>
</table></td></tr></table></body></html>`;
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
