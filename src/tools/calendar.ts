import { z } from "zod";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { googleRequest, googleList, GoogleError } from "../google/client.ts";
import { ok } from "./helpers.ts";
import { mergeIntervals, type Interval } from "../lib/intervals.ts";
import { parseHM, inWorkingHours } from "../lib/working-hours.ts";
import { pollNudge } from "../lib/poll-detector.ts";
import { buildRecurrenceLines, type Recurrence } from "../google/rrule.ts";
import {
  compactEvent,
  type EventDateTime,
  type CalendarAttendee,
  type CalendarEvent,
} from "../google/calendar-event.ts";

// ---------- Schemas ----------

const attendeeSchema = z
  .object({
    email: z.string().email(),
    name: z.string().optional(),
    type: z.enum(["required", "optional", "resource"]).default("required"),
  })
  .strict();

const dayOfWeek = z.enum([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

const recurrenceSchema = z
  .object({
    pattern: z
      .object({
        type: z.enum([
          "daily",
          "weekly",
          "absoluteMonthly",
          "relativeMonthly",
          "absoluteYearly",
          "relativeYearly",
        ]),
        interval: z.number().int().min(1).default(1),
        days_of_week: z.array(dayOfWeek).optional(),
        first_day_of_week: dayOfWeek.optional(),
        day_of_month: z.number().int().min(1).max(31).optional(),
        month: z.number().int().min(1).max(12).optional(),
        index: z.enum(["first", "second", "third", "fourth", "last"]).optional(),
      })
      .strict(),
    range: z
      .object({
        type: z.enum(["endDate", "noEnd", "numbered"]),
        start_date: z.string().describe("ISO date YYYY-MM-DD (no time component)"),
        end_date: z.string().optional(),
        number_of_occurrences: z.number().int().min(1).optional(),
        timezone: z.string().describe("IANA timezone for recurrence interpretation (e.g. America/Sao_Paulo). Windows TZ names are not accepted."),
      })
      .strict(),
  })
  .strict();

const onlineMeetingSchema = z
  .object({
    join_url: z.string().url(),
    conference_id: z.string().optional(),
    toll_number: z.string().optional(),
  })
  .strict();

// ---------- Types from the API (the bits we use) ----------

interface CalendarListEntry {
  id?: string;
  summary?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  timeZone?: string;
}

// ---------- Compact shapes ----------
// CalendarEvent / CalendarAttendee / EventDateTime types and compactEvent live
// in ../google/calendar-event.ts so the change-listener can share them.

function buildEventDateTime(
  s: string,
  timezone: string,
  isAllDay: boolean,
): EventDateTime {
  if (isAllDay) return { date: s };
  return { dateTime: ensureIsoOffsetIfMissing(s, timezone), timeZone: timezone };
}

// Google rejects bare "2026-05-14T14:00:00" with timeZone set but allows it
// with explicit timezone field. We pass both: dateTime in local time + timeZone field.
function ensureIsoOffsetIfMissing(s: string, _timezone: string): string {
  // Google accepts "YYYY-MM-DDTHH:MM:SS" together with a `timeZone` field, OR
  // a fully-qualified offset like "...T14:00:00-03:00". We pass the former so
  // recurrences interpret the wall-clock time correctly.
  return s;
}

function buildAttendees(
  attendees: { email: string; name?: string; type: string }[] | undefined,
): CalendarAttendee[] | undefined {
  if (!attendees || attendees.length === 0) return undefined;
  return attendees.map((a) => ({
    email: a.email,
    ...(a.name ? { displayName: a.name } : {}),
    ...(a.type === "optional" ? { optional: true } : {}),
    ...(a.type === "resource" ? { resource: true } : {}),
  }));
}

// ---------- Tools ----------

export function registerCalendarTools(server: McpServer): void {
  server.tool(
    "calendar_list_calendars",
    "List all calendars the signed-in user has access to.",
    {},
    async () => {
      const items = await googleList<CalendarListEntry>({
        api: "calendar",
        path: "/users/me/calendarList",
        extract: (p) => p.items,
        maxResults: 200,
      });
      return ok(
        items.map((c) => ({
          id: c.id,
          name: c.summary,
          color: c.backgroundColor,
          is_default: !!c.primary,
          can_edit: c.accessRole === "owner" || c.accessRole === "writer",
          owner: null,
          timezone: c.timeZone ?? null,
          access_role: c.accessRole ?? null,
        })),
      );
    },
  );

  server.tool(
    "calendar_list_events",
    "List events in a date/time range (recurrences expanded). Dates must be ISO 8601.",
    {
      start: z.string().describe("Range start (ISO 8601, e.g. 2026-05-12T00:00:00Z or 2026-05-12T00:00:00-03:00)"),
      end: z.string().describe("Range end (ISO 8601)"),
      calendar_id: z.string().optional().describe("Calendar id. Default: primary."),
      timezone: z.string().optional().describe("IANA timezone for response (e.g. America/Sao_Paulo). Default: UTC."),
      top: z.number().int().min(1).max(2500).default(50),
    },
    async ({ start, end, calendar_id, timezone, top }) => {
      const calId = calendar_id ?? "primary";
      const items = await googleList<CalendarEvent>({
        api: "calendar",
        path: `/calendars/${encodeURIComponent(calId)}/events`,
        query: {
          timeMin: start,
          timeMax: end,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: Math.min(top, 2500),
          ...(timezone ? { timeZone: timezone } : {}),
        },
        extract: (p) => p.items,
        maxResults: top,
        pageSize: Math.min(top, 2500),
        pageSizeParam: "maxResults",
      });
      const notice = pollNudge(
        `calendar_list_events:${calId}:${start}:${end}`,
        Date.now(),
        `It looks like you're re-running this same date-range query on a timer to watch for changes. For change-only notifications (RSVP responses, reschedules, cancellations) call calendar_listen_instructions${calendar_id ? ` with calendar_id="${calId}"` : ""} and pass the returned command to Monitor — it emits only when events change, instead of you polling.`,
      );
      return ok(items.map(compactEvent), notice);
    },
  );

  server.tool(
    "calendar_get_event",
    "Get a single event by id.",
    {
      id: z.string(),
      calendar_id: z.string().optional().describe("Calendar id. Default: primary."),
      timezone: z.string().optional(),
    },
    async ({ id, calendar_id, timezone }) => {
      const calId = calendar_id ?? "primary";
      const e = await googleRequest<CalendarEvent>({
        api: "calendar",
        path: `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`,
        query: timezone ? { timeZone: timezone } : undefined,
      });
      const notice = pollNudge(
        `calendar_get_event:${calId}:${id}`,
        Date.now(),
        `It looks like you're re-fetching this event on a timer to watch for changes. For change-only notifications (RSVP responses, reschedules, cancellations) call calendar_listen_instructions with event_id="${id}"${calendar_id ? `, calendar_id="${calId}"` : ""} and pass the returned command to Monitor — it long-polls server-side and emits only when the event actually changes, instead of you polling.`,
      );
      return ok(
        {
          ...compactEvent(e),
          body: { format: "text", content: e.description ?? "" },
        },
        notice,
      );
    },
  );

  server.tool(
    "calendar_list_event_instances",
    "Expand a recurring event series into its individual occurrences within a date range. Each occurrence has its own id (shape: '<seriesId>_<YYYYMMDDTHHMMSSZ>') which can be passed to calendar_update_event/calendar_delete_event to modify or skip that occurrence.",
    {
      series_master_id: z.string(),
      start: z.string(),
      end: z.string(),
      calendar_id: z.string().optional(),
      timezone: z.string().optional(),
      top: z.number().int().min(1).max(2500).default(100),
    },
    async ({ series_master_id, start, end, calendar_id, timezone, top }) => {
      const calId = calendar_id ?? "primary";
      const items = await googleList<CalendarEvent>({
        api: "calendar",
        path: `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(series_master_id)}/instances`,
        query: {
          timeMin: start,
          timeMax: end,
          maxResults: Math.min(top, 2500),
          ...(timezone ? { timeZone: timezone } : {}),
        },
        extract: (p) => p.items,
        maxResults: top,
        pageSize: Math.min(top, 2500),
        pageSizeParam: "maxResults",
      });
      return ok(items.map(compactEvent));
    },
  );

  server.tool(
    "calendar_find_free_slots",
    "Find open time slots by computing gaps between busy events. Uses freebusy.query (multi-calendar in a single API call). working_hours_only + working_hours_start/_end work the same as outlook-mcp's tool.",
    {
      start: z.string().describe("Search window start (ISO 8601)"),
      end: z.string().describe("Search window end (ISO 8601)"),
      duration_minutes: z.number().int().min(5).max(1440).default(30),
      calendar_ids: z.array(z.string()).optional().describe("Calendars to consider as busy. Default: primary."),
      working_hours_only: z.boolean().default(true),
      working_hours_start: z.string().default("09:00").describe("Local working day start HH:MM"),
      working_hours_end: z.string().default("17:00").describe("Local working day end HH:MM"),
      timezone: z.string().optional().describe("IANA timezone for working-hours interpretation (e.g. America/Sao_Paulo). Default: UTC."),
      max_slots: z.number().int().min(1).max(50).default(10),
    },
    async (args) => {
      const calIds = args.calendar_ids ?? ["primary"];
      const fb = await googleRequest<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }> }>({
        api: "calendar",
        path: "/freeBusy",
        method: "POST",
        body: {
          timeMin: args.start,
          timeMax: args.end,
          items: calIds.map((id) => ({ id })),
          ...(args.timezone ? { timeZone: args.timezone } : {}),
        },
      });
      const allBusy: Interval[] = [];
      for (const cid of calIds) {
        const cal = fb.calendars?.[cid];
        for (const b of cal?.busy ?? []) {
          const s = Date.parse(b.start);
          const e = Date.parse(b.end);
          if (Number.isFinite(s) && Number.isFinite(e)) allBusy.push({ start: s, end: e });
        }
      }
      const busy = mergeIntervals(allBusy);
      const windowStart = Date.parse(args.start);
      const windowEnd = Date.parse(args.end);
      const durationMs = args.duration_minutes * 60_000;
      const slots: { start: string; end: string }[] = [];

      let cursor = windowStart;
      const candidates: Interval[] = [];
      for (const b of busy) {
        if (b.end <= cursor) continue;
        if (b.start >= windowEnd) break;
        if (b.start > cursor) candidates.push({ start: cursor, end: b.start });
        cursor = Math.max(cursor, b.end);
      }
      if (cursor < windowEnd) candidates.push({ start: cursor, end: windowEnd });

      const tz = args.timezone;
      const [whStartH, whStartM] = parseHM(args.working_hours_start);
      const [whEndH, whEndM] = parseHM(args.working_hours_end);

      for (const gap of candidates) {
        let t = gap.start;
        while (t + durationMs <= gap.end) {
          const slotStart = new Date(t);
          const slotEnd = new Date(t + durationMs);
          if (
            !args.working_hours_only ||
            inWorkingHours(slotStart, slotEnd, whStartH, whStartM, whEndH, whEndM, tz)
          ) {
            slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
            if (slots.length >= args.max_slots) break;
          }
          t += 15 * 60_000;
        }
        if (slots.length >= args.max_slots) break;
      }
      return ok({ slots, duration_minutes: args.duration_minutes });
    },
  );

  // ----- WRITE -----

  server.tool(
    "calendar_create_event",
    "Create a calendar event. Setting is_online_meeting=true auto-provisions a Google Meet link (via conferenceData.createRequest). Passing online_meeting with a third-party join URL embeds it in location/body and returns a warnings entry — Google's conferenceData field does not accept third-party URLs.",
    {
      subject: z.string(),
      start: z.string().describe("Start date/time. Local clock time, no offset — pair with `timezone`. Example: 2026-05-14T14:00:00"),
      end: z.string().describe("End date/time, same format as start."),
      timezone: z.string().default("UTC").describe("IANA timezone (e.g. America/Sao_Paulo). Windows TZ names are not accepted."),
      body: z.string().optional(),
      body_format: z.enum(["text", "html"]).default("text"),
      location: z
        .string()
        .optional()
        .describe(
          "Free-form text only — Google Calendar has no structured address or coordinates field (unlike outlook-mcp). For a real venue, pass ONE well-formed string with the place name + full street address so clients can geocode a map pin, e.g. \"Victory Barber & Brand Gastown, 77 East Cordova St, Vancouver, BC V6A 1K3, Canada\". If you have lat/long, there is nowhere to put it in Google Calendar — fold it into the address text or omit it.",
        ),
      attendees: z.array(attendeeSchema).optional(),
      is_online_meeting: z.boolean().default(false),
      online_meeting_provider: z
        .enum(["hangoutsMeet", "unknown"])
        .default("hangoutsMeet")
        .describe("Only 'hangoutsMeet' is auto-provisioned by Google. 'unknown' is a no-op kept for outlook parity."),
      online_meeting: onlineMeetingSchema
        .optional()
        .describe(
          "⚠️ Third-party (Zoom/Webex/etc.) join URLs cannot be attached via conferenceData on Google Calendar. The URL is embedded in location/body and a warnings entry is returned. For Meet, set is_online_meeting=true and omit this — Google auto-provisions a Meet link.",
        ),
      is_all_day: z.boolean().default(false),
      reminder_minutes_before: z.number().int().min(0).max(40320).optional(),
      show_as: z
        .enum(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"])
        .optional()
        .describe("Mapped to Google transparency: free→transparent, all others→opaque."),
      sensitivity: z.enum(["normal", "personal", "private", "confidential"]).optional(),
      calendar_id: z.string().optional(),
      send_invitations: z.boolean().default(true),
      recurrence: recurrenceSchema.optional(),
    },
    async (args) => {
      const payload: Record<string, unknown> = {
        summary: args.subject,
        start: buildEventDateTime(args.start, args.timezone, args.is_all_day),
        end: buildEventDateTime(args.end, args.timezone, args.is_all_day),
      };
      if (args.body) payload.description = args.body_format === "html" ? args.body : args.body;
      if (args.location) payload.location = args.location;
      const attendees = buildAttendees(args.attendees);
      if (attendees) payload.attendees = attendees;
      if (args.show_as) {
        payload.transparency = args.show_as === "free" ? "transparent" : "opaque";
      }
      if (args.sensitivity) {
        const map: Record<string, string> = {
          normal: "default",
          personal: "private",
          private: "private",
          confidential: "confidential",
        };
        payload.visibility = map[args.sensitivity] ?? "default";
      }
      if (args.reminder_minutes_before !== undefined) {
        payload.reminders = {
          useDefault: false,
          overrides: [{ method: "popup", minutes: args.reminder_minutes_before }],
        };
      }
      if (args.recurrence) {
        payload.recurrence = buildRecurrenceLines(args.recurrence as Recurrence);
      }

      let useMeet = false;
      const warnings: unknown[] = [];
      if (args.online_meeting?.join_url) {
        // Third-party URL — embed in location/body, warn.
        const url = args.online_meeting.join_url;
        if (!payload.location) payload.location = url;
        const existing = (payload.description as string | undefined) ?? "";
        payload.description = existing ? `${url}\n\n${existing}` : url;
        warnings.push({
          kind: "third_party_meeting_in_body",
          message:
            "Google Calendar's conferenceData field does not accept third-party join URLs (only hangoutsMeet is auto-provisioned). The URL was placed in `location` and prepended to the event body instead. To get a Google Meet link, set is_online_meeting=true and omit online_meeting.",
          requested_join_url: url,
        });
      } else if (args.is_online_meeting && args.online_meeting_provider === "hangoutsMeet") {
        useMeet = true;
        payload.conferenceData = {
          createRequest: {
            requestId: `gmail-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        };
      }

      const calId = args.calendar_id ?? "primary";
      const sendUpdates = args.send_invitations ? "all" : "none";
      const created = await googleRequest<CalendarEvent>({
        api: "calendar",
        path: `/calendars/${encodeURIComponent(calId)}/events`,
        method: "POST",
        body: payload,
        query: {
          sendUpdates,
          ...(useMeet ? { conferenceDataVersion: 1 } : {}),
        },
      });

      return ok({
        id: created.id,
        web_link: created.htmlLink ?? null,
        online_meeting_url:
          created.hangoutLink ??
          created.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === "video")?.uri ??
          null,
        warnings,
      });
    },
  );

  server.tool(
    "calendar_update_event",
    "Update fields on an existing event. Pass only the fields you want to change. Note: `recurrence` replaces the rule on the series master — Google does not merge.",
    {
      id: z.string(),
      calendar_id: z.string().optional(),
      subject: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      timezone: z.string().optional(),
      body: z.string().optional(),
      body_format: z.enum(["text", "html"]).default("text"),
      location: z
        .string()
        .optional()
        .describe(
          "Free-form text only — Google Calendar has no structured address or coordinates field (unlike outlook-mcp). For a real venue, pass ONE well-formed string with the place name + full street address so clients can geocode a map pin, e.g. \"Victory Barber & Brand Gastown, 77 East Cordova St, Vancouver, BC V6A 1K3, Canada\". If you have lat/long, there is nowhere to put it in Google Calendar — fold it into the address text or omit it.",
        ),
      attendees: z.array(attendeeSchema).optional(),
      reminder_minutes_before: z.number().int().min(0).max(40320).optional(),
      show_as: z
        .enum(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"])
        .optional(),
      online_meeting: onlineMeetingSchema
        .optional()
        .describe("Third-party URLs go to location/body (see calendar_create_event)."),
      recurrence: recurrenceSchema.optional(),
      send_updates: z.enum(["all", "externalOnly", "none"]).default("all"),
    },
    async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.subject !== undefined) payload.summary = args.subject;
      if (args.start) {
        payload.start = { dateTime: args.start, timeZone: args.timezone ?? "UTC" };
      }
      if (args.end) payload.end = { dateTime: args.end, timeZone: args.timezone ?? "UTC" };
      if (args.body !== undefined) payload.description = args.body;
      if (args.location !== undefined) payload.location = args.location;
      const attendees = buildAttendees(args.attendees);
      if (attendees !== undefined) payload.attendees = attendees;
      if (args.show_as) payload.transparency = args.show_as === "free" ? "transparent" : "opaque";
      if (args.reminder_minutes_before !== undefined) {
        payload.reminders = {
          useDefault: false,
          overrides: [{ method: "popup", minutes: args.reminder_minutes_before }],
        };
      }
      const warnings: unknown[] = [];
      if (args.online_meeting?.join_url) {
        const url = args.online_meeting.join_url;
        if (payload.location === undefined) payload.location = url;
        warnings.push({
          kind: "third_party_meeting_in_body",
          message:
            "Google Calendar does not accept third-party meeting URLs in conferenceData. The URL was placed in `location`. To use Google Meet, see calendar_create_event.",
          requested_join_url: url,
        });
      }
      if (args.recurrence) {
        payload.recurrence = buildRecurrenceLines(args.recurrence as Recurrence);
      }
      const calId = args.calendar_id ?? "primary";
      await googleRequest({
        api: "calendar",
        path: `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(args.id)}`,
        method: "PATCH",
        body: payload,
        query: { sendUpdates: args.send_updates },
      });
      return ok({ updated: true, warnings });
    },
  );

  server.tool(
    "calendar_delete_event",
    "Delete or cancel an event. cancel_with_notification=true sends cancellation emails to attendees (Google equivalent: sendUpdates=all).",
    {
      id: z.string(),
      calendar_id: z.string().optional(),
      cancel_with_notification: z.boolean().default(true),
    },
    async ({ id, calendar_id, cancel_with_notification }) => {
      const calId = calendar_id ?? "primary";
      await googleRequest({
        api: "calendar",
        path: `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`,
        method: "DELETE",
        query: { sendUpdates: cancel_with_notification ? "all" : "none" },
        expectNoContent: true,
      });
      return ok({ deleted: true });
    },
  );

  server.tool(
    "calendar_respond",
    "Accept, tentatively accept, or decline a meeting invite. Google has no `propose_new_time` semantic — pass that arg only if you want a clear error explaining the limitation.",
    {
      id: z.string(),
      calendar_id: z.string().optional(),
      response: z.enum(["accept", "tentative", "decline"]),
      comment: z.string().optional(),
      send_response: z.boolean().default(true),
      propose_new_time: z
        .object({
          start: z.string(),
          end: z.string(),
          timezone: z.string().default("UTC"),
        })
        .optional(),
    },
    async ({ id, calendar_id, response, comment, send_response, propose_new_time }) => {
      if (propose_new_time) {
        throw new Error(
          "propose_new_time is not supported by Google Calendar's API. Workaround: respond with 'tentative' or 'decline' and email the organizer separately with your proposed time.",
        );
      }
      const calId = calendar_id ?? "primary";
      // Look up the event to find our own attendee row, then patch it.
      const event = await googleRequest<CalendarEvent>({
        api: "calendar",
        path: `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`,
      });
      const attendees = event.attendees ?? [];
      const me = attendees.find((a) => a.self);
      if (!me) {
        throw new Error("Cannot respond — the signed-in user is not in the event's attendee list.");
      }
      const status =
        response === "accept"
          ? "accepted"
          : response === "tentative"
            ? "tentative"
            : "declined";
      const updatedAttendees = attendees.map((a) =>
        a.self
          ? { ...a, responseStatus: status, ...(comment ? { comment } : {}) }
          : a,
      );
      await googleRequest({
        api: "calendar",
        path: `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`,
        method: "PATCH",
        body: { attendees: updatedAttendees },
        query: { sendUpdates: send_response ? "all" : "none" },
      });
      return ok({ responded: response });
    },
  );

  // ----- LISTEN (long-poll) -----

  server.tool(
    "calendar_listen",
    "Wait for calendar events to change (long-poll). Uses Google Calendar's incremental sync (events.list + syncToken) for delta-accurate detection of RSVP/attendee responses, reschedules, and cancellations. Blocks up to `timeout_seconds`; returns as soon as one or more events change, or on timeout. Pass `sync_token` from the previous response to resume seamlessly. With no `sync_token` the call seeds from 'now' and returns immediately (changes:[], seeded:true) so you can start watching future changes. Each returned event is the full current state (same shape as calendar_get_event) — for computed per-attendee deltas ('Alice: notResponded→accepted'), use the persistent Monitor listener via calendar_listen_instructions instead. If your token expires, Google returns 410 and we re-seed (reseeded:true; changes in the gap may be missed).",
    {
      sync_token: z
        .string()
        .optional()
        .describe(
          "next_sync_token from a previous call. If omitted, the call seeds from 'now' and returns immediately with an empty change set plus a token to resume from.",
        ),
      event_id: z
        .string()
        .optional()
        .describe(
          "Restrict to changes for this event id (or, for a recurring series, any of its expanded instances). Matched after the sync — the rest of the calendar's changes are dropped before returning.",
        ),
      calendar_id: z.string().optional().describe("Calendar id. Default: primary."),
      time_min: z
        .string()
        .optional()
        .describe(
          "ISO 8601 lower bound for the initial seed's full sync (ignored once sync_token is supplied). Default: now. Bounds how far back the first sync reaches.",
        ),
      timeout_seconds: z.number().int().min(5).max(300).default(60),
      poll_interval_seconds: z.number().int().min(5).max(300).default(30),
      max_results: z.number().int().min(1).max(2500).default(250),
    },
    async ({ sync_token, event_id, calendar_id, time_min, timeout_seconds, poll_interval_seconds, max_results }) => {
      const calId = calendar_id ?? "primary";
      const path = `/calendars/${encodeURIComponent(calId)}/events`;

      const matches = (e: CalendarEvent): boolean => {
        if (!event_id) return true;
        if (e.id === event_id) return true;
        if (e.recurringEventId === event_id) return true;
        if (e.id && e.id.startsWith(`${event_id}_`)) return true;
        return false;
      };

      // Run a full sync to obtain a fresh syncToken (pages to the last page).
      const fullSync = async (): Promise<string> => {
        let pageToken: string | undefined;
        const timeMin = time_min ?? new Date().toISOString();
        while (true) {
          const page = await googleRequest<{ items?: CalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>({
            api: "calendar",
            path,
            query: {
              singleEvents: true,
              showDeleted: true,
              maxResults: max_results,
              timeMin,
              ...(pageToken ? { pageToken } : {}),
            },
          });
          if (page.nextPageToken) {
            pageToken = page.nextPageToken;
            continue;
          }
          if (!page.nextSyncToken) throw new Error("full sync completed without a nextSyncToken");
          return page.nextSyncToken;
        }
      };

      // No token yet → seed and return immediately.
      if (!sync_token) {
        const token = await fullSync();
        return ok({ changes: [], next_sync_token: token, timed_out: false, seeded: true, reseeded: false });
      }

      let cursor = sync_token;
      let reseeded = false;
      const deadline = Date.now() + timeout_seconds * 1000;

      while (true) {
        const changed: CalendarEvent[] = [];
        let pageToken: string | undefined;
        try {
          // Drain all pages for this sync round.
          while (true) {
            const page = await googleRequest<{ items?: CalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>({
              api: "calendar",
              path,
              query: { syncToken: cursor, maxResults: max_results, ...(pageToken ? { pageToken } : {}) },
            });
            for (const e of page.items ?? []) {
              if (matches(e)) changed.push(e);
            }
            if (page.nextPageToken) {
              pageToken = page.nextPageToken;
              continue;
            }
            if (page.nextSyncToken) cursor = page.nextSyncToken;
            break;
          }
        } catch (e) {
          if (e instanceof GoogleError && e.status === 410) {
            cursor = await fullSync();
            reseeded = true;
            return ok({ changes: [], next_sync_token: cursor, timed_out: false, seeded: false, reseeded: true });
          }
          throw e;
        }

        if (changed.length > 0) {
          return ok({
            changes: changed.map(compactEvent),
            next_sync_token: cursor,
            timed_out: false,
            seeded: false,
            reseeded,
          });
        }
        if (Date.now() >= deadline) {
          return ok({ changes: [], next_sync_token: cursor, timed_out: true, seeded: false, reseeded });
        }
        await new Promise((r) => setTimeout(r, poll_interval_seconds * 1000));
      }
    },
  );

  // ----- LISTEN INSTRUCTIONS (Monitor handoff) -----

  server.tool(
    "calendar_listen_instructions",
    "Returns the exact Monitor() invocation needed to start a persistent calendar change-listener (long-poll over Google Calendar's incremental sync API). The listener path is resolved from this server's own install location, so the caller does not need to know where the package lives. Pass the returned `monitor` object directly to Claude Code's Monitor tool. Each stdout line is one JSON event: a `change` (with computed `attendee_changes`, `rescheduled`, `cancelled` flags + the full event) or a one-time `baseline` per matching event at startup. Pass `event_id` to watch one event's RSVP/reschedule/cancellation activity — that's the 'notify me only when this meeting changes' pattern. Omit it for a full-calendar firehose. This is the calendar analogue of mail_listen_instructions.",
    {
      event_id: z
        .string()
        .optional()
        .describe(
          "Optional event id. When set, the listener only emits changes to that event (or any expanded instance of a recurring series) and emits a one-time baseline of its current state at startup. Omit for a firehose of all calendar changes (startup is silent in that mode).",
        ),
      calendar_id: z.string().optional().describe("Calendar id to watch. Default: primary."),
      poll_interval_seconds: z
        .number()
        .int()
        .min(5)
        .max(300)
        .optional()
        .describe("How often the listener calls events.list with the syncToken. Default 30."),
      time_min: z
        .string()
        .optional()
        .describe(
          "ISO 8601 lower bound for the initial full sync. Default: now. Bounds how far back the listener's first sync reaches.",
        ),
    },
    async ({ event_id, calendar_id, poll_interval_seconds, time_min }) => {
      // src/tools/calendar.ts → ../../scripts/calendar-listen.ts
      const here = dirname(fileURLToPath(import.meta.url));
      const listenerPath = resolve(here, "..", "..", "scripts", "calendar-listen.ts");
      const listenerExists = existsSync(listenerPath);

      // Monitor strips env from spawned children; bake the gmail-mcp config env
      // vars inline so the listener reaches the same OAuth client + token cache
      // as the server. Tokens stay on disk (~/.config/gmail-mcp/), only path
      // hints land on the command line.
      const envParts: string[] = [];
      const credsFile = process.env.GMAIL_MCP_CREDENTIALS_FILE;
      const profile = process.env.GMAIL_MCP_PROFILE;
      const tokenPath = process.env.GMAIL_MCP_TOKEN_PATH;
      if (credsFile) envParts.push(`GMAIL_MCP_CREDENTIALS_FILE=${shellQuote(credsFile)}`);
      if (profile) envParts.push(`GMAIL_MCP_PROFILE=${shellQuote(profile)}`);
      if (tokenPath) envParts.push(`GMAIL_MCP_TOKEN_PATH=${shellQuote(tokenPath)}`);

      const flags: string[] = [];
      if (event_id) flags.push(`--event-id=${shellQuote(event_id)}`);
      if (calendar_id) flags.push(`--calendar-id=${shellQuote(calendar_id)}`);
      if (poll_interval_seconds) flags.push(`--poll=${poll_interval_seconds}`);
      if (time_min) flags.push(`--time-min=${shellQuote(time_min)}`);

      const command = [...envParts, "bun", shellQuote(listenerPath), ...flags].join(" ");

      return ok({
        monitor: {
          command,
          description: event_id ? `Calendar event ${event_id}` : "Calendar changes",
          persistent: true,
          timeout_ms: 3600000,
        },
        listener_path: listenerPath,
        listener_exists: listenerExists,
        calendar_id: calendar_id ?? "primary",
        profile: profile ?? null,
        notes: [
          "Each stdout line is one JSON event. `kind:\"change\"` carries the full event (same shape as calendar_get_event) plus `attendee_changes` (computed per-attendee response deltas: {email, name, from, to}), `rescheduled`, `cancelled`, and `newly_cancelled` flags. `kind:\"baseline\"` is emitted once per matching event at startup (only when event_id is set) so you immediately see the current RSVP roster.",
          "Stderr is diagnostics — the startup banner, baseline seed count, reseed events, transient errors.",
          "Cursor is delta-accurate via Google's incremental sync (events.list syncToken). On reconnect no changes are re-emitted. If the syncToken expires Google returns 410; the listener re-syncs and emits a `kind:\"reseeded\"` line — changes in the gap may have been missed.",
          event_id
            ? `Filtering to event_id=${event_id} (and any expanded instances of it). Other calendar changes are dropped.`
            : "Firehose mode (no event filter). Startup is silent — only changes after startup are emitted. To watch one event instead, call this tool again with `event_id` set.",
          "The attendee-delta computation is in-memory in the listener process. After a restart the first change to each event re-emits as a baseline (no prior state to diff against) — symmetric with the gmail listener's reseed honesty.",
          "Env vars (GMAIL_MCP_CREDENTIALS_FILE / GMAIL_MCP_PROFILE / GMAIL_MCP_TOKEN_PATH) are baked into the command line because Monitor spawns children with a stripped env. Tokens themselves stay on disk in ~/.config/gmail-mcp/, not on the command line.",
        ],
      });
    },
  );
}

function shellQuote(s: string): string {
  // Single-quote everything; escape any embedded single quote by closing,
  // inserting an escaped quote, and reopening. Safe for arbitrary paths.
  return `'${s.replace(/'/g, "'\\''")}'`;
}
