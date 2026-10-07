import { migrate } from './migrate.js';
import { pool } from './pool.js';
import { ensureFirstAdmin } from '../lib/users.js';

migrate()
  .then(() => ensureFirstAdmin())
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
