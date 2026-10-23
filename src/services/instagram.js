import { query } from '../db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { log } from '../lib/log.js';

// Oficiální Instagram API (Instagram API s přihlášením přes Instagram – účet musí být firemní nebo tvůrce).
// Token se vkládá v administraci a ukládá šifrovaně. Bez tokenu web zobrazuje vlastní galerii + odkaz na Instagram.
const KEY = 'instagram_token';
let cache = { at: 0, posts: [] };

export async function getToken() {
  const r = (await query(`SELECT value_enc FROM secrets WHERE key = $1`, [KEY])).rows[0];
  if (!r) return null;
  try { return decrypt(r.value_enc); } catch { return null; }
}
export async function setToken(token) {
  if (!token) { await query(`DELETE FROM secrets WHERE key = $1`, [KEY]); cache = { at: 0, posts: [] }; return; }
  await query(`INSERT INTO secrets (key, value_enc) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`, [KEY, encrypt(token)]);
  cache = { at: 0, posts: [] };
}
export const instagramConfigured = async () => Boolean(await getToken());

export async function getPosts() {
  if (Date.now() - cache.at < 30 * 60_000) return cache.posts;
  const token = await getToken();
  if (!token) return [];
  try {
    const url = `https://graph.instagram.com/me/media?${new URLSearchParams({ fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp', limit: '9', access_token: token })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Instagram API ${res.status}`);
    const data = await res.json();
    const posts = (data.data || [])
      .map((p) => ({ id: p.id, url: p.media_type === 'VIDEO' ? p.thumbnail_url : p.media_url, permalink: p.permalink, caption: (p.caption || '').slice(0, 140) }))
      .filter((p) => p.url && p.permalink);
    cache = { at: Date.now(), posts };
    return posts;
  } catch (err) {
    log.warn('Načtení Instagramu selhalo', err);
    return cache.posts; // poslední známá data, jinak prázdné
  }
}

/** Dlouhodobý token je třeba obnovit nejpozději do 60 dnů. */
export async function refreshToken() {
  const token = await getToken();
  if (!token) return { skipped: true };
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Obnova Instagram tokenu selhala (${res.status})`);
  const data = await res.json();
  if (data.access_token) await setToken(data.access_token);
  return { ok: true };
}
