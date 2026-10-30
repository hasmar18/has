// Malý HTTP framework nad node:http – záměrně bez externích závislostí.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { HttpError, tooMany } from './errors.js';
import { log } from './log.js';

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.expires) s += `; Expires=${opts.expires.toUTCString()}`;
  s += `; Path=${opts.path || '/'}`;
  if (opts.httpOnly !== false) s += '; HttpOnly';
  if (opts.secure) s += '; Secure';
  s += `; SameSite=${opts.sameSite || 'Lax'}`;
  return s;
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.xml': 'application/xml; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.xml', '.webmanifest']);

export class Context {
  constructor(req, res, url) {
    this.req = req;
    this.res = res;
    this.url = url;
    this.query = Object.fromEntries(url.searchParams);
    this.params = {};
    this.cookies = parseCookies(req.headers.cookie);
    this.ip = clientIp(req);
    this.session = null;
    this.user = null;
    this.state = {};
    this._cookiesOut = [];
  }

  setCookie(name, value, opts) { this._cookiesOut.push(serializeCookie(name, value, opts)); }
  clearCookie(name, opts = {}) { this._cookiesOut.push(serializeCookie(name, '', { ...opts, maxAge: 0, expires: new Date(0) })); }

  async buffer(limit = 1_000_000) {
    if (this._buf) return this._buf;
    const chunks = [];
    let size = 0;
    for await (const chunk of this.req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'payload_too_large', 'Požadavek je příliš velký.');
      chunks.push(chunk);
    }
    this._buf = Buffer.concat(chunks);
    return this._buf;
  }

  async json(limit = 1_000_000) {
    const ct = this.req.headers['content-type'] || '';
    if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Očekává se application/json.');
    const buf = await this.buffer(limit);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', 'Neplatný JSON.'); }
  }

  send(status, body, headers = {}) {
    if (this.res.headersSent) return;
    const h = { ...headers };
    if (this._cookiesOut.length) h['Set-Cookie'] = this._cookiesOut;
    this.res.writeHead(status, h);
    this.res.end(body);
  }

  sendJson(data, status = 200) {
    this.send(status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  redirect(location, status = 302) { this.send(status, '', { Location: location }); }
}

export function securityHeaders(isProd) {
  const h = {
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: https:",
      "font-src 'self'", "connect-src 'self'", "frame-src https://www.google.com https://maps.google.com",
      "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
  if (isProd) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

/** Jednoduchý omezovač počtu požadavků v paměti (fixní okno). */
export function rateLimit({ windowMs, max, name, keyFn }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  timer.unref();
  const mw = async (ctx, next) => {
    if (process.env.DISABLE_RATE_LIMIT === '1') return next();
    const key = `${name}:${keyFn ? keyFn(ctx) : ctx.ip}`;
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
    e.count += 1;
    if (e.count > max) {
      ctx.res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      throw tooMany();
    }
    return next();
  };
  mw.reset = () => hits.clear();
  return mw;
}

export class App {
  constructor() {
    this.routes = [];
    this.globalMw = [];
    this.staticDirs = [];
    this.onError = null;
    this.headers = {};
    this.notFoundFile = null;
  }

  use(mw) { this.globalMw.push(mw); return this; }

  route(method, pattern, ...fns) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, fns });
    return this;
  }
  get(p, ...f) { return this.route('GET', p, ...f); }
  post(p, ...f) { return this.route('POST', p, ...f); }
  put(p, ...f) { return this.route('PUT', p, ...f); }
  patch(p, ...f) { return this.route('PATCH', p, ...f); }
  delete(p, ...f) { return this.route('DELETE', p, ...f); }

  serveStatic(dir, { pages = {} } = {}) { this.staticDirs.push({ dir: path.resolve(dir), pages }); }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const ctx = new Context(req, res, url);
    for (const [k, v] of Object.entries(this.headers)) res.setHeader(k, v);
    try {
      await this._dispatch(ctx);
    } catch (err) {
      this._handleError(ctx, err);
    }
  }

  async _dispatch(ctx) {
    const { req, url } = ctx;
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let matched = null;
    let pathMismatch = false;
    for (const r of this.routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      if (r.method !== method) { pathMismatch = true; continue; }
      matched = { r, m };
      break;
    }
    const run = async (fns, i = 0) => {
      const fn = fns[i];
      if (!fn) return undefined;
      if (i === fns.length - 1) return fn(ctx);
      return fn(ctx, () => run(fns, i + 1));
    };
    if (matched) {
      matched.r.keys.forEach((k, idx) => { try { ctx.params[k] = decodeURIComponent(matched.m[idx + 1]); } catch { ctx.params[k] = matched.m[idx + 1]; } });
      const out = await run([...this.globalMw, ...matched.r.fns]);
      if (!ctx.res.headersSent) {
        if (out === undefined) ctx.send(204, '');
        else if (Buffer.isBuffer(out)) ctx.send(200, out);
        else ctx.sendJson(out);
      }
      return;
    }
    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      const served = await this._static(ctx, url.pathname);
      if (served) return;
    }
    if (pathMismatch) throw new HttpError(405, 'method_not_allowed', 'Metoda není povolena.');
    if (method === 'GET' && !url.pathname.startsWith('/api/') && this.notFoundFile) {
      try {
        const st = await fsp.stat(this.notFoundFile);
        const body = await fsp.readFile(this.notFoundFile);
        return ctx.send(404, ctx.req.method === 'HEAD' ? '' : body, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', 'Content-Length': st.size });
      } catch { /* bez vlastní stránky */ }
    }
    throw new HttpError(404, 'not_found', 'Nenalezeno.');
  }

  async _static(ctx, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return false; }
    if (rel.includes('\0')) return false;
    for (const { dir, pages } of this.staticDirs) {
      let target = pages[rel.replace(/\/+$/, '') || '/'];
      const candidates = [];
      if (target) candidates.push(path.join(dir, target));
      else {
        const clean = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
        candidates.push(path.join(dir, clean));
        if (rel.endsWith('/')) candidates.push(path.join(dir, clean, 'index.html'));
        else candidates.push(path.join(dir, clean + '.html'), path.join(dir, clean, 'index.html'));
      }
      for (const file of candidates) {
        if (!file.startsWith(dir + path.sep) && file !== dir) continue;
        let st;
        try { st = await fsp.stat(file); } catch { continue; }
        if (!st.isFile()) continue;
        await this._sendFile(ctx, file, st);
        return true;
      }
    }
    return false;
  }

  async _sendFile(ctx, file, st) {
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    const headers = {
      'Content-Type': type,
      ETag: etag,
      'Cache-Control': ['.html', '.css', '.js', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
    };
    if (ctx.req.headers['if-none-match'] === etag) return ctx.send(304, '', headers);
    let body = await fsp.readFile(file);
    const accepts = String(ctx.req.headers['accept-encoding'] || '');
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(accepts) && body.length > 1024) {
      body = zlib.gzipSync(body);
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    ctx.send(200, ctx.req.method === 'HEAD' ? '' : body, headers);
  }

  _handleError(ctx, err) {
    if (ctx.res.headersSent) { ctx.res.end(); return; }
    if (err instanceof HttpError) {
      return ctx.sendJson({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
    }
    if (err && err.name === 'ZodError') {
      const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return ctx.sendJson({ error: { code: 'validation_error', message: 'Zkontrolujte prosím vyplněné údaje.', issues } }, 400);
    }
    const id = crypto.randomBytes(4).toString('hex');
    log.error(`Neošetřená chyba [${id}] ${ctx.req.method} ${ctx.url.pathname}`, err);
    ctx.sendJson({ error: { code: 'internal_error', message: `Došlo k chybě serveru (kód ${id}). Zkuste to prosím znovu.` } }, 500);
  }

  listen(port) {
    const server = http.createServer((req, res) => { this.handle(req, res); });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    return new Promise((resolve) => server.listen(port, () => resolve(server)));
  }
}
