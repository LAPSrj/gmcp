import { describe, test, expect } from "bun:test";
import { buildRecurrenceLines } from "../src/google/rrule.ts";

describe("buildRecurrenceLines — daily/weekly/monthly/yearly", () => {
  test("daily no-end", () => {
    expect(
      buildRecurrenceLines({
        pattern: { type: "daily", interval: 1 },
        range: { type: "noEnd", start_date: "2026-05-13", timezone: "UTC" },
      }),
    ).toEqual(["RRULE:FREQ=DAILY"]);
  });

  test("daily interval=3 with COUNT", () => {
    expect(
      buildRecurrenceLines({
        pattern: { type: "daily", interval: 3 },
        range: {
          type: "numbered",
          start_date: "2026-05-13",
          number_of_occurrences: 10,
          timezone: "UTC",
        },
      }),
    ).toEqual(["RRULE:FREQ=DAILY;INTERVAL=3;COUNT=10"]);
  });

  test("weekly MWF with WKST and UNTIL (UTC)", () => {
    const r = buildRecurrenceLines({
      pattern: {
        type: "weekly",
        interval: 1,
        days_of_week: ["monday", "wednesday", "friday"],
        first_day_of_week: "sunday",
      },
      range: {
        type: "endDate",
        start_date: "2026-05-13",
        end_date: "2026-12-31",
        timezone: "UTC",
      },
    });
    expect(r[0]).toMatch(/^RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;WKST=SU;UNTIL=20261231T235959Z$/);
  });

  test("absoluteMonthly day 15", () => {
    expect(
      buildRecurrenceLines({
        pattern: { type: "absoluteMonthly", interval: 1, day_of_month: 15 },
        range: { type: "noEnd", start_date: "2026-05-15", timezone: "UTC" },
      }),
    ).toEqual(["RRULE:FREQ=MONTHLY;BYMONTHDAY=15"]);
  });

  test("relativeMonthly: 2nd Tuesday of the month", () => {
    expect(
      buildRecurrenceLines({
        pattern: {
          type: "relativeMonthly",
          interval: 1,
          days_of_week: ["tuesday"],
          index: "second",
        },
        range: { type: "noEnd", start_date: "2026-05-12", timezone: "UTC" },
      }),
    ).toEqual(["RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2"]);
  });

  test("absoluteYearly: March 14", () => {
    expect(
      buildRecurrenceLines({
        pattern: { type: "absoluteYearly", interval: 1, month: 3, day_of_month: 14 },
        range: { type: "noEnd", start_date: "2026-03-14", timezone: "UTC" },
      }),
    ).toEqual(["RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14"]);
  });

  test("relativeYearly: last Friday of November", () => {
    expect(
      buildRecurrenceLines({
        pattern: {
          type: "relativeYearly",
          interval: 1,
          month: 11,
          days_of_week: ["friday"],
          index: "last",
        },
        range: { type: "noEnd", start_date: "2026-11-27", timezone: "UTC" },
      }),
    ).toEqual(["RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=FR;BYSETPOS=-1"]);
  });

  test("validation: absoluteMonthly without day_of_month throws", () => {
    expect(() =>
      buildRecurrenceLines({
        pattern: { type: "absoluteMonthly", interval: 1 },
        range: { type: "noEnd", start_date: "2026-05-13", timezone: "UTC" },
      }),
    ).toThrow(/day_of_month/);
  });

  test("validation: endDate without end_date throws", () => {
    expect(() =>
      buildRecurrenceLines({
        pattern: { type: "daily", interval: 1 },
        range: { type: "endDate", start_date: "2026-05-13", timezone: "UTC" },
      }),
    ).toThrow(/end_date/);
  });

  test("validation: numbered without number_of_occurrences throws", () => {
    expect(() =>
      buildRecurrenceLines({
        pattern: { type: "daily", interval: 1 },
        range: { type: "numbered", start_date: "2026-05-13", timezone: "UTC" },
      }),
    ).toThrow(/number_of_occurrences/);
  });

  test("UNTIL in non-UTC timezone converts end-of-day to UTC instant", () => {
    // End-of-day 2026-12-31 in America/Sao_Paulo (UTC-3) = 2027-01-01 02:59:59 UTC
    const r = buildRecurrenceLines({
      pattern: { type: "daily", interval: 1 },
      range: {
        type: "endDate",
        start_date: "2026-05-13",
        end_date: "2026-12-31",
        timezone: "America/Sao_Paulo",
      },
    });
    expect(r[0]).toMatch(/UNTIL=20270101T025959Z$/);
  });
});
