import { setOAuthCreds, oauthStatus } from '../services/oauthCreds.js';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { config } from '../config.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { encrypt, signState, verifyState, randomToken } from '../lib/crypto.js';
import { audit } from '../services/audit.js';
import { enqueue } from '../services/jobs.js';
import { getProvider, listProviders } from '../calendar/providers.js';
import { getAccessToken, ensureWatch } from '../calendar/engine.js';
import * as instagram from '../services/instagram.js';
import { requireAdmin } from './middleware.js';
import { uuid } from './schemas.js';

const A = requireAdmin;
const redirectUriFor = (provider) => `${config.baseUrl}/api/admin/calendar/callback/${provider}`;

const ENV_HINT = {
  google: 'GOOGLE_CLIENT_ID a GOOGLE_CLIENT_SECRET',
  microsoft: 'MS_CLIENT_ID a MS_CLIENT_SECRET',
};

async function listConnections() {
  const [conns, sources] = await Promise.all([
    query(`SELECT id, provider, account_email, status, last_error, last_error_at, last_success_at, consecutive_failures, write_enabled, write_calendar_id, write_calendar_name FROM calendar_connections ORDER BY created_at`),
    query(`SELECT id, connection_id, external_calendar_id, name, blocks_availability, block_all_day, last_synced_at, last_sync_ok, last_error, watch_expires_at FROM calendar_sources ORDER BY name`),
  ]);
  return conns.rows.map((c) => {
    let label = c.provider;
    try { label = getProvider(c.provider).label; } catch { /* poskytovatel už není registrován */ }
    return {
      ...c, label,
      sources: sources.rows.filter((s) => s.connection_id === c.id).map((s) => ({ ...s, push_active: Boolean(s.watch_expires_at && new Date(s.watch_expires_at) > new Date()) })),
    };
  });
}

export function mount(app) {
  app.get('/api/admin/calendar-connections', A, async () => ({
    connections: await listConnections(),
    providers: listProviders().map((p) => ({ ...p, env_hint: ENV_HINT[p.name] || '' })),
    redirect_uris: Object.fromEntries(['google', 'microsoft'].map((n) => [n, redirectUriFor(n)])),
    unsupported: [{ name: 'apple', label: 'Apple Kalendář / iCloud', reason: 'Apple nenabízí OAuth ani push notifikace pro iCloud kalendář. Spolehlivá obousměrná synchronizace není bezpečně možná – doporučujeme používat Google nebo Outlook kalendář (lze do něj přidat i iCloud událost přes sdílení).' }],
  }));

  app.get('/api/admin/calendar-oauth', A, async () => ({ google: oauthStatus('google'), microsoft: oauthStatus('microsoft'), redirect_uris: { google: redirectUriFor('google'), microsoft: redirectUriFor('microsoft') } }));
  app.put('/api/admin/calendar-oauth/:provider', A, async (ctx) => {
    if (!['google', 'microsoft'].includes(ctx.params.provider)) throw notFound();
    const b = z.object({ client_id: z.string().trim().max(300), client_secret: z.string().trim().max(300) }).parse(await ctx.json());
    if (Boolean(b.client_id) !== Boolean(b.client_secret)) throw badRequest('Vyplňte Client ID i Client secret.');
    try { await setOAuthCreds(ctx.params.provider, { clientId: b.client_id, clientSecret: b.client_secret }); }
    catch (e) { if (e.status === 400) throw badRequest(e.message); throw e; }
    await audit({ query }, ctx.user.id, 'calendar.oauth_credentials', 'oauth', ctx.params.provider, { set: Boolean(b.client_id) });
    return oauthStatus(ctx.params.provider);
  });

  app.post('/api/admin/calendar/connect', A, async (ctx) => {
    const { provider } = z.object({ provider: z.string().max(30) }).parse(await ctx.json());
    const p = getProvider(provider);
    if (!p.isConfigured()) throw badRequest(`Propojení ${p.label} zatím není nastaveno na serveru (chybí ${ENV_HINT[provider] || 'klíče'} v prostředí).`, 'provider_not_configured');
    const state = signState({ sid: ctx.session.sid, p: provider, exp: Date.now() + 10 * 60_000, n: randomToken(8) });
    return { url: p.authUrl({ state, redirectUri: redirectUriFor(provider) }) };
  });

  // Návrat z přihlášení u poskytovatele (běžná navigace prohlížeče, relace je v cookie)
  app.get('/api/admin/calendar/callback/:provider', async (ctx) => {
    const fail = (msg) => ctx.redirect(`/admin#/nastaveni?kalendar_chyba=${encodeURIComponent(msg)}`);
    if (!ctx.user || ctx.user.role !== 'admin') return ctx.redirect('/admin');
    if (ctx.query.error) return fail(`Poskytovatel vrátil chybu: ${String(ctx.query.error_description || ctx.query.error).slice(0, 120)}`);
    const st = verifyState(ctx.query.state);
    if (!st || st.sid !== ctx.session.sid || st.p !== ctx.params.provider || st.exp < Date.now()) return fail('Neplatný nebo vypršelý požadavek na propojení. Zkuste to prosím znovu.');
    try {
      const provider = getProvider(ctx.params.provider);
      const redirectUri = redirectUriFor(provider.name);
      const tok = await provider.exchangeCode({ code: String(ctx.query.code), redirectUri });
      const account = await provider.getAccountEmail(tok.accessToken);
      const expiresAt = new Date(Date.now() + (tok.expiresIn || 3000) * 1000);
      const conn = (await query(
        `INSERT INTO calendar_connections (provider, account_email, refresh_token_enc, access_token_enc, access_expires_at, status, last_success_at)
         VALUES ($1, $2, $3, $4, $5, 'active', now())
         ON CONFLICT (provider, account_email) DO UPDATE SET refresh_token_enc = EXCLUDED.refresh_token_enc,
           access_token_enc = EXCLUDED.access_token_enc, access_expires_at = EXCLUDED.access_expires_at, status = 'active',
           last_error = NULL, consecutive_failures = 0, alerted_at = NULL RETURNING *`,
        [provider.name, account, encrypt(tok.refreshToken), encrypt(tok.accessToken), expiresAt])).rows[0];
      const cals = await provider.listCalendars(tok.accessToken);
      for (const c of cals) {
        await query(
          `INSERT INTO calendar_sources (connection_id, external_calendar_id, name, blocks_availability) VALUES ($1, $2, $3, $4)
           ON CONFLICT (connection_id, external_calendar_id) DO UPDATE SET name = EXCLUDED.name`, [conn.id, c.id, c.name, c.primary]);
      }
      await audit({ query }, ctx.user.id, 'calendar.connect', 'calendar_connection', conn.id, { provider: provider.name });
      const sources = (await query(`SELECT id FROM calendar_sources WHERE connection_id = $1 AND blocks_availability`, [conn.id])).rows;
      for (const s of sources) await enqueue({ query }, 'calendar_sync_source', { sourceId: s.id }, { dedupeKey: `syncnow:${s.id}:${Date.now()}`, maxAttempts: 2 });
      return ctx.redirect('/admin#/nastaveni?kalendar=pripojeno');
    } catch (err) {
      return fail(err.message || 'Propojení se nezdařilo.');
    }
  });

  app.get('/api/admin/calendar-connections/:id/calendars', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const conn = (await query(`SELECT * FROM calendar_connections WHERE id = $1`, [ctx.params.id])).rows[0];
    if (!conn) throw notFound();
    const calendars = await getProvider(conn.provider).listCalendars(await getAccessToken(conn));
    return { calendars };
  });

  app.put('/api/admin/calendar-connections/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const b = z.object({
      write_enabled: z.boolean().optional(), write_calendar_id: z.string().max(300).nullable().optional(), write_calendar_name: z.string().max(200).nullable().optional(),
      sources: z.array(z.object({ external_calendar_id: z.string().max(300), name: z.string().max(200).default(''), blocks_availability: z.boolean(), block_all_day: z.boolean().default(true) })).max(100).optional(),
    }).parse(await ctx.json());
    const conn = (await query(`SELECT * FROM calendar_connections WHERE id = $1`, [ctx.params.id])).rows[0];
    if (!conn) throw notFound();
    await withTx(async (tx) => {
      if (b.sources) {
        for (const s of b.sources) {
          await tx.query(
            `INSERT INTO calendar_sources (connection_id, external_calendar_id, name, blocks_availability, block_all_day) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (connection_id, external_calendar_id) DO UPDATE SET name = EXCLUDED.name, blocks_availability = EXCLUDED.blocks_availability, block_all_day = EXCLUDED.block_all_day`,
            [conn.id, s.external_calendar_id, s.name, s.blocks_availability, s.block_all_day]);
        }
      }
      if (b.write_enabled !== undefined || b.write_calendar_id !== undefined) {
        const enabled = b.write_enabled ?? conn.write_enabled;
        const calId = b.write_calendar_id !== undefined ? b.write_calendar_id : conn.write_calendar_id;
        if (enabled && !calId) throw badRequest('Vyberte kalendář, do kterého se mají rezervace zapisovat.');
        if (enabled) await tx.query(`UPDATE calendar_connections SET write_enabled = false WHERE id <> $1`, [conn.id]);
        await tx.query(`UPDATE calendar_connections SET write_enabled = $2, write_calendar_id = $3, write_calendar_name = COALESCE($4, write_calendar_name) WHERE id = $1`,
          [conn.id, enabled, calId, b.write_calendar_name ?? null]);
        if (enabled && calId) {
          await tx.query(`INSERT INTO calendar_sources (connection_id, external_calendar_id, name) VALUES ($1, $2, $3) ON CONFLICT (connection_id, external_calendar_id) DO NOTHING`, [conn.id, calId, b.write_calendar_name || '']);
        }
      }
      await audit(tx, ctx.user.id, 'calendar.update', 'calendar_connection', conn.id, { write_enabled: b.write_enabled, sources: b.sources?.length });
    });
    // Okamžitě načíst blokace a doplnit případné chybějící zápisy do kalendáře
    await enqueue({ query }, 'calendar_sync_all', {}, { dedupeKey: `syncall:manual:${Date.now()}`, maxAttempts: 1 });
    const sources = (await query(`SELECT id FROM calendar_sources WHERE connection_id = $1 AND blocks_availability`, [conn.id])).rows;
    for (const s of sources) await enqueue({ query }, 'calendar_watch', { sourceId: s.id }, { dedupeKey: `watch:${s.id}:${Date.now()}`, maxAttempts: 2 });
    return { connections: await listConnections() };
  });

  app.post('/api/admin/calendar-connections/:id/sync', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const sources = (await query(`SELECT id FROM calendar_sources WHERE connection_id = $1 AND (blocks_availability OR external_calendar_id = (SELECT write_calendar_id FROM calendar_connections WHERE id = $1))`, [ctx.params.id])).rows;
    const { syncSourceById, enqueueMissingPushes } = await import('../calendar/engine.js');
    const results = [];
    for (const s of sources) {
      try { results.push({ id: s.id, ...(await syncSourceById(s.id)) }); } catch (err) { results.push({ id: s.id, error: err.message }); }
    }
    await enqueueMissingPushes({ hourBucket: `manual${Date.now()}` });
    return { results, connections: await listConnections() };
  });

  app.delete('/api/admin/calendar-connections/:id', A, async (ctx) => {
    if (!uuid.safeParse(ctx.params.id).success) throw notFound();
    const conn = (await query(`SELECT * FROM calendar_connections WHERE id = $1`, [ctx.params.id])).rows[0];
    if (!conn) throw notFound();
    try {
      const provider = getProvider(conn.provider);
      if (provider.stopWatch) {
        const token = await getAccessToken(conn);
        const watches = (await query(`SELECT watch_id, watch_resource_id FROM calendar_sources WHERE connection_id = $1 AND watch_id IS NOT NULL`, [conn.id])).rows;
        for (const w of watches) { try { await provider.stopWatch(token, { watchId: w.watch_id, resourceId: w.watch_resource_id }); } catch { /* best effort */ } }
      }
    } catch { /* odpojujeme i při nefunkčním tokenu */ }
    await query(`DELETE FROM calendar_connections WHERE id = $1`, [conn.id]);
    await audit({ query }, ctx.user.id, 'calendar.disconnect', 'calendar_connection', conn.id, { provider: conn.provider });
    return { connections: await listConnections() };
  });

  // ---- Instagram (oficiální API – vložení přístupového tokenu) -------------------------------
  app.get('/api/admin/instagram', A, async () => ({ configured: await instagram.instagramConfigured() }));
  app.put('/api/admin/instagram', A, async (ctx) => {
    const b = z.object({ access_token: z.string().trim().max(2000) }).parse(await ctx.json());
    await instagram.setToken(b.access_token || null);
    await audit({ query }, ctx.user.id, b.access_token ? 'instagram.token_set' : 'instagram.token_removed', 'instagram');
    return { configured: Boolean(b.access_token) };
  });
}
