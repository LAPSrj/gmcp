export function parseHM(s: string): [number, number] {
  const [h, m] = s.split(":");
  return [Number(h ?? 0), Number(m ?? 0)];
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

function toLocalParts(d: Date, tz: string | undefined): LocalParts {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz ?? "UTC",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  };
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  const wdMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    dayOfWeek: wdMap[weekday] ?? 0,
  };
}

export function inWorkingHours(
  start: Date,
  end: Date,
  whStartH: number,
  whStartM: number,
  whEndH: number,
  whEndM: number,
  tz: string | undefined,
): boolean {
  const sl = toLocalParts(start, tz);
  const el = toLocalParts(end, tz);
  if (sl.dayOfWeek === 0 || sl.dayOfWeek === 6) return false;
  if (el.dayOfWeek === 0 || el.dayOfWeek === 6) return false;
  if (sl.year !== el.year || sl.month !== el.month || sl.day !== el.day) return false;
  const startMin = sl.hour * 60 + sl.minute;
  const endMin = el.hour * 60 + el.minute;
  const whStart = whStartH * 60 + whStartM;
  const whEnd = whEndH * 60 + whEndM;
  if (startMin < whStart) return false;
  if (endMin > whEnd) return false;
  return true;
}
