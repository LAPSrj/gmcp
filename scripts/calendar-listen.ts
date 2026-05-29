#!/usr/bin/env bun
// Google Calendar change listener. Long-polls events.list with an incremental
// syncToken and emits one JSON line per *changed* event to stdout — designed
// for Claude Code's Monitor tool. The use case is "notify only on change":
// RSVP/attendee responses, reschedules, and cancellations for an event or a
// whole calendar.
//
// Two watch modes:
//   - default: every changed event on the calendar (firehose)
//   - --event-id=<id>: only changes to that event (or, for a recurring series,
//     any of its expanded instances). Matched server-data-side after the sync,
//     which is cheap because the sync response already carries the full event.
//
// Why syncToken (not events.watch push channels): watch() needs a public HTTPS
// endpoint for Google to POST to — a local MCP server has no ingress — and the
// push ping carries no payload anyway (you still call events.list+syncToken to
// get the delta). So the long-poll+syncToken model is strictly simpler here,
// mirroring gmail-listen.ts's history-cursor approach.
//
// Cursor / dedupe:
//   events.list returns nextSyncToken on the last page of a full sync. Passing
//   it back on the next call returns only events changed since. No re-emit on
//   reconnect. If the token expires, Google returns 410 GONE; we re-run a full
//   sync to rebuild the token and log `reseeded: true` to stderr (changes in
//   the gap may be missed — symmetric with gmail-listen.ts's 404 reseed).
//
// Startup is quiet for the firehose (we seed the baseline without emitting).
// When --event-id is set we emit a one-time `baseline` line per matching event
// so the watcher immediately sees the current RSVP roster, then stream changes.
//
// Env (inherited from the MCP server via inline assignment in the Monitor
// command, because Monitor spawns children with a stripped env):
//   GMAIL_MCP_CREDENTIALS_FILE  (required) — OAuth client JSON path
//   GMAIL_MCP_PROFILE           (optional) — selects tokens-<profile>.json
//   GMAIL_MCP_TOKEN_PATH        (optional) — overrides token file location
//
// Stdout: NDJSON event stream. Stderr: diagnostics only.

import { googleRequest, GoogleError } from "../src/google/client.ts";
import {
  compactEvent,
  snapshotEvent,
  diffEvent,
  type CalendarEvent,
  type EventChangeBaseline,
} from "../src/google/calendar-event.ts";

interface EventsPage {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

// ---------- Args ----------

const args = parseArgs(process.argv.slice(2));
const EVENT_FILTER: string | null = args["event-id"] ?? null;
const CALENDAR_ID: string = args["calendar-id"] ?? "primary";
const POLL_SECONDS: number = clampInt(args["poll"], 5, 300, 30);
const MAX_RESULTS: number = clampInt(args["max-results"], 1, 2500, 250);
// timeMin bounds the *initial* full sync so we don't page through years of past
// events; the syncToken then honors that window. Default: now (only upcoming
// events matter for RSVP/reschedule/cancellation tracking).
const TIME_MIN: string | null = args["time-min"] ?? null;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) {
      out[a.slice(2)] = "true";
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
}

function clampInt(raw: string | undefined, min: number, max: number, dflt: number): number {
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// ---------- Emit ----------

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// ---------- Filter ----------

function matchesFilter(e: CalendarEvent): boolean {
  if (!EVENT_FILTER) return true;
  if (e.id === EVENT_FILTER) return true;
  // Expanded instance of a recurring series: recurringEventId points at the
  // master, and the instance id is "<masterId>_<timestamp>".
  if (e.recurringEventId === EVENT_FILTER) return true;
  if (e.id && e.id.startsWith(`${EVENT_FILTER}_`)) return true;
  return false;
}

// ---------- Baseline + diff ----------
// snapshotEvent / diffEvent live in the shared calendar-event module so they
// can be unit-tested independently of this long-running script.

const baseline = new Map<string, EventChangeBaseline>();

// ---------- Shutdown ----------

let shuttingDown = false;
process.on("SIGTERM", () => {
  shuttingDown = true;
  console.error("calendar-listen: SIGTERM received, exiting");
  process.exit(0);
});
process.on("SIGINT", () => {
  shuttingDown = true;
  console.error("calendar-listen: SIGINT received, exiting");
  process.exit(0);
});

// ---------- Sync ----------

const eventsPath = `/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

// Full sync: page to the end to obtain a fresh nextSyncToken, seeding the
// baseline as we go. Returns the syncToken. When `emitBaseline` is true and a
// filter is set, emits a `baseline` line per matching event.
async function fullSync(emitBaseline: boolean): Promise<string> {
  let pageToken: string | undefined;
  let syncToken: string | undefined;
  const timeMin = TIME_MIN ?? new Date().toISOString();
  while (true) {
    const page = await googleRequest<EventsPage>({
      api: "calendar",
      path: eventsPath,
      query: {
        singleEvents: true,
        showDeleted: true,
        maxResults: MAX_RESULTS,
        timeMin,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    for (const e of page.items ?? []) {
      if (!e.id) continue;
      baseline.set(e.id, snapshotEvent(e));
      if (emitBaseline && EVENT_FILTER && matchesFilter(e)) {
        emit({ kind: "baseline", event: compactEvent(e) });
      }
    }
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }
    syncToken = page.nextSyncToken;
    break;
  }
  if (!syncToken) {
    throw new Error("full sync completed without a nextSyncToken");
  }
  return syncToken;
}

async function main(): Promise<void> {
  console.error(
    `calendar-listen: starting on calendar=${CALENDAR_ID}` +
      (EVENT_FILTER ? `, filter event_id=${EVENT_FILTER}` : " (firehose)") +
      `, poll=${POLL_SECONDS}s`,
  );

  let syncToken = await fullSync(/* emitBaseline */ true);
  console.error(`calendar-listen: seeded baseline (${baseline.size} events), watching for changes`);

  let consecutiveErrors = 0;
  let pageToken: string | undefined;

  while (!shuttingDown) {
    let page: EventsPage;
    try {
      page = await googleRequest<EventsPage>({
        api: "calendar",
        path: eventsPath,
        query: {
          syncToken,
          maxResults: MAX_RESULTS,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      consecutiveErrors = 0;
    } catch (err) {
      if (err instanceof GoogleError && err.status === 410) {
        // syncToken expired — rebuild it with a full sync. Keep the existing
        // baseline (don't re-emit) so we only surface genuinely new changes;
        // changes during the gap may have been missed.
        console.error("calendar-listen: syncToken expired (410 GONE), re-syncing — gap may have been missed");
        syncToken = await fullSync(/* emitBaseline */ false);
        pageToken = undefined;
        emit({ kind: "reseeded", reason: "sync_token_expired" });
        await sleep(POLL_SECONDS * 1000);
        continue;
      }
      consecutiveErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`calendar-listen: events.list failed (attempt ${consecutiveErrors}): ${msg}`);
      if (consecutiveErrors >= 8) {
        console.error("calendar-listen: 8 consecutive errors, exiting");
        process.exit(1);
      }
      await sleep(Math.min(300_000, 1000 * 2 ** consecutiveErrors));
      continue;
    }

    for (const e of page.items ?? []) {
      if (!e.id) continue;
      if (!matchesFilter(e)) {
        // Still update the baseline so a later matching change diffs correctly.
        baseline.set(e.id, snapshotEvent(e));
        continue;
      }
      const changes = diffEvent(baseline.get(e.id), e);
      baseline.set(e.id, snapshotEvent(e));
      if (changes === null) {
        // First time seeing this event (e.g. a newly created event matching the
        // filter) — emit it as a baseline so the watcher has the full state.
        emit({ kind: "baseline", event: compactEvent(e) });
        continue;
      }
      // Skip no-op echoes (sync can return an event whose change was to a field
      // we don't track) unless it's a cancellation.
      const hasChange =
        changes.attendee_changes.length > 0 ||
        changes.rescheduled ||
        changes.newly_cancelled;
      if (!hasChange) continue;
      emit({
        kind: "change",
        event: compactEvent(e),
        attendee_changes: changes.attendee_changes,
        rescheduled: changes.rescheduled,
        cancelled: changes.cancelled,
        newly_cancelled: changes.newly_cancelled,
      });
    }

    // More pages in this sync round → keep paging immediately (no sleep).
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }
    if (page.nextSyncToken) syncToken = page.nextSyncToken;
    pageToken = undefined;
    await sleep(POLL_SECONDS * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`calendar-listen: fatal: ${msg}`);
  process.exit(1);
});
