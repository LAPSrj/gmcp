import { describe, test, expect } from "bun:test";
import {
  compactEvent,
  snapshotEvent,
  diffEvent,
  attendeeResponse,
  type CalendarEvent,
} from "../src/google/calendar-event.ts";

const ev = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "evt1",
  status: "confirmed",
  summary: "Sync",
  start: { dateTime: "2026-06-01T15:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-06-01T16:00:00Z", timeZone: "UTC" },
  attendees: [
    { email: "alice@example.com", displayName: "Alice", responseStatus: "needsAction" },
    { email: "bob@example.com", displayName: "Bob", responseStatus: "accepted" },
  ],
  ...over,
});

describe("attendeeResponse", () => {
  test("maps Google statuses to outlook-parity vocabulary", () => {
    expect(attendeeResponse("accepted")).toBe("accepted");
    expect(attendeeResponse("declined")).toBe("declined");
    expect(attendeeResponse("tentative")).toBe("tentativelyAccepted");
    expect(attendeeResponse("needsAction")).toBe("notResponded");
    expect(attendeeResponse(undefined)).toBe("notResponded");
  });
});

describe("diffEvent", () => {
  test("first sighting (no prior baseline) returns null", () => {
    expect(diffEvent(undefined, ev())).toBeNull();
  });

  test("no change yields an empty change set", () => {
    const e = ev();
    const change = diffEvent(snapshotEvent(e), e);
    expect(change).not.toBeNull();
    expect(change!.attendee_changes).toEqual([]);
    expect(change!.rescheduled).toBe(false);
    expect(change!.cancelled).toBe(false);
    expect(change!.newly_cancelled).toBe(false);
  });

  test("detects an attendee RSVP change with from/to", () => {
    const before = snapshotEvent(ev());
    const after = ev({
      attendees: [
        { email: "alice@example.com", displayName: "Alice", responseStatus: "accepted" },
        { email: "bob@example.com", displayName: "Bob", responseStatus: "accepted" },
      ],
    });
    const change = diffEvent(before, after)!;
    expect(change.attendee_changes).toEqual([
      { email: "alice@example.com", name: "Alice", from: "notResponded", to: "accepted" },
    ]);
  });

  test("a newly added attendee has from:null", () => {
    const before = snapshotEvent(ev({ attendees: [] }));
    const change = diffEvent(before, ev({ attendees: [{ email: "carol@example.com", responseStatus: "tentative" }] }))!;
    expect(change.attendee_changes).toEqual([
      { email: "carol@example.com", name: null, from: null, to: "tentativelyAccepted" },
    ]);
  });

  test("email match is case-insensitive (no false change)", () => {
    const before = snapshotEvent(ev({ attendees: [{ email: "Alice@Example.com", responseStatus: "accepted" }] }));
    const change = diffEvent(before, ev({ attendees: [{ email: "alice@example.com", responseStatus: "accepted" }] }))!;
    expect(change.attendee_changes).toEqual([]);
  });

  test("detects a reschedule (start/end change)", () => {
    const before = snapshotEvent(ev());
    const change = diffEvent(before, ev({ start: { dateTime: "2026-06-01T17:00:00Z" }, end: { dateTime: "2026-06-01T18:00:00Z" } }))!;
    expect(change.rescheduled).toBe(true);
  });

  test("detects a fresh cancellation but not a still-cancelled echo", () => {
    const live = snapshotEvent(ev());
    const cancelled = ev({ status: "cancelled" });
    const first = diffEvent(live, cancelled)!;
    expect(first.cancelled).toBe(true);
    expect(first.newly_cancelled).toBe(true);

    const alreadyCancelled = snapshotEvent(cancelled);
    const echo = diffEvent(alreadyCancelled, cancelled)!;
    expect(echo.cancelled).toBe(true);
    expect(echo.newly_cancelled).toBe(false);
  });
});

describe("compactEvent", () => {
  test("projects attendees to the response vocabulary and core fields", () => {
    const c = compactEvent(ev()) as any;
    expect(c.id).toBe("evt1");
    expect(c.subject).toBe("Sync");
    expect(c.is_cancelled).toBe(false);
    expect(c.attendees).toEqual([
      { email: "alice@example.com", name: "Alice", type: "required", response: "notResponded" },
      { email: "bob@example.com", name: "Bob", type: "required", response: "accepted" },
    ]);
  });

  test("marks cancelled events", () => {
    const c = compactEvent(ev({ status: "cancelled" })) as any;
    expect(c.is_cancelled).toBe(true);
  });

  test("flags a recurring occurrence via recurringEventId", () => {
    const c = compactEvent(ev({ id: "master_20270304", recurringEventId: "master" })) as any;
    expect(c.event_type).toBe("occurrence");
    expect(c.series_master_id).toBe("master");
  });
});
