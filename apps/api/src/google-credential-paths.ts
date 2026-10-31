import { isAbsolute, join } from 'node:path';

export function resolveGoogleCredentialPaths(directory?: string): {
  gmailPath: string | undefined; repliesPath: string | undefined; calendarPath: string | undefined;
} {
  if (directory === undefined || (typeof directory === 'string' && !directory.trim())) {
    return { gmailPath: undefined, repliesPath: undefined, calendarPath: undefined };
  }
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) {
    throw new Error('GOOGLE_CREDENTIAL_PATH_INVALID');
  }
  return {
    gmailPath: join(directory, 'gmail-connection.json'),
    repliesPath: join(directory, 'gmail-replies-connection.json'),
    calendarPath: join(directory, 'calendar-connection.json'),
  };
}
