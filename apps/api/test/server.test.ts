import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function start(env: Record<string, string>): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH ?? '', PIKKU_OPENAI_API_KEY: '', PIKKU_DEV_AUTH: 'true', PIKKU_DEV_SESSION_TOKEN: 'local-test-token-only', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr?.on('data', chunk => { errors += String(chunk); });
  return { child, stderr: () => errors };
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}

test('server process answers real HTTP requests and exits cleanly', async () => {
  const port = await freePort();
  const { child, stderr } = start({ NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port) });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = (await fetch(`${base}/health`)).ok; if (ready) break; } catch { /* startup */ }
      if (child.exitCode !== null) throw new Error(`Server exited early: ${child.exitCode}; ${stderr()}`);
      await delay(100);
    }
    assert.equal(ready, true, 'server failed to start');
    const unauthenticated = await fetch(`${base}/v1/capabilities`);
    assert.equal(unauthenticated.status, 401);
    const authorization = 'Bearer local-test-token-only';
    const capability = await fetch(`${base}/v1/capabilities`, { headers: { authorization } });
    assert.equal((await capability.json()).data.model.status, 'not_configured');
    const chat = await fetch(`${base}/v1/chat`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': 'smoke' },
      body: JSON.stringify({ requestId: 'smoke', conversationId: null, message: '고마워', timezone: 'Asia/Seoul' }),
    });
    assert.equal(chat.status, 503);
    assert.equal((await chat.json()).error.code, 'not_configured');
  } finally { await stop(child); }
  assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'server process must stop');
});

test('incomplete local Gmail setup disables only email and is ignored without development auth', async () => {
  for (const development of [true, false]) {
    const port = await freePort();
    const fakeClientId = 'example-incomplete-client-id';
    const { child, stderr } = start({ NODE_ENV: development ? 'development' : 'production', HOST: '127.0.0.1', PORT: String(port),
      PIKKU_DEV_AUTH: development ? 'true' : 'false', PIKKU_GOOGLE_OAUTH_CLIENT_ID: fakeClientId, PIKKU_GOOGLE_OAUTH_CLIENT_SECRET: '' });
    const base = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try { ready = (await fetch(`${base}/health`)).ok; if (ready) break; } catch { /* startup */ }
        if (child.exitCode !== null) throw new Error(`Server exited early: ${child.exitCode}`);
        await delay(100);
      }
      assert.equal(ready, true);
      const response = await fetch(`${base}/v1/email-connection`, { headers: { authorization: 'Bearer local-test-token-only' } });
      if (development) {
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).data, { status: 'not_configured', senderAddress: null });
        assert.match(stderr(), /Gmail 연결 설정을 확인해 주세요\./);
      } else {
        assert.equal(response.status, 401);
        assert.doesNotMatch(stderr(), /Gmail 연결 설정/);
      }
      assert.doesNotMatch(stderr(), new RegExp(fakeClientId));
    } finally { await stop(child); }
  }
});

test('development authentication refuses public binding and production mode', async () => {
  for (const env of [
    { NODE_ENV: 'development', HOST: '0.0.0.0' },
    { NODE_ENV: 'production', HOST: '127.0.0.1' },
  ]) {
    const { child, stderr } = start(env);
    const exited = once(child, 'exit');
    try {
      const result = await Promise.race([exited, delay(5000).then(() => { throw new Error('Invalid server configuration did not exit'); })]);
      assert.notEqual(result[0], 0);
      assert.match(stderr(), /Development authentication requires NODE_ENV=development and a loopback HOST/);
    } finally { await stop(child); }
  }
});

test('enabling the scheduler without an explicit database fails at startup', async () => {
  const { child, stderr } = start({ NODE_ENV: 'development', HOST: '127.0.0.1', PIKKU_SCHEDULER_ENABLED: 'true', PIKKU_DATABASE_URL: '' });
  const exited = once(child, 'exit');
  try {
    const result = await Promise.race([exited, delay(5000).then(() => { throw new Error('Invalid scheduler configuration did not exit'); })]);
    assert.notEqual(result[0], 0);
    assert.match(stderr(), /PIKKU_DATABASE_URL is required when the scheduler is enabled/);
  } finally { await stop(child); }
});
