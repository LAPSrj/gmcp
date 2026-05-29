import { describe, test, expect, beforeEach } from "bun:test";
import { notePoll, pollNudge, __resetPollDetector } from "../src/lib/poll-detector.ts";

beforeEach(() => __resetPollDetector());

describe("notePoll", () => {
  test("no nudge on the first two calls (need three)", () => {
    expect(notePoll("k", 0)).toBe(false);
    expect(notePoll("k", 10_000)).toBe(false);
  });

  test("nudges on the third regularly-spaced call", () => {
    expect(notePoll("k", 0)).toBe(false);
    expect(notePoll("k", 10_000)).toBe(false);
    expect(notePoll("k", 20_000)).toBe(true);
  });

  test("keeps nudging while the regular polling continues", () => {
    notePoll("k", 0);
    notePoll("k", 10_000);
    expect(notePoll("k", 20_000)).toBe(true);
    expect(notePoll("k", 30_000)).toBe(true);
    expect(notePoll("k", 40_000)).toBe(true);
  });

  test("tolerates approximately-equal intervals (within ±50%)", () => {
    notePoll("k", 0);
    notePoll("k", 10_000);
    expect(notePoll("k", 23_000)).toBe(true); // 13s vs 10s — within tolerance
  });

  test("no nudge when intervals are irregular", () => {
    notePoll("k", 0);
    notePoll("k", 10_000);
    expect(notePoll("k", 90_000)).toBe(false); // 80s vs 10s — too uneven
  });

  test("no nudge for sub-second bursts (e.g. pagination)", () => {
    expect(notePoll("k", 0)).toBe(false);
    expect(notePoll("k", 200)).toBe(false);
    expect(notePoll("k", 400)).toBe(false);
  });

  test("no nudge for very widely-spaced checks (slower than ~20min)", () => {
    notePoll("k", 0);
    notePoll("k", 25 * 60_000);
    expect(notePoll("k", 50 * 60_000)).toBe(false);
  });

  test("distinct keys are tracked independently", () => {
    notePoll("a", 0);
    notePoll("a", 10_000);
    notePoll("b", 5_000);
    // 'a' reaches three regular calls; 'b' has only two.
    expect(notePoll("a", 20_000)).toBe(true);
    expect(notePoll("b", 15_000)).toBe(false);
  });
});

describe("pollNudge", () => {
  test("returns the message only when the pattern is detected", () => {
    expect(pollNudge("k", 0, "use Monitor")).toBeUndefined();
    expect(pollNudge("k", 10_000, "use Monitor")).toBeUndefined();
    expect(pollNudge("k", 20_000, "use Monitor")).toBe("use Monitor");
  });
});
