import { query } from '../db.js';
import { config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { enqueue } from '../services/jobs.js';
import { applyBrevoEvent } from '../services/email.js';
import { log } from '../lib/log.js';

export function mount(app) {
  // Push notifikace Google (hlavičky) i Microsoft Graph (validationToken + JSON). Slouží jen jako „probuzení“ –
  // data se stejně vždy načtou z API poskytovatele, takže podvržený požadavek nemůže nic vložit.
  app.post('/api/webhooks/calendar/:sourceId', async (ctx) => {
    const vt = ctx.query.validationToken;
    if (vt) { ctx.send(200, String(vt), { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    const uuidOk = /^[0-9a-f-]{36}$/i.test(ctx.params.sourceId);
    const src = uuidOk ? (await query(`SELECT id, watch_id, watch_secret FROM calendar_sources WHERE id = $1`, [ctx.params.sourceId])).rows[0] : null;
    if (!src || !src.watch_secret) throw new HttpError(404, 'not_found', 'Nenalezeno.');

    let valid = false;
    const gToken = ctx.req.headers['x-goog-channel-token'];
    if (gToken) {
      valid = safeEqual(String(gToken), src.watch_secret) && ctx.req.headers['x-goog-channel-id'] === src.watch_id;
      if (valid && ctx.req.headers['x-goog-resource-state'] === 'sync') { ctx.send(200, ''); return; }
    } else {
      let body = {};
      try { body = await ctx.json(); } catch { /* ne JSON */ }
      valid = Array.isArray(body.value) && body.value.some((n) => typeof n.clientState === 'string' && safeEqual(n.clientState, src.watch_secret));
    }
    if (!valid) throw new HttpError(403, 'forbidden', 'Neplatný požadavek.');
    await enqueue({ query }, 'calendar_sync_source', { sourceId: src.id }, { dedupeKey: `push:${src.id}:${Math.floor(Date.now() / 10_000)}`, maxAttempts: 3 });
    ctx.send(202, '');
  });

  // Stav doručení z Brevo (nastavte v Brevo: Transactional → Settings → Webhooks, URL s parametrem ?secret=…)
  app.post('/api/webhooks/brevo', async (ctx) => {
    if (!config.brevo.webhookSecret || !safeEqual(String(ctx.query.secret || ''), config.brevo.webhookSecret)) throw new HttpError(404, 'not_found', 'Nenalezeno.');
    const body = await ctx.json(256_000);
    const events = Array.isArray(body) ? body : [body];
    for (const ev of events.slice(0, 200)) {
      try { await applyBrevoEvent({ query }, ev); } catch (err) { log.warn('Brevo webhook: událost se nepodařilo zpracovat', err); }
    }
    return { ok: true };
  });
}
