import { z } from 'zod';
import { config } from '../config.js';
import { rateLimit } from '../lib/http.js';
import { unauthorized } from '../lib/errors.js';
import * as auth from '../services/auth.js';
import { query } from '../db.js';
import { SESSION_COOKIE, requireUser } from './middleware.js';
import { registerBody, loginBody, email, password, personName, optionalPhone } from './schemas.js';

const loginLimit = rateLimit({ name: 'login', windowMs: 15 * 60_000, max: 20 });
const registerLimit = rateLimit({ name: 'register', windowMs: 3600_000, max: 10 });
const forgotLimit = rateLimit({ name: 'forgot', windowMs: 3600_000, max: 8 });
const tokenLimit = rateLimit({ name: 'token', windowMs: 15 * 60_000, max: 30 });

function setSessionCookie(ctx, session) {
  ctx.setCookie(SESSION_COOKIE, session.token, { maxAge: session.maxAgeSec, httpOnly: true, secure: config.secureCookies, sameSite: 'Lax' });
}

export function mount(app) {
  app.post('/api/auth/register', registerLimit, async (ctx) => auth.register(registerBody.parse(await ctx.json())));

  app.post('/api/auth/login', loginLimit, async (ctx) => {
    const body = loginBody.parse(await ctx.json());
    const { user, session } = await auth.login({ ...body, userAgent: ctx.req.headers['user-agent'] });
    setSessionCookie(ctx, session);
    return { user, csrf_token: session.csrf };
  });

  app.post('/api/auth/logout', async (ctx) => {
    if (ctx.sessionToken) await auth.logout(ctx.sessionToken);
    ctx.clearCookie(SESSION_COOKIE, { secure: config.secureCookies });
    return { ok: true };
  });

  app.get('/api/auth/me', async (ctx) => {
    if (!ctx.user) return { user: null };
    return { user: auth.publicUser(ctx.user), csrf_token: ctx.session.csrf };
  });

  app.post('/api/auth/verify-email', tokenLimit, async (ctx) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(await ctx.json());
    return { user: await auth.verifyEmail(token) };
  });

  app.post('/api/auth/resend-verification', requireUser, async (ctx) => auth.resendVerification(ctx.user.id));

  app.post('/api/auth/forgot', forgotLimit, async (ctx) => auth.requestPasswordReset(z.object({ email }).parse(await ctx.json()).email));

  app.post('/api/auth/reset', tokenLimit, async (ctx) => {
    const b = z.object({ token: z.string().min(10).max(200), password }).parse(await ctx.json());
    return auth.resetPassword(b.token, b.password);
  });

  app.post('/api/auth/change-password', requireUser, async (ctx) => {
    const b = z.object({ current_password: z.string().min(1).max(200), new_password: password }).parse(await ctx.json());
    return auth.changePassword(ctx.user.id, b.current_password, b.new_password, ctx.session.sid);
  });

  app.patch('/api/me', requireUser, async (ctx) => {
    const b = z.object({ name: personName.optional(), phone: optionalPhone.optional() }).parse(await ctx.json());
    return { user: await auth.updateProfile(ctx.user.id, b) };
  });

  app.delete('/api/me', requireUser, async (ctx) => {
    const b = z.object({ password: z.string().min(1).max(200) }).parse(await ctx.json());
    await auth.deleteAccount(ctx.user.id, b.password);
    ctx.clearCookie(SESSION_COOKIE, { secure: config.secureCookies });
    return { ok: true };
  });
}
