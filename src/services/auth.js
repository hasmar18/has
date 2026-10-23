import { query, withTx } from '../db.js';
import { config } from '../config.js';
import { HttpError, badRequest, unauthorized, notFound } from '../lib/errors.js';
import { hashPassword, verifyPassword, randomToken, sha256Hex } from '../lib/crypto.js';
import { queueEmail } from './email.js';
import { getContent } from './content.js';
import { log } from '../lib/log.js';

const CLIENT_SESSION_MS = 30 * 24 * 3600_000;
const ADMIN_SESSION_MS = 12 * 3600_000;
const MAX_FAILED = 8;
const LOCK_MS = 15 * 60_000;

// Pevný hash pro vyrovnání času při neexistujícím účtu (ochrana proti zjišťování e-mailů)
let dummyHash;
const getDummy = async () => (dummyHash ||= await hashPassword('dummy-password-for-timing'));

export function validatePassword(pw, email = '') {
  if (typeof pw !== 'string' || pw.length < 10) throw badRequest('Heslo musí mít alespoň 10 znaků.', 'weak_password');
  if (pw.length > 200) throw badRequest('Heslo je příliš dlouhé.', 'weak_password');
  if (email && pw.toLowerCase() === String(email).toLowerCase()) throw badRequest('Heslo nesmí být stejné jako e-mail.', 'weak_password');
  if (/^(.)\1+$/.test(pw)) throw badRequest('Zvolte méně předvídatelné heslo.', 'weak_password');
}

export const publicUser = (u) => ({
  id: u.id, email: u.email, full_name: u.full_name, phone: u.phone, role: u.role,
  email_verified: Boolean(u.email_verified_at), must_change_password: u.must_change_password,
});

async function issueAuthToken(db, userId, purpose, ttlMs) {
  const raw = randomToken(32);
  await db.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await db.query(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
    [userId, purpose, sha256Hex(raw), String(ttlMs)]);
  return raw;
}

export async function register({ email, password, name, phone }) {
  const em = email.trim().toLowerCase();
  validatePassword(password, em);
  const hash = await hashPassword(password);
  await withTx(async (tx) => {
    const exists = (await tx.query(`SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`, [em])).rows[0];
    if (exists) {
      await queueEmail(tx, { templateKey: 'account_exists', to: em, vars: { client_name: name }, dedupeKey: `exists:${exists.id}:${Math.floor(Date.now() / 3600_000)}` });
      return;
    }
    const u = (await tx.query(
      `INSERT INTO users (email, password_hash, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING *`, [em, hash, name, phone || '']
    )).rows[0];
    const raw = await issueAuthToken(tx, u.id, 'verify_email', 24 * 3600_000);
    await queueEmail(tx, {
      templateKey: 'account_verify', to: em, dedupeKey: `verifyacc:${u.id}:${raw.slice(0, 8)}`,
      vars: { client_name: name, verify_url: `${config.baseUrl}/ucet?overit=${encodeURIComponent(raw)}` },
    });
  });
  // Odpověď je vždy stejná – neprozrazujeme, zda e-mail už existuje.
  return { ok: true };
}

export async function resendVerification(userId) {
  return withTx(async (tx) => {
    const u = (await tx.query(`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId])).rows[0];
    if (!u || u.email_verified_at) return { ok: true };
    const recent = (await tx.query(`SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1 AND purpose = 'verify_email' AND created_at > now() - interval '1 hour'`, [u.id])).rows[0].n;
    if (recent >= 3) throw new HttpError(429, 'rate_limited', 'Ověřovací e-mail jsme už opakovaně odeslali. Zkuste to za hodinu.');
    const raw = await issueAuthToken(tx, u.id, 'verify_email', 24 * 3600_000);
    await queueEmail(tx, {
      templateKey: 'account_verify', to: u.email, dedupeKey: `verifyacc:${u.id}:${raw.slice(0, 8)}`,
      vars: { client_name: u.full_name || '', verify_url: `${config.baseUrl}/ucet?overit=${encodeURIComponent(raw)}` },
    });
    return { ok: true };
  });
}

export async function verifyEmail(token) {
  return withTx(async (tx) => {
    const t = (await tx.query(
      `SELECT * FROM auth_tokens WHERE token_hash = $1 AND purpose = 'verify_email' FOR UPDATE`, [sha256Hex(String(token))])).rows[0];
    if (!t || t.used_at || t.expires_at <= new Date()) throw new HttpError(400, 'invalid_token', 'Odkaz je neplatný nebo vypršel.');
    await tx.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1`, [t.id]);
    const u = (await tx.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1 RETURNING *`, [t.user_id])).rows[0];
    // Dřívější rezervace bez účtu na stejný (nyní ověřený) e-mail se přiřadí k účtu.
    await tx.query(`UPDATE bookings SET user_id = $1 WHERE user_id IS NULL AND lower(client_email) = lower($2)`, [u.id, u.email]);
    return publicUser(u);
  });
}

export async function createSession(db, user, userAgent = '') {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const ttl = user.role === 'admin' ? ADMIN_SESSION_MS : CLIENT_SESSION_MS;
  await db.query(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, user_agent) VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval, $5)`,
    [sha256Hex(token), user.id, csrf, String(ttl), String(userAgent).slice(0, 200)]);
  return { token, csrf, maxAgeSec: Math.floor(ttl / 1000) };
}

export async function login({ email, password, userAgent }) {
  const em = email.trim().toLowerCase();
  const u = (await query(`SELECT * FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`, [em])).rows[0];
  if (!u || !u.password_hash) {
    await verifyPassword(password, await getDummy());
    throw unauthorized('Nesprávný e-mail nebo heslo.');
  }
  if (u.locked_until && u.locked_until > new Date()) {
    throw new HttpError(429, 'account_locked', 'Účet je dočasně uzamčen kvůli opakovaným chybným pokusům. Zkuste to později.');
  }
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok) {
    const n = u.failed_logins + 1;
    await query(`UPDATE users SET failed_logins = $2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + ($4::int * interval '1 millisecond') ELSE locked_until END WHERE id = $1`,
      [u.id, n, MAX_FAILED, LOCK_MS]);
    throw unauthorized('Nesprávný e-mail nebo heslo.');
  }
  await query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [u.id]);
  const session = await createSession({ query }, u, userAgent);
  return { user: publicUser(u), session };
}

export async function sessionFromToken(token) {
  if (!token) return null;
  const r = (await query(
    `SELECT s.id AS sid, s.csrf_token, u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now() AND u.deleted_at IS NULL`, [sha256Hex(token)])).rows[0];
  if (!r) return null;
  const { sid, csrf_token, ...user } = r;
  return { sid, csrf: csrf_token, user };
}

export const logout = (token) => query(`DELETE FROM sessions WHERE id = $1`, [sha256Hex(token)]);

export async function requestPasswordReset(email) {
  const em = email.trim().toLowerCase();
  await withTx(async (tx) => {
    const u = (await tx.query(`SELECT * FROM users WHERE lower(email) = $1 AND deleted_at IS NULL AND password_hash IS NOT NULL`, [em])).rows[0];
    if (!u) return;
    const recent = (await tx.query(`SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1 AND purpose = 'reset_password' AND created_at > now() - interval '1 hour'`, [u.id])).rows[0].n;
    if (recent >= 3) return;
    const raw = await issueAuthToken(tx, u.id, 'reset_password', 3600_000);
    await queueEmail(tx, {
      templateKey: 'password_reset', to: u.email, dedupeKey: `reset:${u.id}:${raw.slice(0, 8)}`,
      vars: { client_name: u.full_name || '', reset_url: `${config.baseUrl}/ucet?obnova=${encodeURIComponent(raw)}` },
    });
  });
  return { ok: true };
}

export async function resetPassword(token, newPassword) {
  return withTx(async (tx) => {
    const t = (await tx.query(`SELECT * FROM auth_tokens WHERE token_hash = $1 AND purpose = 'reset_password' FOR UPDATE`, [sha256Hex(String(token))])).rows[0];
    if (!t || t.used_at || t.expires_at <= new Date()) throw new HttpError(400, 'invalid_token', 'Odkaz je neplatný nebo vypršel.');
    const u = (await tx.query(`SELECT * FROM users WHERE id = $1`, [t.user_id])).rows[0];
    validatePassword(newPassword, u.email);
    const hash = await hashPassword(newPassword);
    await tx.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1`, [t.id]);
    // Přijetí odkazu z e-mailu zároveň prokazuje vlastnictví adresy.
    await tx.query(`UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, must_change_password = false,
      email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1`, [u.id, hash]);
    await tx.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]);
    return { ok: true };
  });
}

export async function changePassword(userId, current, next, keepSessionId = null) {
  const u = (await query(`SELECT * FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u || !(await verifyPassword(current, u.password_hash))) throw new HttpError(400, 'wrong_password', 'Současné heslo nesouhlasí.');
  validatePassword(next, u.email);
  const hash = await hashPassword(next);
  await withTx(async (tx) => {
    await tx.query(`UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1`, [userId, hash]);
    await tx.query(`DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR id <> $2)`, [userId, keepSessionId]);
  });
  return { ok: true };
}

export async function updateProfile(userId, { name, phone }) {
  const u = (await query(`UPDATE users SET full_name = COALESCE($2, full_name), phone = COALESCE($3, phone), updated_at = now() WHERE id = $1 RETURNING *`, [userId, name ?? null, phone ?? null])).rows[0];
  return publicUser(u);
}

/** Odstranění účtu: budoucí rezervace se zruší, osobní údaje se anonymizují. */
export async function deleteAccount(userId, password) {
  const u = (await query(`SELECT * FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u || u.role === 'admin') throw new HttpError(403, 'forbidden', 'Tento účet nelze smazat.');
  if (!(await verifyPassword(password, u.password_hash))) throw new HttpError(400, 'wrong_password', 'Heslo nesouhlasí.');
  const { cancelBooking } = await import('./bookings.js');
  const future = (await query(`SELECT id FROM bookings WHERE user_id = $1 AND status IN ('held','confirmed') AND starts_at > now()`, [userId])).rows;
  for (const b of future) await cancelBooking(b.id, { actor: 'client', userId, reason: 'Zrušení účtu', notify: false });
  await withTx(async (tx) => {
    await tx.query(`UPDATE bookings SET client_name = 'Smazaná klientka', client_email = '', client_phone = '', client_note = '',
      manage_token_hash = NULL, manage_token_enc = NULL, user_id = NULL WHERE user_id = $1`, [userId]);
    await tx.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await tx.query(`DELETE FROM auth_tokens WHERE user_id = $1`, [userId]);
    await tx.query(`UPDATE users SET email = $2, full_name = NULL, phone = NULL, password_hash = NULL, deleted_at = now(), updated_at = now() WHERE id = $1`,
      [userId, `smazano-${userId}@deleted.invalid`]);
  });
  return { ok: true };
}

/** Vytvoří (nebo obnoví) administrátorský účet. Používá se při prvním spuštění a ve skriptu `npm run create-admin`. */
export async function upsertAdmin(email, password, { mustChangePassword = true } = {}) {
  const em = String(email).trim().toLowerCase();
  validatePassword(password, em);
  const hash = await hashPassword(password);
  const r = await query(
    `INSERT INTO users (email, password_hash, role, full_name, email_verified_at, must_change_password)
     VALUES ($1, $2, 'admin', 'Administrátorka', now(), $3)
     ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash,
       email_verified_at = COALESCE(users.email_verified_at, now()), must_change_password = EXCLUDED.must_change_password,
       failed_logins = 0, locked_until = NULL
     RETURNING id`,
    [em, hash, mustChangePassword]);
  await query(`DELETE FROM sessions WHERE user_id = $1`, [r.rows[0].id]);
  return r.rows[0].id;
}

/** První administrátor: vytvoří se jednorázově z proměnných prostředí (nikdy přes veřejnou registraci). */
export async function bootstrapAdmin() {
  const { email, initialPassword } = config.admin;
  if (!email || !initialPassword) return false;
  const existing = (await query(`SELECT 1 FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1`)).rows[0];
  if (existing) return false;
  await upsertAdmin(email, initialPassword, { mustChangePassword: true });
  log.warn('Byl vytvořen první administrátorský účet. Po prvním přihlášení změňte heslo a ODSTRAŇTE ADMIN_INITIAL_PASSWORD z prostředí.');
  return true;
}
