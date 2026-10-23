import { ensureContentDefaults } from './content.js';
import { query } from '../db.js';

/** Idempotentní doplnění výchozích textů webu. Služby ani ceny se záměrně NEVKLÁDAJÍ (zadává majitelka v administraci). */
export async function seedDefaults() {
  await ensureContentDefaults({ query });
}
