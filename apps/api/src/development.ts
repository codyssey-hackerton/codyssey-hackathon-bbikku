import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts.map(String).join('.') !== host) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168);
}

// Local sessions are not a hosted authentication service. LAN access is explicit
// and restricted to an address assigned to this computer, never a wildcard bind.
export function assertDevelopmentBinding(
  env: NodeJS.ProcessEnv,
  host: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): void {
  if (env.PIKKU_DEV_AUTH !== 'true') return;
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  const assignedPrivate = env.PIKKU_DEV_ALLOW_LAN === 'true' && isPrivateIPv4(host) &&
    Object.values(interfaces).flatMap(items => items ?? []).some(item => item.family === 'IPv4' && !item.internal && item.address === host);
  if (env.NODE_ENV !== 'development' || (!loopback && !assignedPrivate)) {
    throw new Error('Development authentication requires NODE_ENV=development and a loopback HOST, or explicit LAN opt-in with an assigned private IPv4 HOST');
  }
}
