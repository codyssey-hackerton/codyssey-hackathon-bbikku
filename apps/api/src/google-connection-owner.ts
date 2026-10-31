export function resolveGoogleConnectionOwner(options: {
  developmentAuth: boolean; previewAuth: boolean; previewMembers: unknown; configuredUserId?: string; credentialDirectory?: string;
}): string | undefined {
  if (options.developmentAuth) return 'local-developer';
  if (!options.previewAuth || options.configuredUserId === undefined) return undefined;
  const id = options.configuredUserId;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !options.credentialDirectory?.trim() || !Array.isArray(options.previewMembers) ||
      options.previewMembers.filter(member => member && typeof member === 'object' && member.userId === id).length !== 1) {
    throw new Error('GOOGLE_CONNECTION_OWNER_INVALID');
  }
  return id;
}
