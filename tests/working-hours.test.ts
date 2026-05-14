import { describe, test, expect } from "bun:test";
import { inWorkingHours, parseHM } from "../src/lib/working-hours.ts";

const d = (iso: string): Date => new Date(iso);

describe("parseHM", () => {
  test("standard HH:MM", () => {
    expect(parseHM("09:30")).toEqual([9, 30]);
  });
  test("midnight", () => {
    expect(parseHM("00:00")).toEqual([0, 0]);
  });
  test("late evening", () => {
    expect(parseHM("23:45")).toEqual([23, 45]);
  });
});

describe("inWorkingHours (UTC)", () => {
  // 2026-05-13 is a Wednesday.
  test("slot mid working day allowed", () => {
    expect(
      inWorkingHours(d("2026-05-13T10:00:00Z"), d("2026-05-13T10:30:00Z"), 9, 0, 17, 0, "UTC"),
    ).toBe(true);
  });

  test("slot before working start rejected", () => {
    expect(
      inWorkingHours(d("2026-05-13T08:00:00Z"), d("2026-05-13T08:30:00Z"), 9, 0, 17, 0, "UTC"),
    ).toBe(false);
  });

  test("slot starting at exactly 09:00 allowed", () => {
    expect(
      inWorkingHours(d("2026-05-13T09:00:00Z"), d("2026-05-13T09:30:00Z"), 9, 0, 17, 0, "UTC"),
    ).toBe(true);
  });

  test("slot ending exactly at working_hours_end allowed", () => {
    expect(
      inWorkingHours(d("2026-05-13T16:30:00Z"), d("2026-05-13T17:00:00Z"), 9, 0, 17, 0, "UTC"),
    ).toBe(true);
  });

  test("slot ending after working_hours_end rejected", () => {
    expect(
      inWorkingHours(d("2026-05-13T16:45:00Z"), d("2026-05-13T17:15:00Z"), 9, 0, 17, 0, "UTC"),
    ).toBe(false);
  });

  test("Saturday slot rejected", () => {
    expect(
      inWorkingHours(d("2026-05-09T10:00:00Z"), d("2026-05-09T10:30:00Z"), 9, 0, 17, 0, "UTC"),
    ).toBe(false);
  });

  test("Sunday slot rejected", () => {
    expect(
      inWorkingHours(d("2026-05-10T10:00:00Z"), d("2026-05-10T10:30:00Z"), 9, 0, 17, 0, "UTC"),
    ).toBe(false);
  });

  test("slot crossing midnight rejected", () => {
    expect(
      inWorkingHours(d("2026-05-13T23:30:00Z"), d("2026-05-14T00:30:00Z"), 0, 0, 23, 59, "UTC"),
    ).toBe(false);
  });
});

describe("inWorkingHours (America/Sao_Paulo, UTC-3)", () => {
  test("13:00 UTC = 10:00 BRT = within 09-17 working hours", () => {
    expect(
      inWorkingHours(
        d("2026-05-13T13:00:00Z"),
        d("2026-05-13T13:30:00Z"),
        9,
        0,
        17,
        0,
        "America/Sao_Paulo",
      ),
    ).toBe(true);
  });

  test("23:00 UTC = 20:00 BRT (same day) = outside working hours", () => {
    expect(
      inWorkingHours(
        d("2026-05-13T23:00:00Z"),
        d("2026-05-13T23:30:00Z"),
        9,
        0,
        17,
        0,
        "America/Sao_Paulo",
      ),
    ).toBe(false);
  });
});
