import { query } from '../db.js';

// Texty webu editovatelné v administraci. Výchozí texty jsou záměrně obecné a neobsahují
// žádné vymyšlené údaje o službách ani cenách.
export const CONTENT_DEFS = {
  hero_title: { label: 'Úvod – hlavní nadpis', multiline: false, def: 'Krásné a upravené nehty v Ostravě-Zábřehu' },
  hero_subtitle: { label: 'Úvod – podnadpis', multiline: false, def: 'Nehtové studio HASNAILS · Martina Rolná' },
  about_title: { label: 'O studiu – nadpis', multiline: false, def: 'O studiu' },
  about_text: {
    label: 'O studiu – text', multiline: true,
    def: 'Vítejte v nehtovém studiu HASNAILS. Věnuji se péči o ruce a nohy v příjemném a čistém prostředí.\n\nObjednat se můžete online – stačí vybrat službu a volný termín. Potvrzení vám přijde e-mailem.',
  },
  services_intro: { label: 'Služby – úvodní text', multiline: false, def: 'Vyberte si službu a rovnou si rezervujte volný termín.' },
  client_info_title: { label: 'Informace pro klientky – nadpis', multiline: false, def: 'Před návštěvou' },
  client_info_text: {
    label: 'Informace pro klientky', multiline: true,
    def: 'Přijďte prosím včas. Pokud se nemůžete dostavit, zrušte nebo změňte termín co nejdříve – uvolníte tak místo další klientce.',
  },
  cancellation_text: {
    label: 'Storno podmínky', multiline: true,
    def: 'Rezervaci můžete zrušit online v době, kterou studio nastavilo. Pozdější zrušení nebo změnu řešte prosím telefonicky.',
  },
  gallery_title: { label: 'Galerie – nadpis', multiline: false, def: 'Galerie' },
  instagram_title: { label: 'Instagram – nadpis', multiline: false, def: 'Sledujte nás na Instagramu' },
  instagram_url: { label: 'Instagram – odkaz', multiline: false, def: 'https://www.instagram.com/hasnails_ostrava/' },
  contact_name: { label: 'Kontakt – jméno', multiline: false, def: 'Martina Rolná' },
  contact_phone: { label: 'Kontakt – telefon', multiline: false, def: '+420 702 118 870' },
  contact_email: { label: 'Kontakt – e-mail (nepovinné)', multiline: false, def: '' },
  contact_address: { label: 'Kontakt – adresa', multiline: false, def: 'U Studia 37, Ostrava-Zábřeh, 700 30' },
  contact_lat: { label: 'Mapa – zeměpisná šířka', multiline: false, def: '49.7981664' },
  contact_lng: { label: 'Mapa – zeměpisná délka', multiline: false, def: '18.233623' },
  terms_text: {
    label: 'Obchodní podmínky', multiline: true,
    def: [
      'Obchodní podmínky rezervace služeb studia HASNAILS',
      '1. Provozovatelem studia a poskytovatelem služeb je Martina Rolná, IČO 24568902, se sídlem K nádraží 268, 747 66 Dolní Lhota, fyzická osoba podnikající podle živnostenského zákona (zapsaná v živnostenském rejstříku). Provozovna: HASNAILS, U Studia 37, Ostrava-Zábřeh, 700 30, telefon +420 702 118 870.',
      '2. Rezervace se stává závaznou potvrzením e-mailové adresy (případně přihlášením k účtu) a odesláním potvrzení rezervace na e-mail klientky.',
      '3. Cena a délka služby jsou uvedeny u každé služby v době rezervace. Konečná cena se může lišit podle skutečného rozsahu práce, na čemž se klientka a provozovatel dohodnou před zahájením služby.',
      '4. Rezervaci lze zrušit online nejpozději v době uvedené v storno podmínkách. Při pozdějším zrušení nebo nedostavení se kontaktujte prosím provozovatele telefonicky.',
      '5. Změnu termínu lze požádat online; změna je provedena až po potvrzení provozovatelem.',
      '6. Klientka je povinna dostavit se včas. Při výrazném zpoždění může být služba zkrácena nebo termín zrušen.',
      '7. Tyto podmínky jsou výchozí šablonou; provozovatel je může kdykoli upravit v administraci.',
    ].join('\n\n'),
  },
  privacy_text: {
    label: 'Zásady ochrany osobních údajů', multiline: true,
    def: [
      'Zásady zpracování osobních údajů',
      'Správcem osobních údajů je Martina Rolná, IČO 24568902, se sídlem K nádraží 268, 747 66 Dolní Lhota (provozovna: U Studia 37, Ostrava-Zábřeh, 700 30), telefon +420 702 118 870.',
      'Zpracováváme tyto údaje: jméno, e-mail, telefon, údaje o rezervaci (služba, termín, poznámka) a u registrovaných klientek přihlašovací e-mail a heslo (ukládáme pouze jeho bezpečný otisk).',
      'Účel a právní základ: vyřízení a evidence rezervace (plnění smlouvy / jednání o smlouvě, čl. 6 odst. 1 písm. b GDPR), zasílání potvrzení a připomínek k rezervaci (plnění smlouvy), zabezpečení a prevence zneužití (oprávněný zájem, čl. 6 odst. 1 písm. f GDPR).',
      'Příjemci údajů: poskytovatel hostingu a databáze (Render), poskytovatel e-mailových služeb (Brevo) a kalendářová služba používaná provozovatelem. Údaje nepředáváme dalším osobám za účelem marketingu.',
      'Doba uchování: údaje o rezervacích uchováváme po dobu nastavenou provozovatelem (výchozí 24 měsíců od termínu), poté je anonymizujeme. Účet a související údaje můžete kdykoli smazat v sekci Můj účet.',
      'Máte právo na přístup k údajům, jejich opravu, výmaz, omezení zpracování, přenositelnost a právo vznést námitku. Stížnost můžete podat u Úřadu pro ochranu osobních údajů (uoou.gov.cz).',
      'Web používá pouze nezbytné technické cookies (přihlášení). Nepoužívá reklamní ani analytické cookies.',
      'Tento text je výchozí šablona; provozovatel by ho měl zkontrolovat a podle potřeby upravit.',
    ].join('\n\n'),
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
