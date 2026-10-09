import { config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { ensureFirstAdmin, resetAdminPasswordFromEnv } from './lib/users.js';
import { startRecontactScheduler } from './lib/recontatos.js';

async function main() {
  await migrate();
  await ensureFirstAdmin();
  await resetAdminPasswordFromEnv();
  createApp().listen(config.port, () => {
    console.log(`CRM Brindes DoBoni rodando na porta ${config.port}`);
  });
  startRecontactScheduler();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
