import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { log } from './log.js';

const scrypt = promisify(crypto.scrypt);

export const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- Hesla (scrypt, parametry uložené u hashe) -----------------------------
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const dk = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(dk, expected);
}

// ---- Šifrování tajných údajů v databázi (AES-256-GCM) -----------------------
let cachedKey;
function getKey() {
  if (cachedKey) return cachedKey;
  let raw = config.encryptionKey;
  if (!raw) {
    if (config.isProd) throw new Error('ENCRYPTION_KEY není nastaven (32 náhodných bajtů v base64).');
    log.warn('ENCRYPTION_KEY není nastaven – používá se vývojový klíč (pouze pro lokální vývoj!).');
    raw = crypto.createHash('sha256').update('hasnails-dev-only-key').digest('base64');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY musí mít po dekódování z base64 právě 32 bajtů.');
  cachedKey = key;
  return key;
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

export function decrypt(payload) {
  const [v, iv, tag, data] = String(payload).split('.');
  if (v !== 'v1') throw new Error('Neznámý formát šifrovaných dat.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

// Podepsaný krátkodobý „state“ pro OAuth (vázaný na relaci)
export function signState(payload, secretBuf = getKey()) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secretBuf).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function verifyState(state, secretBuf = getKey()) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secretBuf).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}
