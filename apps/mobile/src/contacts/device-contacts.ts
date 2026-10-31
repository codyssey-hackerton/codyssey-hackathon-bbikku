export type ContactChoice = { id: string; displayName: string; phoneNumbers: { number: string; label?: string }[] };
export type DeviceSearch = { status: 'ok'; contacts: ContactChoice[]; limited: boolean; truncated: boolean } | { status: 'denied' | 'unavailable' };

// Metro resolves the native implementation on iOS and Android.
export async function searchDeviceContacts(_query: string): Promise<DeviceSearch> { return { status: 'unavailable' }; }
