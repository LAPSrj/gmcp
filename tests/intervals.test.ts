import { describe, test, expect } from "bun:test";
import { mergeIntervals } from "../src/lib/intervals.ts";

describe("mergeIntervals", () => {
  test("empty array returns empty", () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  test("single interval unchanged", () => {
    expect(mergeIntervals([{ start: 0, end: 10 }])).toEqual([{ start: 0, end: 10 }]);
  });

  test("non-overlapping intervals preserved in order", () => {
    expect(
      mergeIntervals([
        { start: 0, end: 5 },
        { start: 10, end: 15 },
      ]),
    ).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ]);
  });

  test("overlapping intervals merged", () => {
    expect(
      mergeIntervals([
        { start: 0, end: 10 },
        { start: 5, end: 15 },
      ]),
    ).toEqual([{ start: 0, end: 15 }]);
  });

  test("touching intervals (end === next start) merged", () => {
    expect(
      mergeIntervals([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([{ start: 0, end: 20 }]);
  });

  test("unordered input is sorted then merged", () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 0, end: 5 },
        { start: 3, end: 8 },
      ]),
    ).toEqual([
      { start: 0, end: 8 },
      { start: 10, end: 20 },
    ]);
  });

  test("fully contained interval absorbed", () => {
    expect(
      mergeIntervals([
        { start: 0, end: 100 },
        { start: 20, end: 30 },
      ]),
    ).toEqual([{ start: 0, end: 100 }]);
  });

  test("input array is not mutated", () => {
    const input = [
      { start: 5, end: 10 },
      { start: 0, end: 3 },
    ];
    const snapshot = JSON.stringify(input);
    mergeIntervals(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
