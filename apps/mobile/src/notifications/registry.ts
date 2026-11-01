type Entry = { fingerprint: string; status: 'scheduled' | 'uncertain' | 'cancelling'; owner: object };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
export function reminderEntry(id: string | null): Entry | undefined { return id ? entries.get(id) : undefined; }
export function setReminderEntry(id: string, entry: Entry): void {
  entries.set(id, entry); for (const listener of listeners) listener();
}
export function clearReminderEntry(id: string, expected: Entry): void {
  if (entries.get(id) !== expected) return;
  entries.delete(id); for (const listener of listeners) listener();
}
export function subscribeReminders(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
