// Přihlašovací údaje OAuth aplikací (Google / Microsoft) zadané v administraci.
// Uložené jsou šifrovaně v tabulce secrets; proměnné prostředí mají přednost (a v administraci jsou jen k čtení).
import { query } from '../db.js';
import { config } from '../config.js';
import { encrypt, decrypt } from '../lib/crypto.js';

const TARGET = { google: config.google, microsoft: config.microsoft };
const ENV = { google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], microsoft: ['MS_CLIENT_ID', 'MS_CLIENT_SECRET'] };
const fromEnv = (p) => Boolean(process.env[ENV[p][0]] && process.env[ENV[p][1]]);
const key = (p) => `oauth_${p}`;

export async function loadOAuthCreds() {
  for (const p of Object.keys(TARGET)) {
    if (fromEnv(p)) continue;
    const r = (await query(`SELECT value_enc FROM secrets WHERE key = $1`, [key(p)])).rows[0];
    if (!r) { TARGET[p].clientId = ''; TARGET[p].clientSecret = ''; continue; }
    try { const v = JSON.parse(decrypt(r.value_enc)); TARGET[p].clientId = v.clientId || ''; TARGET[p].clientSecret = v.clientSecret || ''; } catch { /* poškozený záznam = nenastaveno */ }
  }
}

export async function setOAuthCreds(provider, { clientId, clientSecret }) {
  if (!TARGET[provider]) throw new Error('Neznámý poskytovatel.');
  if (fromEnv(provider)) { const e = new Error('Údaje jsou nastaveny na serveru (proměnné prostředí) a v administraci je nelze měnit.'); e.status = 400; throw e; }
  if (!clientId && !clientSecret) await query(`DELETE FROM secrets WHERE key = $1`, [key(provider)]);
  else await query(`INSERT INTO secrets (key, value_enc) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`, [key(provider), encrypt(JSON.stringify({ clientId, clientSecret }))]);
  await loadOAuthCreds();
}

export const oauthStatus = (provider) => ({
  configured: Boolean(TARGET[provider].clientId && TARGET[provider].clientSecret),
  source: fromEnv(provider) ? 'env' : TARGET[provider].clientId ? 'admin' : null,
  client_id: TARGET[provider].clientId || '',
});
