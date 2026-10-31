import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--test') || args.length > 1) {
  console.error('Usage: node scripts/postgres-local.mjs [--test]');
  process.exit(1);
}

// initdb creates a temporary plaintext password file; the library inherits this umask.
process.umask(0o077);
const test = args.includes('--test');
const localDir = join(root, '.local');
const clusterDir = join(localDir, 'postgres', ...(test ? ['test'] : []));
const dataDir = join(clusterDir, 'data');
const lockFile = join(clusterDir, 'launcher.lock');
const urlFile = test ? join(clusterDir, 'postgres-url.txt') : join(localDir, 'postgres-url.txt');
const port = test ? 55433 : 55432;
const username = 'pikku';
const database = 'postgres';
let password = '';
let connectionUrl = '';
let postgres;
let ownLock = false;
let signalName;
let resolveSignal;
const signalReceived = new Promise(resolveStop => { resolveSignal = resolveStop; });
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(name, () => {
    if (!signalName) { signalName = name; resolveSignal(); }
  });
}

// The pinned library installs exit-hook signal handlers that can call
// process.exit() before our lock cleanup or an in-flight initdb finishes.
// Keep its beforeExit safety net, but own SIGINT/SIGTERM in this launcher.
const previousHandlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, new Set(process.listeners(name))]));
const { default: EmbeddedPostgres } = await import('embedded-postgres');
for (const [name, previous] of previousHandlers) {
  for (const handler of process.listeners(name)) {
    if (!previous.has(handler) && handler.name === 'bound exit') process.removeListener(name, handler);
  }
}

function safeMessage(error) {
  let message = error instanceof Error ? error.message : 'PostgreSQL could not start.';
  if (connectionUrl) message = message.replaceAll(connectionUrl, '[redacted]');
  if (password) message = message.replaceAll(password, '[redacted]');
  return message;
}

async function pathInfo(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function portIsAvailable() {
  await new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is unavailable on 127.0.0.1.`)));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(error => error ? reject(error) : done());
    });
  });
}

async function clusterIsInitialised() {
  const directory = await pathInfo(dataDir);
  if (!directory) return false;
  if (!directory.isDirectory()) throw new Error('The PostgreSQL data path is not a directory; it was left untouched.');
  const entries = await readdir(dataDir);
  if (entries.includes('PG_VERSION')) return true;
  if (entries.length) throw new Error('The PostgreSQL data directory is not empty but has no PG_VERSION; it was left untouched.');
  return false;
}

async function loadCredentials(initialised) {
  let info = await pathInfo(urlFile);
  if (!info) {
    if (initialised) throw new Error('The existing PostgreSQL data has no connection file. Restore the original file; data was left untouched.');
    const generatedPassword = randomBytes(32).toString('base64url');
    const generatedUrl = `postgresql://${username}:${generatedPassword}@127.0.0.1:${port}/${database}`;
    const file = await open(urlFile, 'wx', 0o600);
    try { await file.writeFile(`${generatedUrl}\n`, 'utf8'); }
    finally { await file.close(); }
    info = await lstat(urlFile);
  }
  if (!info.isFile()) throw new Error('The PostgreSQL connection path is not a regular file; it was left untouched.');
  await chmod(urlFile, 0o600);
  connectionUrl = (await readFile(urlFile, 'utf8')).trim();
  let parsed;
  try { parsed = new URL(connectionUrl); }
  catch { throw new Error('The existing PostgreSQL connection file is invalid; it was left untouched.'); }
  if (parsed.protocol !== 'postgresql:' || parsed.hostname !== '127.0.0.1' || parsed.port !== String(port)
      || parsed.username !== username || !parsed.password || parsed.pathname !== `/${database}` || parsed.search || parsed.hash) {
    throw new Error('The existing PostgreSQL connection file does not match this cluster; it was left untouched.');
  }
  password = decodeURIComponent(parsed.password);
}

async function stopPostgres() {
  // Version 18.6.0-beta.19 has no public exit event, and stop() waits forever
  // if its child already exited. Clear that private handle in the latter case.
  const child = postgres?.process;
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    postgres.process = undefined;
    return;
  }
  await postgres.stop();
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Run the local PostgreSQL launcher as your normal user, not root.');
  }
  await mkdir(clusterDir, { recursive: true, mode: 0o700 });
  try {
    let lock;
    try { lock = await open(lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('PostgreSQL launcher lock exists. Check for a running launcher; see docs/LOCAL_POSTGRES.md.');
      throw error;
    }
    ownLock = true;
    try { await lock.writeFile(`${process.pid}\n`, 'utf8'); }
    finally { await lock.close(); }
    await portIsAvailable();
    const initialised = await clusterIsInitialised();
    await loadCredentials(initialised);
    postgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: username,
      password,
      port,
      authMethod: 'scram-sha-256',
      persistent: true,
      createPostgresUser: false,
      autoRehydrateSymlinks: true,
      postgresFlags: ['-h', '127.0.0.1', '-c', 'unix_socket_directories='],
      onLog: () => {},
      onError: () => {},
    });
    if (!initialised && !signalName) await postgres.initialise();
    if (signalName) return;
    await postgres.start();
    if (signalName) return;

    const client = postgres.getPgClient(database, '127.0.0.1');
    try { await client.connect(); await client.query('SELECT 1'); }
    finally { await client.end(); }
    const child = postgres.process;
    if (!child) throw new Error('PostgreSQL did not expose a running process.');
    const childExited = new Promise(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) resolveExit(true);
      else child.once('exit', () => resolveExit(true));
    });
    console.log(`PostgreSQL ready on 127.0.0.1:${port}; connection file: ${urlFile}`);
    if (await Promise.race([signalReceived.then(() => false), childExited])) {
      throw new Error('PostgreSQL exited unexpectedly.');
    }
  } finally {
    let stopped = true;
    try { await stopPostgres(); }
    catch { stopped = false; process.exitCode = 1; console.error('Could not stop PostgreSQL; the launcher lock was retained.'); }
    if (ownLock && stopped) await unlink(lockFile);
  }
}

try { await main(); }
catch (error) { console.error(safeMessage(error)); process.exitCode = 1; }
