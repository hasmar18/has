import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, securityHeaders } from './lib/http.js';
import { config } from './config.js';
import { query } from './db.js';
import { originMw, sessionMw } from './routes/middleware.js';
import * as authRoutes from './routes/auth.js';
import * as publicRoutes from './routes/public.js';
import * as adminRoutes from './routes/admin.js';
import * as adminCalendarRoutes from './routes/adminCalendar.js';
import * as webhookRoutes from './routes/webhooks.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = new App();
  app.headers = securityHeaders(config.isProd);
  app.use(originMw);
  app.use(sessionMw);

  app.get('/healthz', async () => { await query('SELECT 1'); return { ok: true }; });

  authRoutes.mount(app);
  publicRoutes.mount(app);
  adminRoutes.mount(app);
  adminCalendarRoutes.mount(app);
  webhookRoutes.mount(app);

  app.serveStatic(publicDir);
  app.notFoundFile = path.join(publicDir, '404.html');
  return app;
}
