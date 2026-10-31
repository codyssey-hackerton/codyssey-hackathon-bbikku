export interface TimeRange {
  start: string;
  end: string;
}

export type TimeRangeError = "invalid-start" | "invalid-end" | "start-not-before-end";

export type TimeRangeValidation =
  | { valid: true; startMs: number; endMs: number }
  | { valid: false; reason: TimeRangeError };

// Accept calendar dates with an explicit numeric offset or Z. Precision is
// limited to milliseconds so that comparisons never discard input precision.
const OFFSET_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/;

/** Returns epoch milliseconds, or null for malformed/ambiguous input. */
export function parseOffsetDateTime(value: string): number | null {
  if (typeof value !== "string") return null;
  const parts = OFFSET_DATE_TIME.exec(value);
  if (!parts) return null;

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6] ?? 0);
  const offsetHour = Number(parts[9] ?? 0);
  const offsetMinute = Number(parts[10] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function validateTimeRange(range: TimeRange): TimeRangeValidation {
  const startMs = parseOffsetDateTime(range?.start);
  if (startMs === null) return { valid: false, reason: "invalid-start" };
  const endMs = parseOffsetDateTime(range?.end);
  if (endMs === null) return { valid: false, reason: "invalid-end" };
  if (startMs >= endMs) return { valid: false, reason: "start-not-before-end" };
  return { valid: true, startMs, endMs };
}

export interface PreparationInput {
  appointmentStart?: string | null;
  preparationMinutes?: number | null;
  travelMinutes?: number | null;
  bufferMinutes?: number | null;
}

export type PreparationField = keyof PreparationInput;

export type PreparationResult =
  | {
      status: "ready";
      departureTime: string;
      preparationStart: string;
      inputs: Required<NonNullablePreparationInput>;
    }
  | { status: "missing"; fields: PreparationField[] }
  | { status: "invalid"; fields: PreparationField[]; reason: "invalid-value" | "out-of-range" };

type NonNullablePreparationInput = {
  [K in keyof PreparationInput]-?: NonNullable<PreparationInput[K]>;
};

/** Results use UTC ISO strings; consumers may format them in the user's zone. */
export function calculatePreparationTimes(input: PreparationInput): PreparationResult {
  const fields: PreparationField[] = ["appointmentStart", "preparationMinutes", "travelMinutes", "bufferMinutes"];
  const missing = fields.filter((field) => input[field] == null);
  const invalid = fields.filter((field) => {
    const value = input[field];
    if (value == null) return false;
    if (field === "appointmentStart") {
      return typeof value !== "string" || parseOffsetDateTime(value) === null;
    }
    return typeof value !== "number" || value < 0 || !Number.isSafeInteger(value * 60_000);
  });
  if (invalid.length) return { status: "invalid", fields: invalid, reason: "invalid-value" };
  if (missing.length) return { status: "missing", fields: missing };

  // All four fields were checked above; preserve them for the caller's explanation.
  const inputs = input as NonNullablePreparationInput;
  const appointmentMs = parseOffsetDateTime(inputs.appointmentStart)!;
  const departureMs = appointmentMs - inputs.travelMinutes * 60_000 - inputs.bufferMinutes * 60_000;
  const preparationMs = departureMs - inputs.preparationMinutes * 60_000;
  const departure = new Date(departureMs);
  const preparation = new Date(preparationMs);
  if (
    !Number.isFinite(departure.getTime()) || !Number.isFinite(preparation.getTime()) ||
    departure.getUTCFullYear() < 0 || departure.getUTCFullYear() > 9999 ||
    preparation.getUTCFullYear() < 0 || preparation.getUTCFullYear() > 9999
  ) return { status: "invalid", fields, reason: "out-of-range" };
  return {
    status: "ready",
    departureTime: departure.toISOString(),
    preparationStart: preparation.toISOString(),
    inputs: { ...inputs },
  };
}
