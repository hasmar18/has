// Konfigurace z proměnných prostředí. Žádné tajné údaje se nikdy neposílají do prohlížeče.
const env = process.env;

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig() {
  const isProd = env.NODE_ENV === 'production';
  const baseUrl = (env.BASE_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/+$/, '');
  return {
    isProd,
    port: int(env.PORT, 3000),
    baseUrl,
    databaseUrl: env.DATABASE_URL || '',
    databaseSsl: bool(env.DATABASE_SSL, false),
    encryptionKey: env.ENCRYPTION_KEY || '',
    runWorker: bool(env.RUN_WORKER, true),
    secureCookies: baseUrl.startsWith('https://'),
    resend: { apiKey: env.RESEND_API_KEY || '' },
    brevo: {
      apiKey: env.BREVO_API_KEY || '',
      fromEmail: env.MAIL_FROM_EMAIL || '',
      fromName: env.MAIL_FROM_NAME || 'HASNAILS',
      replyTo: env.MAIL_REPLY_TO || '',
      webhookSecret: env.BREVO_WEBHOOK_SECRET || '',
    },
    google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
    microsoft: {
      clientId: env.MS_CLIENT_ID || '',
      clientSecret: env.MS_CLIENT_SECRET || '',
      tenant: env.MS_TENANT || 'common',
    },
    admin: { email: env.ADMIN_EMAIL || '', initialPassword: env.ADMIN_INITIAL_PASSWORD || '' },
  };
}

export const config = loadConfig();
