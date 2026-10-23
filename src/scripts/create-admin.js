// Vytvoření / obnovení administrátorského účtu:
//   ADMIN_EMAIL=majitelka@example.cz ADMIN_PASSWORD='silné-heslo-min-10-znaků' npm run create-admin
// Při prvním přihlášení bude vyžadována změna hesla.
import { migrate, closePool } from '../db.js';
import { upsertAdmin } from '../services/auth.js';

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD || process.env.ADMIN_INITIAL_PASSWORD;
if (!email || !password) {
  console.error('Zadejte ADMIN_EMAIL a ADMIN_PASSWORD (min. 10 znaků).');
  process.exit(1);
}
try {
  await migrate();
  await upsertAdmin(email, password, { mustChangePassword: true });
  console.log(`Administrátorský účet ${email} je připraven. Při prvním přihlášení bude vyžadována změna hesla.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
