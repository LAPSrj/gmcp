// Shared Google Calendar event shapes + the compact projection used by both
// the calendar tools (src/tools/calendar.ts) and the standalone change-listener
// (scripts/calendar-listen.ts). Mirrors the role mime.ts plays for mail: a
// single source of truth for the wire types and the agent-facing compact shape,
// so the listener emits exactly what calendar_get_event / calendar_list_events
// return.

export interface EventDateTime {
  date?: string; // YYYY-MM-DD (all-day)
  dateTime?: string; // RFC3339
  timeZone?: string;
}

export interface ConferenceData {
  conferenceSolution?: { name?: string; key?: { type?: string } };
  entryPoints?: { entryPointType?: string; uri?: string }[];
  createRequest?: { requestId?: string };
}

export interface CalendarAttendee {
  email?: string;
  displayName?: string;
  optional?: boolean;
  resource?: boolean;
  organizer?: boolean;
  self?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  comment?: string;
}

export interface CalendarEvent {
  id?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  attendees?: CalendarAttendee[];
  organizer?: { email?: string; displayName?: string };
  recurrence?: string[];
  recurringEventId?: string;
  hangoutLink?: string;
  conferenceData?: ConferenceData;
  transparency?: "opaque" | "transparent";
  visibility?: "default" | "public" | "private" | "confidential";
  reminders?: { useDefault?: boolean; overrides?: { method?: string; minutes?: number }[] };
  htmlLink?: string;
  iCalUID?: string;
  created?: string;
  updated?: string;
}

// Normalize a Google attendee responseStatus to the outlook-mcp-parity vocabulary
// used across the calendar tools.
export function attendeeResponse(
  status: CalendarAttendee["responseStatus"],
): "accepted" | "declined" | "tentativelyAccepted" | "notResponded" {
  return status === "accepted"
    ? "accepted"
    : status === "declined"
      ? "declined"
      : status === "tentative"
        ? "tentativelyAccepted"
        : "notResponded";
}

// ---------- Change detection (used by the calendar change-listener) ----------

// A minimal snapshot of the fields the listener diffs across syncs.
export interface EventChangeBaseline {
  status?: string;
  startKey: string;
  endKey: string;
  responses: Record<string, string>; // lowercased email -> Google responseStatus
}

function dtKey(dt?: EventDateTime): string {
  return dt?.dateTime ?? dt?.date ?? "";
}

export function snapshotEvent(e: CalendarEvent): EventChangeBaseline {
  const responses: Record<string, string> = {};
  for (const a of e.attendees ?? []) {
    if (a.email) responses[a.email.toLowerCase()] = a.responseStatus ?? "needsAction";
  }
  return { status: e.status, startKey: dtKey(e.start), endKey: dtKey(e.end), responses };
}

export interface AttendeeResponseChange {
  email: string;
  name: string | null;
  from: ReturnType<typeof attendeeResponse> | null; // null = newly added attendee
  to: ReturnType<typeof attendeeResponse>;
}

export interface EventChange {
  attendee_changes: AttendeeResponseChange[];
  rescheduled: boolean;
  cancelled: boolean;
  newly_cancelled: boolean;
}

// Diff a fresh event against its prior baseline. Returns null when the event has
// no prior baseline (first sighting) — the caller emits a baseline instead.
export function diffEvent(prev: EventChangeBaseline | undefined, e: CalendarEvent): EventChange | null {
  if (!prev) return null;
  const attendee_changes: AttendeeResponseChange[] = [];
  for (const a of e.attendees ?? []) {
    if (!a.email) continue;
    const before = prev.responses[a.email.toLowerCase()];
    const after = a.responseStatus ?? "needsAction";
    if (before !== after) {
      attendee_changes.push({
        email: a.email,
        name: a.displayName ?? null,
        from: before ? attendeeResponse(before as CalendarAttendee["responseStatus"]) : null,
        to: attendeeResponse(after as CalendarAttendee["responseStatus"]),
      });
    }
  }
  const rescheduled = dtKey(e.start) !== prev.startKey || dtKey(e.end) !== prev.endKey;
  const cancelled = e.status === "cancelled";
  const newly_cancelled = cancelled && prev.status !== "cancelled";
  return { attendee_changes, rescheduled, cancelled, newly_cancelled };
}

export function compactEvent(e: CalendarEvent): Record<string, unknown> {
  const startDT = e.start?.dateTime ?? e.start?.date ?? null;
  const endDT = e.end?.dateTime ?? e.end?.date ?? null;
  const isAllDay = !!e.start?.date && !e.start?.dateTime;
  const meetUrl =
    e.hangoutLink ??
    e.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === "video")?.uri ??
    null;
  return {
    id: e.id,
    subject: e.summary ?? null,
    start: e.start ? { date_time: startDT, timezone: e.start.timeZone ?? null } : null,
    end: e.end ? { date_time: endDT, timezone: e.end?.timeZone ?? null } : null,
    is_all_day: isAllDay,
    is_cancelled: e.status === "cancelled",
    location: e.location ?? null,
    organizer: e.organizer?.email
      ? { email: e.organizer.email, name: e.organizer.displayName ?? null }
      : null,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email,
      name: a.displayName ?? null,
      type: a.resource ? "resource" : a.optional ? "optional" : "required",
      response: attendeeResponse(a.responseStatus),
    })),
    is_online_meeting: !!meetUrl,
    online_meeting_url: meetUrl,
    conference_provider: e.conferenceData?.conferenceSolution?.name ?? null,
    show_as: e.transparency === "transparent" ? "free" : "busy",
    sensitivity: e.visibility ?? null,
    reminder_minutes_before:
      e.reminders?.useDefault === false
        ? e.reminders.overrides?.find((o) => o.method === "popup")?.minutes ?? null
        : null,
    response_status: (e.attendees ?? []).find((a) => a.self)?.responseStatus ?? null,
    body_preview: (e.description ?? "").slice(0, 200),
    web_link: e.htmlLink ?? null,
    series_master_id: e.recurringEventId ?? null,
    event_type: e.recurringEventId ? "occurrence" : e.recurrence ? "seriesMaster" : "singleInstance",
    recurrence: e.recurrence ?? null,
    ical_uid: e.iCalUID ?? null,
  };
}
