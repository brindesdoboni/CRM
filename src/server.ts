import { config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { ensureFirstAdmin } from './lib/users.js';

async function main() {
  await migrate();
  await ensureFirstAdmin();
  createApp().listen(config.port, () => {
    console.log(`CRM Brindes DoBoni rodando na porta ${config.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
