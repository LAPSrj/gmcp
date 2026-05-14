// Translation between outlook-mcp's structured {pattern, range} shape and
// RFC 5545 RRULE strings, as Google Calendar's events.recurrence expects.

export type DayOfWeek =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export type PatternType =
  | "daily"
  | "weekly"
  | "absoluteMonthly"
  | "relativeMonthly"
  | "absoluteYearly"
  | "relativeYearly";

export type IndexWord = "first" | "second" | "third" | "fourth" | "last";

export type RangeType = "endDate" | "noEnd" | "numbered";

export interface RecurrencePattern {
  type: PatternType;
  interval: number;
  days_of_week?: DayOfWeek[];
  first_day_of_week?: DayOfWeek;
  day_of_month?: number;
  month?: number;
  index?: IndexWord;
}

export interface RecurrenceRange {
  type: RangeType;
  start_date: string; // YYYY-MM-DD
  end_date?: string; // YYYY-MM-DD
  number_of_occurrences?: number;
  timezone: string; // IANA timezone
}

export interface Recurrence {
  pattern: RecurrencePattern;
  range: RecurrenceRange;
}

const DAY_MAP: Record<DayOfWeek, string> = {
  sunday: "SU",
  monday: "MO",
  tuesday: "TU",
  wednesday: "WE",
  thursday: "TH",
  friday: "FR",
  saturday: "SA",
};

const INDEX_MAP: Record<IndexWord, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  last: -1,
};

// Returns an array because Google's `events.recurrence` field is an array of
// RRULE/RDATE/EXDATE strings. We emit a single RRULE.
export function buildRecurrenceLines(r: Recurrence): string[] {
  const parts: string[] = [];
  const interval = Math.max(1, r.pattern.interval | 0);

  switch (r.pattern.type) {
    case "daily":
      parts.push("FREQ=DAILY");
      if (interval !== 1) parts.push(`INTERVAL=${interval}`);
      break;
    case "weekly": {
      parts.push("FREQ=WEEKLY");
      if (interval !== 1) parts.push(`INTERVAL=${interval}`);
      const days = (r.pattern.days_of_week ?? []).map((d) => DAY_MAP[d]).join(",");
      if (days) parts.push(`BYDAY=${days}`);
      if (r.pattern.first_day_of_week) parts.push(`WKST=${DAY_MAP[r.pattern.first_day_of_week]}`);
      break;
    }
    case "absoluteMonthly": {
      parts.push("FREQ=MONTHLY");
      if (interval !== 1) parts.push(`INTERVAL=${interval}`);
      if (r.pattern.day_of_month === undefined) {
        throw new Error("absoluteMonthly requires pattern.day_of_month");
      }
      parts.push(`BYMONTHDAY=${r.pattern.day_of_month}`);
      break;
    }
    case "relativeMonthly": {
      parts.push("FREQ=MONTHLY");
      if (interval !== 1) parts.push(`INTERVAL=${interval}`);
      const days = (r.pattern.days_of_week ?? []).map((d) => DAY_MAP[d]).join(",");
      if (!days) throw new Error("relativeMonthly requires pattern.days_of_week");
      if (!r.pattern.index) throw new Error("relativeMonthly requires pattern.index");
      const n = INDEX_MAP[r.pattern.index];
      // RFC 5545: BYSETPOS allows nth-of-month-of-given-weekday. Cleaner than `nWEEKDAY` notation
      // when multiple days are supplied.
      parts.push(`BYDAY=${days}`);
      parts.push(`BYSETPOS=${n}`);
      break;
    }
    case "absoluteYearly": {
      parts.push("FREQ=YEARLY");
      if (interval !== 1) parts.push(`INTERVAL=${interval}`);
      if (r.pattern.month === undefined) throw new Error("absoluteYearly requires pattern.month");
      if (r.pattern.day_of_month === undefined) {
        throw new Error("absoluteYearly requires pattern.day_of_month");
      }
      parts.push(`BYMONTH=${r.pattern.month}`);
      parts.push(`BYMONTHDAY=${r.pattern.day_of_month}`);
      break;
    }
    case "relativeYearly": {
      parts.push("FREQ=YEARLY");
      if (interval !== 1) parts.push(`INTERVAL=${interval}`);
      if (r.pattern.month === undefined) throw new Error("relativeYearly requires pattern.month");
      const days = (r.pattern.days_of_week ?? []).map((d) => DAY_MAP[d]).join(",");
      if (!days) throw new Error("relativeYearly requires pattern.days_of_week");
      if (!r.pattern.index) throw new Error("relativeYearly requires pattern.index");
      parts.push(`BYMONTH=${r.pattern.month}`);
      parts.push(`BYDAY=${days}`);
      parts.push(`BYSETPOS=${INDEX_MAP[r.pattern.index]}`);
      break;
    }
  }

  // Range terminator
  if (r.range.type === "endDate") {
    if (!r.range.end_date) throw new Error("range.endDate requires end_date");
    // RFC 5545 UNTIL must be UTC (Z suffix) per spec for non-floating events.
    // Convert YYYY-MM-DD → end-of-day in the recurrence timezone → UTC.
    const untilUtc = endOfDayInTzToUtc(r.range.end_date, r.range.timezone);
    parts.push(`UNTIL=${untilUtc}`);
  } else if (r.range.type === "numbered") {
    if (!r.range.number_of_occurrences) {
      throw new Error("range.numbered requires number_of_occurrences");
    }
    parts.push(`COUNT=${r.range.number_of_occurrences}`);
  }
  // "noEnd" → no terminator.

  return [`RRULE:${parts.join(";")}`];
}

// Convert a YYYY-MM-DD date at end-of-day in `tz` to a UTC "YYYYMMDDTHHMMSSZ" string
// suitable for RRULE UNTIL.
function endOfDayInTzToUtc(date: string, tz: string): string {
  const [y, m, d] = date.split("-").map((s) => Number(s));
  if (!y || !m || !d) throw new Error(`invalid end_date: ${date}`);
  // Strategy: take 23:59:59 in tz, find what UTC instant produces those wall-clock
  // parts, by binary-searching offset (or, simpler and correct: use Intl to learn
  // the UTC offset of `tz` on this calendar day, then construct the UTC time).
  // For RRULE UNTIL purposes, end-of-day at second precision is fine.
  const offsetMin = tzOffsetMinutes(tz, new Date(Date.UTC(y, m - 1, d, 23, 59, 59)));
  const utcEpochMs = Date.UTC(y, m - 1, d, 23, 59, 59) - offsetMin * 60_000;
  const u = new Date(utcEpochMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${u.getUTCFullYear()}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}T${pad(u.getUTCHours())}${pad(u.getUTCMinutes())}${pad(u.getUTCSeconds())}Z`;
}

// Returns the offset of `tz` from UTC, in minutes (e.g. America/Sao_Paulo = -180).
function tzOffsetMinutes(tz: string, atUtcInstant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(atUtcInstant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  let h = get("hour");
  if (h === 24) h = 0; // some locales return 24 for midnight
  const mi = get("minute");
  const s = get("second");
  const localEpoch = Date.UTC(y, mo - 1, d, h, mi, s);
  return Math.round((localEpoch - atUtcInstant.getTime()) / 60_000);
}
