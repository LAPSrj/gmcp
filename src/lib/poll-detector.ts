// Detects when a caller is brute-polling the same read on a roughly fixed
// interval — i.e. re-fetching the same info on a timer to watch for changes —
// and lets the tool nudge them toward the Monitor-based change listener
// (mail_listen_instructions / calendar_listen_instructions), which long-polls
// server-side and emits only on change.
//
// MCP tool calls are stateless (each call is independent; the server can't see
// call cadence from a single invocation), so we keep a tiny in-memory ring of
// recent call timestamps per (tool, target) key in the long-lived server
// process. No persistence — a server restart simply forgets recent cadence.

interface PollState {
  times: number[];
}

const states = new Map<string, PollState>();

// Keep just enough history to judge the most recent intervals.
const MAX_TIMES = 6;
// How many calls form a "pattern". Three calls → two intervals to compare.
const MIN_CALLS = 3;

// Bounds on what counts as polling-on-a-timer. Faster than MIN is a burst (e.g.
// pagination), slower than MAX is a spaced-out check not worth nudging.
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 20 * 60_000;
// Consecutive intervals within ±TOLERANCE of each other count as "approximately
// the same interval".
const TOLERANCE = 0.5;

// Record a call for `key` at `now` (ms epoch) and return true when the last
// MIN_CALLS calls form an approximately-regular interval within the polling
// bounds. Returns true on every qualifying call — so while the behavior
// continues, the nudge keeps surfacing (the caller asked to be reminded each
// time, not just once).
export function notePoll(key: string, now: number): boolean {
  const st = states.get(key) ?? { times: [] };
  st.times.push(now);
  if (st.times.length > MAX_TIMES) st.times.shift();
  states.set(key, st);

  const t = st.times;
  if (t.length < MIN_CALLS) return false;

  // The three most recent timestamps (guaranteed present by the length check;
  // the non-null assertions satisfy noUncheckedIndexedAccess).
  const t3 = t[t.length - 3]!;
  const t2 = t[t.length - 2]!;
  const t1 = t[t.length - 1]!;
  // The two most recent intervals (from the last three calls).
  const i1 = t2 - t3;
  const i2 = t1 - t2;
  if (i1 < MIN_INTERVAL_MS || i2 < MIN_INTERVAL_MS) return false;
  if (i1 > MAX_INTERVAL_MS || i2 > MAX_INTERVAL_MS) return false;

  const lo = Math.min(i1, i2);
  const hi = Math.max(i1, i2);
  return hi <= lo * (1 + TOLERANCE);
}

// Convenience: record the call and return the nudge message when the polling
// pattern is detected, otherwise undefined. Pass the message straight to
// `ok(data, notice)`.
export function pollNudge(key: string, now: number, message: string): string | undefined {
  return notePoll(key, now) ? message : undefined;
}

// Test seam — clears all tracked cadence.
export function __resetPollDetector(): void {
  states.clear();
}
