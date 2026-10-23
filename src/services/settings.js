import { z } from 'zod';
import { query } from '../db.js';

// Definice nastavení: výchozí hodnota + validační schéma. Hodnoty jsou v tabulce `settings` (jsonb).
const timeZone = z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Neplatná časová zóna');

export const SETTING_DEFS = {
  timezone: { def: 'Europe/Prague', schema: timeZone },
  online_booking_enabled: { def: false, schema: z.boolean() },
  slot_interval_minutes: { def: 30, schema: z.number().int().min(5).max(240) },
  buffer_minutes: { def: 0, schema: z.number().int().min(0).max(240) },
  min_notice_hours: { def: 12, schema: z.number().min(0).max(24 * 30) },
  max_advance_days: { def: 60, schema: z.number().int().min(1).max(365) },
  cancel_hours_before: { def: 24, schema: z.number().min(0).max(24 * 30) },
  hold_minutes: { def: 15, schema: z.number().int().min(3).max(60) },
  reminder_hours_before: { def: [24], schema: z.array(z.number().int().min(1).max(24 * 14)).max(3) },
  fail_closed: { def: true, schema: z.boolean() },
  calendar_max_staleness_minutes: { def: 10, schema: z.number().int().min(2).max(240) },
  calendar_poll_minutes: { def: 2, schema: z.number().int().min(1).max(60) },
  admin_alert_email: { def: '', schema: z.union([z.literal(''), z.string().email()]) },
  retention_months: { def: 24, schema: z.number().int().min(1).max(120) },
  settings_reviewed: { def: false, schema: z.boolean() },
};

let cache = null;
let cacheAt = 0;
const TTL = 3000;

export function invalidateSettings() { cache = null; }

export async function getSettings(db = null) {
  if (!db && cache && Date.now() - cacheAt < TTL) return cache;
  const rows = (await (db || { query }).query('SELECT key, value FROM settings')).rows;
  const out = {};
  for (const [k, d] of Object.entries(SETTING_DEFS)) out[k] = d.def;
  for (const r of rows) if (r.key in SETTING_DEFS) out[r.key] = r.value;
  if (!db) { cache = out; cacheAt = Date.now(); }
  return out;
}

/** Uloží jen známé klíče, hodnoty validuje. Vrací změněné klíče. */
export async function updateSettings(db, patch) {
  const changed = {};
  for (const [k, v] of Object.entries(patch)) {
    const d = SETTING_DEFS[k];
    if (!d) continue;
    const parsed = d.schema.parse(v);
    await db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [k, JSON.stringify(parsed)],
    );
    changed[k] = parsed;
  }
  invalidateSettings();
  return changed;
}
