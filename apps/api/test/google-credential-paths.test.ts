import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveGoogleCredentialPaths } from '../src/google-credential-paths.ts';

test('an absent or blank directory preserves the existing factory defaults', () => {
  for (const directory of [undefined, '', '   ']) {
    assert.deepEqual(resolveGoogleCredentialPaths(directory), { gmailPath: undefined, repliesPath: undefined, calendarPath: undefined });
  }
});

test('an absolute directory supplies all three consistent credential paths without accessing them', () => {
  const directory = join(tmpdir(), '없는 연결 폴더');
  assert.deepEqual(resolveGoogleCredentialPaths(directory), {
    gmailPath: join(directory, 'gmail-connection.json'),
    repliesPath: join(directory, 'gmail-replies-connection.json'),
    calendarPath: join(directory, 'calendar-connection.json'),
  });
});

test('relative or malformed directories fail with a generic error that omits the supplied value', () => {
  for (const directory of ['relative/private-value', './private-value', `/${'private-value'}\0bad`]) {
    assert.throws(() => resolveGoogleCredentialPaths(directory), { message: 'GOOGLE_CREDENTIAL_PATH_INVALID' });
  }
});
