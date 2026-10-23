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
    def: 'Obchodní podmínky\n\n1. Provozovatelem a poskytovatelem služeb je Martina Rolná, IČO 24568902, se sídlem K nádraží 268, 747 66 Dolní Lhota, fyzická osoba podnikající podle živnostenského zákona. Provozovna: HASNAILS, U Studia 37, Ostrava-Zábřeh, 700 30, telefon +420 702 118 870.\n\n2. Rezervace služby se stává závaznou potvrzením e-mailové adresy kódem (nebo přihlášením k účtu s ověřeným e-mailem) a odesláním potvrzení na e-mail klientky.\n\n3. Cena a délka služby jsou uvedeny u služby při rezervaci. Konečná cena se může lišit podle skutečného rozsahu práce; klientka je o tom informována před zahájením služby.\n\n4. Rezervaci lze zrušit online nejpozději v době uvedené v rezervačním systému a v e-mailu s potvrzením. Při pozdějším zrušení nebo změně kontaktujte prosím provozovatele telefonicky.\n\n5. O změnu termínu lze požádat online; změna je provedena až po potvrzení provozovatelem.\n\n6. Klientka je povinna dostavit se včas. Při výrazném zpoždění může být rozsah služby zkrácen nebo termín zrušen.\n\n7. Provozovatel si vyhrazuje právo zrušit nebo přesunout termín z vážných provozních důvodů; klientku o tom bez zbytečného odkladu informuje.\n\n8. Tyto podmínky jsou platné od okamžiku zveřejnění na webu.',
  },
  privacy_text: {
    label: 'Zásady ochrany osobních údajů', multiline: true,
    def: 'Zásady zpracování osobních údajů\n\nSprávcem osobních údajů je Martina Rolná, IČO 24568902, se sídlem K nádraží 268, 747 66 Dolní Lhota (provozovna: U Studia 37, Ostrava-Zábřeh, 700 30), telefon +420 702 118 870.\n\nZpracováváme jméno, e-mail, telefon, údaje o rezervaci (služba, termín, poznámka) a u registrovaných klientek přihlašovací e-mail a otisk hesla (heslo samotné neukládáme).\n\nÚčel a právní základ: vyřízení a evidence rezervace (plnění smlouvy, čl. 6 odst. 1 písm. b GDPR), zasílání potvrzení a upomínek k rezervaci (plnění smlouvy), zabezpečení webu a prevence zneužití (oprávněný zájem, čl. 6 odst. 1 písm. f GDPR).\n\nPříjemci údajů: poskytovatel hostingu a databáze, poskytovatel e-mailových služeb (Brevo) a kalendářová služba, kterou provozovatel používá. Údaje nepředáváme dalším osobám pro marketing.\n\nDoba uchování: údaje o rezervacích uchováváme 24 měsíců od termínu, poté je anonymizujeme. Účet a související údaje můžete kdykoli smazat v sekci Můj účet.\n\nMáte právo na přístup k údajům, opravu, výmaz, omezení zpracování, přenositelnost a právo vznést námitku. Stížnost můžete podat u Úřadu pro ochranu osobních údajů (uoou.gov.cz).\n\nWeb používá pouze nezbytné technické cookies (přihlášení). Nepoužívá reklamní ani analytické cookies.',
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
