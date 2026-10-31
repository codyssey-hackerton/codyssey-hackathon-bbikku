import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
for (const arg of args) if (!['--lan', '--api-only', '--smoke', '--postgres', '--scheduler'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
let databaseUrl = process.env.PIKKU_DATABASE_URL?.trim();
if (args.has('--postgres')) {
  if (databaseUrl) throw new Error('--postgres cannot override PIKKU_DATABASE_URL; choose the local flag or an explicit URL.');
  try { databaseUrl = readFileSync(resolve(root, '.local/postgres-url.txt'), 'utf8').trim(); }
  catch { throw new Error('Start npm run dev:db first to create the local database connection file.'); }
  if (!databaseUrl) throw new Error('Local PostgreSQL connection file is empty.');
}
const schedulerEnabled = args.has('--scheduler') || process.env.PIKKU_SCHEDULER_ENABLED === 'true';
if (schedulerEnabled && !databaseUrl) throw new Error('Scheduler requires PostgreSQL: use --postgres or PIKKU_DATABASE_URL.');
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
const privateAddress = value => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
const interfaces = networkInterfaces();
const addresses = Object.entries(interfaces).sort(([a], [b]) => Number(b === 'en0') - Number(a === 'en0'))
  .flatMap(([, values]) => values ?? []).filter(item => !item.internal && item.family === 'IPv4' && privateAddress(item.address)).map(item => item.address);
let host = '127.0.0.1';
if (args.has('--lan')) {
  host = process.env.PIKKU_DEV_LAN_HOST || addresses[0];
  if (!host || !addresses.includes(host)) throw new Error('No assigned private LAN IPv4 found. Set PIKKU_DEV_LAN_HOST to this computer’s Wi-Fi address.');
}
// Fail before changing a token file when another process already owns this port.
await new Promise((accept, reject) => {
  const probe = createServer();
  probe.once('error', () => reject(new Error(`Port ${port} is already in use or cannot bind. Choose a different PORT.`)));
  probe.listen(port, host, () => probe.close(error => error ? reject(error) : accept()));
});

const token = randomBytes(32).toString('hex');
const localDirectory = resolve(root, '.local');
const tokenPath = resolve(localDirectory, `dev-session-${port}.txt`);
await mkdir(localDirectory, { recursive: true, mode: 0o700 });
await writeFile(tokenPath, token, { mode: 0o600 });
await chmod(tokenPath, 0o600);
const children = [];
let stopping = false;
let shutdownPromise;
function removeToken() {
  try { if (readFileSync(tokenPath, 'utf8') === token) unlinkSync(tokenPath); } catch { /* already removed */ }
}
process.on('exit', removeToken);
function stop(code = 0) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  removeToken();
  shutdownPromise = (async () => {
    for (const child of children) signal(child, 'SIGTERM');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolveExit => {
      const timer = setTimeout(() => { signal(child, 'SIGKILL'); resolveExit(); }, 2500);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    })));
    process.exitCode = code;
  })();
  return shutdownPromise;
}
function signal(child, name) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
    else child.kill(name);
  } catch (error) { if (error.code !== 'ESRCH') console.error('Could not stop a development child process.'); }
}
function launch(commandArgs, env, cwd = root) {
  const child = spawn(process.execPath, commandArgs, { cwd, env, stdio: 'inherit', detached: process.platform !== 'win32' });
  children.push(child);
  child.once('error', () => { console.error('Failed to start a development child process.'); void stop(1); });
  child.once('exit', (code, signalName) => { if (!stopping) { console.error(`Development child stopped (${signalName ?? code}).`); void stop(code === 0 || signalName === 'SIGINT' || signalName === 'SIGTERM' ? 0 : 1); } });
  return child;
}
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, () => { void stop(0); });
const baseUrl = `http://${host}:${port}`;
console.log(`API: ${baseUrl}`);
console.log(`Local session file (not logged, removed on exit): ${tokenPath}`);
console.log('Paste its value into the app connection settings. This is a local development session, not an AI API key.');
if (args.has('--lan')) console.warn('LAN development only: HTTP tokens/data are unencrypted; Expo Metro has no API session protection. Use test data on a trusted private network, never public Wi-Fi or port forwarding.');
try {
  launch(['--import', 'tsx', ...(args.has('--smoke') ? [] : ['--watch']), 'apps/api/src/server.ts'], {
    ...process.env, NODE_ENV: 'development', HOST: host, PORT: String(port),
    ...(databaseUrl ? { PIKKU_DATABASE_URL: databaseUrl } : {}), PIKKU_SCHEDULER_ENABLED: String(schedulerEnabled),
    PIKKU_DEV_AUTH: 'true', PIKKU_DEV_ALLOW_LAN: String(args.has('--lan')), PIKKU_DEV_SESSION_TOKEN: token,
  });
  let ready = false;
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/v1/capabilities`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* startup */ }
    await delay(100);
  }
  if (!ready) throw new Error('API did not become ready. See the server error above.');
  if (args.has('--smoke')) {
    await stop(0);
    console.log('PASS: local launcher and authenticated HTTP readiness; children stopped. No model request was made.');
  } else if (!args.has('--api-only') && !stopping) {
    const mobileRequire = createRequire(resolve(root, 'apps/mobile/package.json'));
    const expoEnv = { ...process.env, NODE_ENV: 'development', EXPO_PUBLIC_API_URL: baseUrl };
    delete expoEnv.PIKKU_OPENAI_API_KEY;
    delete expoEnv.PIKKU_DEV_SESSION_TOKEN;
    delete expoEnv.OPENAI_API_KEY;
    delete expoEnv.ANTHROPIC_API_KEY;
    // Database and OAuth credentials belong only to the API process.
    for (const name of Object.keys(expoEnv)) {
      if (name.startsWith('PIKKU_') || /(?:DATABASE_URL|CLIENT_SECRET|REFRESH_TOKEN)$/.test(name)) delete expoEnv[name];
    }
    launch([mobileRequire.resolve('expo/bin/cli'), 'start', args.has('--lan') ? '--lan' : '--localhost'], expoEnv, resolve(root, 'apps/mobile'));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local launcher failed.');
  await stop(1);
}
