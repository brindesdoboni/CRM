import { migrate } from './migrate.js';
import { pool } from './pool.js';

migrate()
  .then(() => console.log('Banco atualizado.'))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
