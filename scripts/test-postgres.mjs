import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Never fall back to the application/production database URL.
let url = process.env.PIKKU_TEST_DATABASE_URL?.trim();
if (!url) {
  try { url = readFileSync(new URL('../.local/postgres-url.txt', import.meta.url), 'utf8').trim(); }
  catch { console.error('Start npm run dev:db, or explicitly set PIKKU_TEST_DATABASE_URL for an isolated test database.'); process.exit(1); }
}
if (!url) { console.error('Test database URL is empty.'); process.exit(1); }
const result = spawnSync('npm', ['test'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, PIKKU_TEST_DATABASE_URL: url }, stdio: 'inherit',
});
if (result.error) console.error('Could not start PostgreSQL integration tests.');
process.exitCode = result.status ?? 1;
