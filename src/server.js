import { config } from './config.js';
import { migrate, closePool, query } from './db.js';
import { log } from './lib/log.js';
import { createApp } from './app.js';
import { seedDefaults, seedServices } from './services/seed.js';
import { loadOAuthCreds } from './services/oauthCreds.js';
import { bootstrapAdmin } from './services/auth.js';
import { registerProvider } from './calendar/providers.js';
import { google } from './calendar/google.js';
import { microsoft } from './calendar/microsoft.js';
import { startWorker } from './worker.js';

async function main() {
  if (config.isProd) {
    const missing = [];
    if (!config.databaseUrl) missing.push('DATABASE_URL');
    if (!config.encryptionKey) missing.push('ENCRYPTION_KEY');
    if (!process.env.BASE_URL) missing.push('BASE_URL');
    if (missing.length) { log.error(`Chybí povinné proměnné prostředí: ${missing.join(', ')}`); process.exit(1); }
    if (!config.baseUrl.startsWith('https://')) log.warn('BASE_URL není https – cookies a OAuth nebudou bezpečně fungovat.');
  }
  registerProvider(google);
  registerProvider(microsoft);
  await migrate();
  await seedDefaults();
  await seedServices();
  await loadOAuthCreds();
  await bootstrapAdmin();

  const app = createApp();
  const server = await app.listen(config.port);
  log.info(`HASNAILS běží na portu ${config.port} (${config.baseUrl})`);
  const stopWorker = config.runWorker ? startWorker() : () => {};

  const shutdown = async (sig) => {
    log.info(`${sig} – ukončuji`);
    stopWorker();
    server.close(async () => { await closePool(); process.exit(0); });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => { log.error('Spuštění selhalo', err); process.exit(1); });
