import { z } from 'zod';

export const email = z.string().trim().toLowerCase().email('Zadejte platný e-mail.').max(200);
export const password = z.string().min(10, 'Heslo musí mít alespoň 10 znaků.').max(200);
export const personName = z.string().trim().min(2, 'Zadejte jméno.').max(100);
export const phone = z.string().trim().regex(/^[0-9+()\-\s]{6,30}$/, 'Zadejte platné telefonní číslo.');
export const optionalPhone = z.union([z.literal(''), phone]).default('');
export const note = z.string().trim().max(500).default('');
export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const isoTime = z.string().regex(/^\d{1,2}:\d{2}$/);
export const instant = z.string().datetime({ offset: true }).transform((s) => new Date(s));

export const registerBody = z.object({ email, password, name: personName, phone: optionalPhone });
export const loginBody = z.object({ email, password: z.string().min(1).max(200) });

export const bookingBody = z.object({
  service_id: uuid,
  starts_at: instant,
  name: personName,
  email,
  phone,
  note,
  consent: z.literal(true, { errorMap: () => ({ message: 'Pro rezervaci je nutný souhlas se zpracováním údajů a podmínkami.' }) }),
});
