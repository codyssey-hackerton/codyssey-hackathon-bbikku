import * as Contacts from 'expo-contacts/legacy';
import type { DeviceSearch } from './device-contacts';

export async function searchDeviceContacts(query: string): Promise<DeviceSearch> {
  if (!(await Contacts.isAvailableAsync())) return { status: 'unavailable' };
  let permission = await Contacts.getPermissionsAsync();
  if (!permission.granted && permission.accessPrivileges !== 'limited' && permission.canAskAgain) permission = await Contacts.requestPermissionsAsync();
  if (!permission.granted && permission.accessPrivileges !== 'limited') return { status: 'denied' };
  const result = await Contacts.getContactsAsync({ name: query, fields: [Contacts.Fields.PhoneNumbers], pageSize: 30, pageOffset: 0 });
  return { status: 'ok', limited: permission.accessPrivileges === 'limited', truncated: result.hasNextPage,
    contacts: result.data.map(contact => ({ id: contact.id, displayName: contact.name || '이름 없음',
      phoneNumbers: (contact.phoneNumbers ?? []).flatMap(phone => phone.number ? [{ number: phone.number, ...(phone.label ? { label: phone.label } : {}) }] : []) })) };
}
