import { ensureContentDefaults } from './content.js';
import { query } from '../db.js';

/** Idempotentní doplnění výchozích textů webu (bez služeb). */
export async function seedDefaults() {
  await ensureContentDefaults({ query });
}

// Výchozí nabídka služeb: názvy, popisy a délky převzaty ze snímků rezervačního systému dodaných majitelkou.
// CENY NEBYLY V PODKLADECH – zůstávají prázdné a doplní se v administraci. Popisy jsou kompletní (zkrácené texty z náhledů doplnila majitelka).
const SERVICES = [
  ['Manikúra', 'Gellak', 'Aplikace gelového laku na přírodní nehty. Zahrnuje kompletní začištění nehtového okolí, zpevnění nehtu a zvolení vhodného materiálu.', 120, '/img/ilu-gellak.svg', false],
  ['Manikúra', 'Klasická manikúra', 'Klasická manikúra je ideální volbou pro každého, kdo touží po upravených nehtech, zdravé kůžičce a příjemném relaxu. Jedná se o šetrné ošetření přírodních nehtů, které zanechá vaše ruce pěstěné a svěží.', 30, '/img/ilu-klasicka.svg', false],
  ['Manikúra', 'COMBO Mani a Pedi', 'Manikúra a pedikúra při jednom sezení', 240, '/img/ilu-combo.svg', false],
  ['Pedikúra', 'Přístrojová pedikúra', '(Základní ošetření nohou, dezinfekce, diagnostika plosek nohou, úprava nehtů a nehtového okolí, odstranění zrohovatělé kůže, péče pro okolí nehtů, hydratační výživa pokožky)', 60, '/img/ilu-pedikura.svg', false],
  ['Pedikúra', 'Přístrojová pedikúra + gellak', '(Základní ošetření nohou, dezinfekce, diagnostika plosek nohou, úprava nehtů a nehtového okolí, aplikace gellaku, odstranění zrohovatělé kůže, péče pro okolí nehtů, hydratační výživa pokožky.)', 120, '/img/ilu-pedikura-gellak.svg', false],
  ['Pedikúra', 'Úprava nehtů + gellak (bez ošetření chodidel)', '(Dezinfekce, úprava nehtů a nehtového okolí, aplikace gellaku.)', 90, '/img/ilu-pedikura-gellak.svg', false],
  ['Pedikúra', 'COMBO Mani a Pedi', 'Manikúra a pedikúra při jednom sezení', 240, '/img/ilu-combo.svg', false],
];

/** Jednorázové založení výchozí nabídky – jen když ještě žádné služby nejsou a nabídka nebyla nikdy založena (smazané služby se nevrací). */
export async function seedServices() {
  const done = (await query(`SELECT 1 FROM settings WHERE key = 'seed_services_v1'`)).rows[0];
  const any = (await query(`SELECT 1 FROM services LIMIT 1`)).rows[0];
  if (done || any) return false;
  const cats = {}; let order = 0;
  for (const [cat, name, desc, mins, img, truncated] of SERVICES) {
    if (!cats[cat]) cats[cat] = (await query(`INSERT INTO service_categories (name, sort_order) VALUES ($1, $2) RETURNING id`, [cat, Object.keys(cats).length])).rows[0].id;
    await query(
      `INSERT INTO services (name, description, duration_minutes, price_czk, category_id, is_active, is_verified, source_note, sort_order, image_url)
       VALUES ($1, $2, $3, NULL, $4, true, false, $5, $6, $7)`,
      [name, desc, mins, cats[cat], `Název, popis a délka dle podkladů majitelky; cena chybí – doplňte.${truncated ? ' Text popisu byl v podkladu zkrácen – doplňte celé znění.' : ''}`, order++, img]);
  }
  await query(`INSERT INTO settings (key, value) VALUES ('seed_services_v1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`);
  return true;
}
