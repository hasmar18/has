import { migrate, closePool } from '../db.js';
import { seedDefaults } from '../services/seed.js';

try {
  const applied = await migrate();
  await seedDefaults();
  console.log(applied.length ? `Aplikované migrace: ${applied.join(', ')}` : 'Databáze je aktuální.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
