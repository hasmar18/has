import { config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { sessionFromToken } from '../services/auth.js';

export const SESSION_COOKIE = 'hn_sid';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Načte relaci z cookie (pokud existuje). Nic nevynucuje. */
export async function sessionMw(ctx, next) {
  const token = ctx.cookies[SESSION_COOKIE];
  if (token) {
    const s = await sessionFromToken(token);
    if (s) { ctx.session = s; ctx.user = s.user; ctx.sessionToken = token; }
    else ctx.clearCookie(SESSION_COOKIE, { secure: config.secureCookies });
  }
  return next();
}

/** Veřejná GET stránka na jiném hostu (www., onrender.com) → přesměrování na hlavní adresu (BASE_URL). V produkci jinak cookies a Origin nesedí. */
export async function canonicalHostMw(ctx, next) {
  const host = String(ctx.req.headers.host || '').toLowerCase();
  if (config.isProd && host && ['GET', 'HEAD'].includes(ctx.req.method) && ctx.req.url !== '/healthz') {
    let want = '';
    try { want = new URL(config.baseUrl).host; } catch { /* BASE_URL neplatná */ }
    if (want && host !== want && !/^(localhost|127\.)/.test(host)) return ctx.redirect(`${config.baseUrl}${ctx.req.url}`, 308);
  }
  return next();
}

/** Obrana proti cross-site požadavkům: kontrola hlavičky Origin u změn (kromě webhooků od třetích stran). */
export async function originMw(ctx, next) {
  if (UNSAFE.has(ctx.req.method) && !ctx.url.pathname.startsWith('/api/webhooks/')) {
    const origin = ctx.req.headers.origin;
    if (origin && origin !== config.baseUrl) {
      let ok = false;
      try { ok = new URL(origin).host === new URL(config.baseUrl).host; } catch { /* neplatný Origin */ }
      if (!ok) throw forbidden('Požadavek z cizího původu byl odmítnut.');
    }
  }
  return next();
}

export function checkCsrf(ctx) {
  if (!UNSAFE.has(ctx.req.method)) return;
  const sent = ctx.req.headers['x-csrf-token'];
  if (!ctx.session || typeof sent !== 'string' || !safeEqual(sent, ctx.session.csrf)) {
    throw forbidden('Neplatný bezpečnostní token. Obnovte prosím stránku.');
  }
}

export async function requireUser(ctx, next) {
  if (!ctx.user) throw unauthorized();
  checkCsrf(ctx);
  return next();
}

/** Přihlášený, ale nepovinně: pokud relace existuje a jde o změnu, vyžaduje CSRF token. */
export async function optionalUser(ctx, next) {
  if (ctx.user) checkCsrf(ctx);
  return next();
}

export async function requireAdmin(ctx, next) {
  if (!ctx.user) throw unauthorized();
  if (ctx.user.role !== 'admin') throw forbidden('Tato část je pouze pro správce.');
  checkCsrf(ctx);
  if (ctx.user.must_change_password) throw forbidden('Nejdříve si prosím změňte úvodní heslo.');
  return next();
}
