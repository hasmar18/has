import { query } from '../db.js';

// Texty webu editovatelné v administraci. Výchozí je jen to, co majitelka sama sdělila (kontakt, údaje z ARES); ostatní texty doplní správce.
export const CONTENT_DEFS = {
  hero_title: { label: 'Úvod – hlavní nadpis', multiline: false, def: 'HASNAILS' },
  hero_subtitle: { label: 'Úvod – podnadpis', multiline: false, def: '' },
  about_title: { label: 'O studiu – nadpis', multiline: false, def: 'O studiu' },
  about_text: {
    label: 'O studiu – text', multiline: true,
    def: '',
  },
  services_intro: { label: 'Služby – úvodní text', multiline: false, def: '' },
  client_info_title: { label: 'Informace pro klientky – nadpis', multiline: false, def: 'Před návštěvou' },
  client_info_text: {
    label: 'Informace pro klientky', multiline: true,
    def: '',
  },
  cancellation_text: {
    label: 'Storno podmínky', multiline: true,
    def: '',
  },
  gallery_title: { label: 'Galerie – nadpis', multiline: false, def: 'Galerie' },
  instagram_title: { label: 'Instagram – nadpis', multiline: false, def: 'Instagram' },
  instagram_url: { label: 'Instagram – odkaz', multiline: false, def: 'https://www.instagram.com/hasnails_ostrava/' },
  contact_name: { label: 'Kontakt – jméno', multiline: false, def: 'Martina Rolná' },
  contact_phone: { label: 'Kontakt – telefon', multiline: false, def: '+420 702 118 870' },
  contact_email: { label: 'Kontakt – e-mail (nepovinné)', multiline: false, def: '' },
  contact_address: { label: 'Kontakt – adresa', multiline: false, def: 'U Studia 37, Ostrava-Zábřeh, 700 30' },
  contact_lat: { label: 'Mapa – zeměpisná šířka', multiline: false, def: '49.7981664' },
  contact_lng: { label: 'Mapa – zeměpisná délka', multiline: false, def: '18.233623' },
  terms_text: {
    label: 'Obchodní podmínky', multiline: true,
    def: 'Obchodní podmínky\n\nProvozovatel: Martina Rolná, IČO 24568902, se sídlem K nádraží 268, 747 66 Dolní Lhota, fyzická osoba podnikající podle živnostenského zákona.\nProvozovna: HASNAILS, U Studia 37, Ostrava-Zábřeh, 700 30, telefon +420 702 118 870.',
  },
  privacy_text: {
    label: 'Zásady ochrany osobních údajů', multiline: true,
    def: 'Zásady zpracování osobních údajů\n\nSprávce: Martina Rolná, IČO 24568902, se sídlem K nádraží 268, 747 66 Dolní Lhota (provozovna: U Studia 37, Ostrava-Zábřeh, 700 30), telefon +420 702 118 870.',
  },
  footer_note: { label: 'Patička – poznámka', multiline: false, def: '' },
};

export async function ensureContentDefaults(db = { query }) {
  for (const [key, d] of Object.entries(CONTENT_DEFS)) {
    await db.query('INSERT INTO site_content (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, d.def]);
  }
}

export async function getContent(db = { query }) {
  const rows = (await db.query('SELECT key, value FROM site_content')).rows;
  const out = {};
  for (const [k, d] of Object.entries(CONTENT_DEFS)) out[k] = d.def;
  for (const r of rows) if (r.key in CONTENT_DEFS) out[r.key] = r.value;
  return out;
}

export async function setContent(db, patch, userId = null) {
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in CONTENT_DEFS)) continue;
    const val = String(v ?? '').slice(0, 20000);
    await db.query(
      `INSERT INTO site_content (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [k, val, userId],
    );
    changed.push(k);
  }
  return changed;
}
