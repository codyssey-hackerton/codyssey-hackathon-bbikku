import { z } from 'zod';
import { identifier } from './planning-schemas.ts';

const channel = z.enum(['email', 'phone']);
const singleLine = (limit: number) => z.string().max(limit).refine(value =>
  value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value);

export const recipientBody = z.object({
  requestId: identifier, displayName: singleLine(200), channel,
  address: z.string().max(254).refine(value => value.trim().length > 0), confirmed: z.literal(true),
}).strict();

export const contactBody = z.object({
  requestId: identifier, recipientRef: identifier, channel, purpose: singleLine(200),
  messageOrCallBrief: z.string().max(20_000).refine(value => value.trim().length > 0 && Buffer.from(value, 'utf8').toString('utf8') === value),
  allowedOptions: z.array(z.object({ optionId: identifier, proposalId: identifier, proposalRevision: z.number().int().min(1) }).strict()).min(1).max(100),
}).strict().refine(value => new Set(value.allowedOptions.map(option => option.optionId)).size === value.allowedOptions.length &&
  new Set(value.allowedOptions.map(option => option.proposalId)).size === value.allowedOptions.length);

export const contactDecisionBody = z.object({ requestId: identifier, contactRevision: z.number().int().min(1), decision: z.enum(['accept', 'reject']) }).strict();
