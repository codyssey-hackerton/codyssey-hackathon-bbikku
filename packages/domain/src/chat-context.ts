export type FormDraft = {
  kind: 'event' | 'task' | 'routine';
  fields: Record<string, string | string[]>;
};

export type ChatContext =
  | { kind: 'create' }
  | { kind: 'item'; id: string; expectedRevision: number }
  | { kind: 'form'; draft: FormDraft };
