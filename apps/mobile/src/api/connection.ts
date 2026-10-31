/** Normalize exactly the base URL that the API client uses; invalid inputs return null. */
export function normalizeApiBaseUrl(value: string): string | null {
  const input = value.trim();
  if (!input || /[\s\\?#]/.test(input)) return null;
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(input);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  if (authority.includes('@')) return null;

  let hostname: string;
  let portText = '';
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end === -1) return null;
    hostname = authority.slice(0, end + 1).toLowerCase();
    const rest = authority.slice(end + 1);
    if (!/^\[[0-9a-f:.]+\]$/i.test(hostname) || (rest && !rest.startsWith(':'))) return null;
    portText = rest.slice(1);
  } else {
    const colon = authority.indexOf(':');
    if (colon !== -1 && colon !== authority.lastIndexOf(':')) return null;
    hostname = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
    portText = colon === -1 ? '' : authority.slice(colon + 1);
    if (!hostname || !/^[a-z0-9._~-]+$/i.test(hostname)) return null;
  }
  if (portText && !/^\d+$/.test(portText)) return null;
  const port = portText ? Number(portText) : null;
  if (port !== null && (!Number.isSafeInteger(port) || port > 65535)) return null;
  const normalizedPort = port === null || (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443)
    ? '' : `:${port}`;

  // Only dot segments are resolved; path spelling/case and interior slashes remain significant.
  const segments: string[] = [];
  for (const segment of (match[3] ?? '').split('/').slice(1)) {
    const dots = segment.replace(/%2e/gi, '.');
    if (dots === '.') continue;
    if (dots === '..') { segments.pop(); continue; }
    segments.push(segment);
  }
  const path = segments.length ? `/${segments.join('/')}`.replace(/\/+$/, '') : '';
  return `${scheme}://${hostname}${normalizedPort}${path}`;
}
