import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { assertDevelopmentBinding, isPrivateIPv4 } from '../src/development.ts';

const interfaces = { en0: [{ family: 'IPv4', internal: false, address: '192.168.10.5' } as NetworkInterfaceInfo] };
const dev = { NODE_ENV: 'development', PIKKU_DEV_AUTH: 'true' };
test('development LAN requires explicit opt-in and an assigned private address', () => {
  assert.doesNotThrow(() => assertDevelopmentBinding(dev, '127.0.0.1', interfaces));
  assert.throws(() => assertDevelopmentBinding(dev, '192.168.10.5', interfaces));
  const lan = { ...dev, PIKKU_DEV_ALLOW_LAN: 'true' };
  assert.doesNotThrow(() => assertDevelopmentBinding(lan, '192.168.10.5', interfaces));
  for (const host of ['0.0.0.0', '::', '192.168.10.6', '8.8.8.8', '192.168.10.005']) {
    assert.throws(() => assertDevelopmentBinding(lan, host, interfaces));
  }
  assert.throws(() => assertDevelopmentBinding({ ...lan, NODE_ENV: 'production' }, '192.168.10.5', interfaces));
});
test('private IPv4 ranges are exact, not string prefixes', () => {
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.0.1']) assert.equal(isPrivateIPv4(host), true);
  for (const host of ['172.15.0.1', '172.32.0.1', '10.0.0.999', '10.0.0', '10.0.0.1.example.com', '10.0.0.', '10.0.0.01']) assert.equal(isPrivateIPv4(host), false);
});
