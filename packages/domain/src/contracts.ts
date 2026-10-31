export interface TimeSlot {
  startsAt: string;
  endsAt: string;
  timezone: string;
}

export interface ScheduleFields {
  kind: "event" | "task";
  title: string;
  timeSlot: TimeSlot | null;
  durationMinutes: number | null;
  deadline: string | null;
  flexibility: "fixed" | "flexible";
  involvement: "personal" | "shared";
  completion: "pending" | "completed" | "incomplete" | "unknown";
}

export interface ScheduleItem extends ScheduleFields {
  id: string;
  revision: number;
  sourceRefs: SourceRef[];
}

export interface SourceRef {
  provider: string;
  accountRef: string;
  calendarId: string;
  externalEventId: string;
  lastSyncedAt: string;
  occurrenceKey?: string;
  sourceVersion?: string;
}

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export interface MemoryFact {
  id: string;
  revision: number;
  kind: "preference" | "situation" | "observation" | "inference";
  key: string;
  value: JSONValue;
  source: { type: "user" | "provider" | "derived"; ref: string };
  recordedAt: string;
  validUntil: string | null;
}

export interface ContextSnapshot {
  now: string;
  timezone: string;
  scheduleRevision: number;
  contextRevision: number;
  items: ScheduleItem[];
  facts: MemoryFact[];
  missingFields: string[];
}

export interface ValidationResult {
  valid: boolean;
  conflicts: { targetIds: string[]; reason: string; timeSlot?: TimeSlot }[];
  missingFields: string[];
  protectedTargets: string[];
  checkedScheduleRevision: number;
  checkedContextRevision: number;
  checkedAt: string;
}

export type Change =
  | { changeId: string; operation: "create"; after: ScheduleFields }
  | {
      changeId: string;
      operation: "update";
      targetId: string;
      expectedRevision: number;
      after: ScheduleFields;
    }
  | { changeId: string; operation: "delete"; targetId: string; expectedRevision: number };

export interface ChangeSet {
  changes: Change[];
}

export type ProposalMode = "personal" | "coordination";

export interface CoordinationTarget {
  id: string;
  expectedRevision: number;
}

interface ProposalFields {
  id: string;
  revision: number;
  baseScheduleRevision: number;
  baseContextRevision: number;
  changeSet: ChangeSet;
  beforeItems: ScheduleItem[];
  reason: string;
  evidenceRefs: string[];
  validation: ValidationResult;
  createdAt: string;
  expiresAt: string | null;
  status: "pending" | "awaiting_contact" | "applied" | "rejected" | "stale" | "expired" | "failed";
}

export type Proposal = ProposalFields & (
  | { mode: "personal"; coordinationTarget: null }
  | { mode: "coordination"; coordinationTarget: CoordinationTarget }
);

export interface Approval {
  id: string;
  subjectType: "proposal" | "contact_request";
  subjectId: string;
  subjectRevision: number;
  decision: "accept" | "reject";
  decidedAt: string;
  actorRef: string;
}

export type AgentResult =
  | { kind: "reply"; message: string }
  | { kind: "question"; message: string; missingFields: string[] }
  | { kind: "proposal"; message: string; proposalIds: string[] }
  | { kind: "failure"; message: string; code: string; retryable: boolean };

export interface ReadScheduleInput {
  from: string;
  to: string;
  timezone: string;
}

export interface ReadScheduleOutput {
  items: ScheduleItem[];
  scheduleRevision: number;
}

export interface ReadMemoryInput {
  keys: string[];
  at: string;
}

export interface ReadMemoryOutput {
  facts: MemoryFact[];
  contextRevision: number;
  missingFields: string[];
}

export interface CalculateTimingInput {
  appointmentStart: string;
  preparationMinutes: number;
  travelMinutes: number;
  bufferMinutes: number;
}

export type CalculateTimingOutput =
  | { ready: true; departureAt: string; preparationStartAt: string }
  | { ready: false; missingFields: string[]; message: string };

export interface ValidateChangesInput {
  changeSet: ChangeSet;
}

export type ValidateChangesOutput = ValidationResult;

export interface ChatInput {
  requestId: string;
  conversationId: string | null;
  message: string;
  timezone: string;
  coordinationTarget?: CoordinationTarget;
}

export interface ChatOutput {
  conversationId: string;
  result: AgentResult;
}

export interface ListProposalsInput {
  status?: Proposal["status"];
  cursor?: string;
  limit?: number;
}

export interface ListProposalsOutput {
  proposals: Proposal[];
  nextCursor: string | null;
}

export interface ReviewSchedule {
  revision: number;
  timezone: string;
  evening: { enabled: boolean; localTime: string | null };
  morning: { enabled: boolean; localTime: string | null };
}

export interface UpdateReviewScheduleInput {
  requestId: string;
  expectedRevision: number;
  timezone: string;
  evening: ReviewSchedule["evening"];
  morning: ReviewSchedule["morning"];
}

export interface ReviewScheduleOutput {
  reviewSchedule: ReviewSchedule;
}

export interface CreateRecipientInput {
  requestId: string;
  displayName: string;
  channel: "email" | "phone";
  address: string;
  confirmed: true;
}

export interface Recipient {
  id: string;
  displayName: string;
  channel: "email" | "phone";
  address: string;
  confirmedByUserAt: string;
}

export interface CreateRecipientOutput {
  recipient: Recipient;
}
