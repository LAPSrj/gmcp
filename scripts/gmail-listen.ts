#!/usr/bin/env bun
// Gmail inbox listener. Long-polls users.history.list for new INBOX arrivals
// and emits one JSON line per message to stdout — designed for Claude Code's
// Monitor tool.
//
// Two watch modes:
//   - default: every new message arriving in INBOX (firehose)
//   - --thread-id=<id>: only messages whose threadId matches (filters server-side
//     before the metadata fetch, so non-matching arrivals cost ~zero quota)
//
// Cursor / dedupe:
//   Uses Gmail's history API delta cursor — each call returns only what's
//   changed since the last historyId. No re-emit on reconnect within ~7d.
//   If our cursor goes >7d stale, Google returns 404; we reseed from
//   getProfile().historyId and log `reseeded: true` to stderr (some messages
//   in the gap may be missed — symmetric with mail_listen_inbox).
//
// Env (inherited from MCP server via inline assignment in the Monitor command):
//   GMAIL_MCP_CREDENTIALS_FILE  (required) — OAuth client JSON path
//   GMAIL_MCP_PROFILE           (optional) — selects tokens-<profile>.json
//   GMAIL_MCP_TOKEN_PATH        (optional) — overrides token file location
//
// Stdout: NDJSON event stream. Stderr: diagnostics only.

import { googleRequest, GoogleError } from "../src/google/client.ts";
import {
  getHeader,
  parseAddress,
  parseAddressList,
  type GmailMessage,
} from "../src/google/mime.ts";

interface HistoryRecord {
  id?: string;
  messages?: { id?: string; threadId?: string; labelIds?: string[] }[];
  messagesAdded?: {
    message?: { id?: string; threadId?: string; labelIds?: string[] };
  }[];
}
interface HistoryPage {
  history?: HistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
}

// ---------- Args ----------

const args = parseArgs(process.argv.slice(2));
const THREAD_FILTER: string | null = args["thread-id"] ?? null;
const POLL_SECONDS: number = clampInt(args["poll"], 5, 60, 10);
const MAX_RESULTS: number = clampInt(args["max-results"], 1, 100, 25);

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

function compact(m: GmailMessage): Record<string, unknown> {
  const from = parseAddress(getHeader(m.payload, "From") ?? "");
  const to = parseAddressList(getHeader(m.payload, "To"));
  const cc = parseAddressList(getHeader(m.payload, "Cc"));
  return {
    id: m.id,
    thread_id: m.threadId,
    subject: getHeader(m.payload, "Subject") ?? null,
    from: from.email ? { email: from.email, name: from.name } : null,
    to: to.map((a) => ({ email: a.email, name: a.name })),
    cc: cc.map((a) => ({ email: a.email, name: a.name })),
    received: getHeader(m.payload, "Date") ?? null,
    rfc822_message_id:
      getHeader(m.payload, "Message-ID") ?? getHeader(m.payload, "Message-Id") ?? null,
    labels: m.labelIds ?? [],
    snippet: m.snippet ?? null,
    internal_date: m.internalDate ?? null,
    history_id: m.historyId ?? null,
    web_link: m.threadId
      ? `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`
      : null,
  };
}

async function enrichMetadata(ids: string[]): Promise<GmailMessage[]> {
  const headers = ["Subject", "From", "To", "Cc", "Date", "Message-ID"];
  return await Promise.all(
    ids.map((id) =>
      googleRequest<GmailMessage>({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(id)}`,
        query: { format: "metadata", metadataHeaders: headers },
      }),
    ),
  );
}

// ---------- Main loop ----------

let shuttingDown = false;
process.on("SIGTERM", () => {
  shuttingDown = true;
  console.error("gmail-listen: SIGTERM received, exiting");
  process.exit(0);
});
process.on("SIGINT", () => {
  shuttingDown = true;
  console.error("gmail-listen: SIGINT received, exiting");
  process.exit(0);
});

async function main(): Promise<void> {
  const profile = await googleRequest<{ emailAddress?: string; historyId?: string }>({
    api: "gmail",
    path: "/users/me/profile",
  });
  let cursor = profile.historyId;
  if (!cursor) {
    console.error("gmail-listen: getProfile returned no historyId — cannot seed cursor");
    process.exit(1);
  }
  console.error(
    `gmail-listen: connected as ${profile.emailAddress ?? "unknown"}, historyId=${cursor}` +
      (THREAD_FILTER ? `, filter thread_id=${THREAD_FILTER}` : "") +
      `, poll=${POLL_SECONDS}s`,
  );

  let consecutiveErrors = 0;

  while (!shuttingDown) {
    let page: HistoryPage;
    try {
      page = await googleRequest<HistoryPage>({
        api: "gmail",
        path: "/users/me/history",
        query: {
          startHistoryId: cursor!,
          labelId: "INBOX",
          historyTypes: ["messageAdded"],
          maxResults: MAX_RESULTS,
        },
      });
      consecutiveErrors = 0;
    } catch (err) {
      if (err instanceof GoogleError && err.status === 404) {
        const reseed = await googleRequest<{ historyId?: string }>({
          api: "gmail",
          path: "/users/me/profile",
        });
        cursor = reseed.historyId ?? cursor;
        console.error(
          `gmail-listen: history cursor stale (404), reseeded to historyId=${cursor} — gap may have been missed`,
        );
        await sleep(POLL_SECONDS * 1000);
        continue;
      }
      consecutiveErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`gmail-listen: history.list failed (attempt ${consecutiveErrors}): ${msg}`);
      // Exponential backoff capped at 5min; if we hit 8 in a row, exit so Monitor
      // surfaces the failure to the operator.
      if (consecutiveErrors >= 8) {
        console.error("gmail-listen: 8 consecutive errors, exiting");
        process.exit(1);
      }
      await sleep(Math.min(300_000, 1000 * 2 ** consecutiveErrors));
      continue;
    }

    const candidateIds: string[] = [];
    for (const h of page.history ?? []) {
      for (const ma of h.messagesAdded ?? []) {
        const m = ma.message;
        if (!m?.id) continue;
        const labels = m.labelIds ?? [];
        if (!labels.includes("INBOX")) continue;
        if (THREAD_FILTER && m.threadId !== THREAD_FILTER) continue;
        candidateIds.push(m.id);
      }
    }

    if (candidateIds.length > 0) {
      try {
        const enriched = await enrichMetadata(candidateIds);
        for (const m of enriched) emit(compact(m));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`gmail-listen: metadata enrich failed: ${msg}`);
      }
    }

    if (page.historyId) cursor = page.historyId;
    await sleep(POLL_SECONDS * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`gmail-listen: fatal: ${msg}`);
  process.exit(1);
});
