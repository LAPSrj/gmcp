import { getAccessToken } from "../auth/token.ts";

export type GoogleApi = "gmail" | "calendar" | "people";

import { GMAIL_BASE, CALENDAR_BASE, PEOPLE_BASE } from "../config.ts";

const BASES: Record<GoogleApi, string> = {
  gmail: GMAIL_BASE,
  calendar: CALENDAR_BASE,
  people: PEOPLE_BASE,
};

export interface GoogleRequestOptions {
  api: GoogleApi;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  // path is appended to the api base (or used as-is if it starts with "http").
  path: string;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  rawBody?: BodyInit;
  expectNoContent?: boolean;
}

export class GoogleError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(`Google ${status}: ${message}`);
    this.status = status;
    this.body = body;
  }
}

function buildUrl(opts: GoogleRequestOptions): string {
  const base = opts.path.startsWith("http") ? opts.path : `${BASES[opts.api]}${opts.path}`;
  const url = new URL(base);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        // Google REST APIs (Gmail labelIds, freebusy items) use repeated query params.
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

export async function googleRequest<T = unknown>(opts: GoogleRequestOptions): Promise<T> {
  const method = opts.method ?? "GET";
  const url = buildUrl(opts);

  let attempt = 0;
  // Retry on 429/5xx up to 4 times with exponential backoff (respecting Retry-After).
  while (true) {
    attempt++;
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };
    let body: BodyInit | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] ??= "application/json";
    }
    const res = await fetch(url, { method, headers, body });

    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (attempt >= 4) {
        const text = await safeText(res);
        throw new GoogleError(res.status, res.statusText, text);
      }
      const ra = res.headers.get("Retry-After");
      const waitMs = ra ? Number(ra) * 1000 : 500 * 2 ** (attempt - 1);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw new GoogleError(res.status, res.statusText, text);
    }

    if (opts.expectNoContent || res.status === 204) {
      return undefined as T;
    }
    const ct = res.headers.get("Content-Type") ?? "";
    if (ct.includes("application/json")) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }
}

interface ListPageShape {
  nextPageToken?: string;
}

// Generic paged-list helper. The Google REST APIs use slightly different
// shapes for the result envelope (Gmail: messages/labels; Calendar: items;
// People: connections/results) so callers pass an `extract` to pull out the
// array.
export async function googleList<TItem>(opts: {
  api: GoogleApi;
  path: string;
  query?: GoogleRequestOptions["query"];
  headers?: Record<string, string>;
  extract: (page: any) => TItem[] | undefined;
  maxResults?: number;
  pageSizeParam?: string;
  pageSize?: number;
}): Promise<TItem[]> {
  const max = opts.maxResults ?? 100;
  const out: TItem[] = [];
  let pageToken: string | undefined;
  while (out.length < max) {
    const query: GoogleRequestOptions["query"] = {
      ...(opts.query ?? {}),
      ...(pageToken ? { pageToken } : {}),
    };
    if (opts.pageSize && opts.pageSizeParam) {
      query[opts.pageSizeParam] = opts.pageSize;
    }
    const page = await googleRequest<ListPageShape & Record<string, unknown>>({
      api: opts.api,
      path: opts.path,
      query,
      headers: opts.headers,
    });
    const items = opts.extract(page) ?? [];
    for (const item of items) {
      out.push(item);
      if (out.length >= max) break;
    }
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<unknown> {
  try {
    const t = await res.text();
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  } catch {
    return null;
  }
}
