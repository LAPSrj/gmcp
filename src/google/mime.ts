import { base64urlEncode, base64urlDecodeToBuffer, type Recipient } from "../tools/helpers.ts";

// ---------- Parsing (Gmail messages.get(format=full) → flat structure) ----------

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPayloadPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPayloadPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  historyId?: string;
  sizeEstimate?: number;
  payload?: GmailPayloadPart;
}

export interface ParsedAddress {
  email: string | null;
  name: string | null;
}

export function getHeader(payload: GmailPayloadPart | undefined, name: string): string | null {
  if (!payload?.headers) return null;
  const want = name.toLowerCase();
  for (const h of payload.headers) {
    if (h.name?.toLowerCase() === want) return h.value ?? null;
  }
  return null;
}

// Parse a single "Name <email@host>" / "email@host" / "\"Name\" <email@host>" address.
export function parseAddress(s: string): ParsedAddress {
  const trimmed = s.trim();
  if (!trimmed) return { email: null, name: null };
  const angle = /^(.*)<([^>]+)>\s*$/.exec(trimmed);
  if (angle) {
    let name = angle[1]!.trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    return { email: angle[2]!.trim(), name: name || null };
  }
  return { email: trimmed, name: null };
}

// Split a comma-separated address-list header, respecting quoted display names
// and "<...>" wrappers. Conservative — splits on commas at depth 0.
export function parseAddressList(s: string | null): ParsedAddress[] {
  if (!s) return [];
  const out: ParsedAddress[] = [];
  let depth = 0;
  let inQuote = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' && s[i - 1] !== "\\") inQuote = !inQuote;
    else if (!inQuote && c === "<") depth++;
    else if (!inQuote && c === ">") depth--;
    if (!inQuote && depth === 0 && c === ",") {
      if (cur.trim()) out.push(parseAddress(cur));
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(parseAddress(cur));
  return out;
}

export interface ExtractedBody {
  format: "text" | "html" | null;
  content: string;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  content_type: string;
  size: number;
  is_inline: boolean;
}

// Walk the MIME tree and pull out (a) the best text/html or text/plain body,
// (b) attachment metadata. `preferred` selects which body wins when both exist.
export function extractBody(
  payload: GmailPayloadPart | undefined,
  preferred: "text" | "html",
): ExtractedBody {
  if (!payload) return { format: null, content: "" };
  const wantMime = preferred === "html" ? "text/html" : "text/plain";
  const fallbackMime = preferred === "html" ? "text/plain" : "text/html";
  const found = findFirstByMime(payload, wantMime) ?? findFirstByMime(payload, fallbackMime);
  if (!found) return { format: null, content: "" };
  const data = found.body?.data ?? "";
  const buf = data ? base64urlDecodeToBuffer(data) : Buffer.alloc(0);
  const fmt = (found.mimeType ?? "").includes("html") ? "html" : "text";
  return { format: fmt, content: buf.toString("utf8") };
}

function findFirstByMime(p: GmailPayloadPart, want: string): GmailPayloadPart | null {
  if ((p.mimeType ?? "").startsWith(want)) {
    // Skip attachments that happen to have a text mime; require body.data
    if (!p.filename && p.body?.data) return p;
  }
  if (p.parts) {
    for (const child of p.parts) {
      const r = findFirstByMime(child, want);
      if (r) return r;
    }
  }
  return null;
}

export function extractAttachments(payload: GmailPayloadPart | undefined): AttachmentMeta[] {
  const out: AttachmentMeta[] = [];
  function walk(p: GmailPayloadPart): void {
    const cd = getHeader(p, "Content-Disposition") ?? "";
    const cid = getHeader(p, "Content-ID");
    const isAttachment = !!(p.filename && p.filename.length > 0) || /attachment/i.test(cd);
    const isInline = /inline/i.test(cd) || (cid != null && !!p.filename);
    if (p.body?.attachmentId && isAttachment) {
      out.push({
        id: p.body.attachmentId,
        name: p.filename ?? "(unnamed)",
        content_type: p.mimeType ?? "application/octet-stream",
        size: p.body.size ?? 0,
        is_inline: isInline,
      });
    }
    if (p.parts) for (const c of p.parts) walk(c);
  }
  walk(payload ?? {});
  return out;
}

// ---------- Building (RFC 822 → base64url for messages.send / drafts.create) ----------

export interface BuildMessageOpts {
  from?: Recipient; // optional; Gmail fills in From: from authed account if omitted
  to: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  subject: string;
  body: string;
  bodyFormat: "text" | "html";
  attachments?: { name: string; content_type: string; content_base64: string }[];
  // Threading headers (for replies):
  inReplyTo?: string; // Message-Id of the message being replied to (with angle brackets)
  references?: string; // References header (space-separated message-ids with angle brackets)
  // Forwarding/explicit headers (e.g. Subject already has "Fwd: " prefix):
  extraHeaders?: Record<string, string>;
}

const CRLF = "\r\n";

function formatAddress(r: Recipient): string {
  if (!r.name) return r.email;
  // RFC 5322 "phrase" — quote if it contains specials.
  if (/[(),.<>@:;\\"\[\]]/.test(r.name)) return `"${r.name.replace(/"/g, '\\"')}" <${r.email}>`;
  return `${r.name} <${r.email}>`;
}

function addressList(rs: Recipient[]): string {
  return rs.map(formatAddress).join(", ");
}

function genBoundary(prefix: string): string {
  return `=_gmail_mcp_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function chunkBase64(b64: string): string {
  // RFC 2045: lines should be ≤76 chars
  return b64.match(/.{1,76}/g)?.join(CRLF) ?? b64;
}

function encodeRfc2047IfNeeded(s: string): string {
  // Only encode if it contains non-ASCII; otherwise leave alone.
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const b64 = Buffer.from(s, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

export function buildMimeMessage(opts: BuildMessageOpts): { raw: string } {
  const headers: string[] = [];
  if (opts.from) headers.push(`From: ${formatAddress(opts.from)}`);
  headers.push(`To: ${addressList(opts.to)}`);
  if (opts.cc?.length) headers.push(`Cc: ${addressList(opts.cc)}`);
  if (opts.bcc?.length) headers.push(`Bcc: ${addressList(opts.bcc)}`);
  headers.push(`Subject: ${encodeRfc2047IfNeeded(opts.subject)}`);
  headers.push("MIME-Version: 1.0");
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders)) headers.push(`${k}: ${v}`);
  }

  const bodyMime = opts.bodyFormat === "html" ? "text/html" : "text/plain";
  const bodyBytes = Buffer.from(opts.body, "utf8");
  const bodyB64 = chunkBase64(bodyBytes.toString("base64"));

  const atts = opts.attachments ?? [];

  let bodyBlock: string;
  if (atts.length === 0) {
    headers.push(`Content-Type: ${bodyMime}; charset=UTF-8`);
    headers.push("Content-Transfer-Encoding: base64");
    bodyBlock = bodyB64;
  } else {
    const boundary = genBoundary("mixed");
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts: string[] = [];
    // First part: the human body
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${bodyMime}; charset=UTF-8`,
        "Content-Transfer-Encoding: base64",
        "",
        bodyB64,
      ].join(CRLF),
    );
    for (const a of atts) {
      const aB64 = chunkBase64(Buffer.from(a.content_base64, "base64").toString("base64"));
      parts.push(
        [
          `--${boundary}`,
          `Content-Type: ${a.content_type}; name="${a.name.replace(/"/g, '\\"')}"`,
          "Content-Transfer-Encoding: base64",
          `Content-Disposition: attachment; filename="${a.name.replace(/"/g, '\\"')}"`,
          "",
          aB64,
        ].join(CRLF),
      );
    }
    parts.push(`--${boundary}--`);
    bodyBlock = parts.join(CRLF);
  }

  const message = headers.join(CRLF) + CRLF + CRLF + bodyBlock;
  return { raw: base64urlEncode(message) };
}

// Compose a "quoted reply" body so that mail_reply/mail_reply_all/mail_forward
// can attach the original message under a top comment, mirroring Outlook's
// reply semantics.
export function composeQuotedBody(args: {
  comment: string | undefined;
  bodyOverride: string | undefined;
  bodyFormat: "text" | "html";
  original: {
    from: string | null;
    date: string | null;
    subject: string | null;
    bodyText: string;
  };
  mode: "reply" | "forward";
}): string {
  const { comment, bodyOverride, bodyFormat, original, mode } = args;
  const head =
    mode === "forward"
      ? `\n\n---------- Forwarded message ----------\nFrom: ${original.from ?? ""}\nDate: ${original.date ?? ""}\nSubject: ${original.subject ?? ""}\n\n`
      : `\n\nOn ${original.date ?? ""}, ${original.from ?? "the sender"} wrote:\n`;
  if (bodyFormat === "html") {
    const top = bodyOverride ?? comment ?? "";
    const escapedOriginal = original.bodyText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
    const headHtml = head.replace(/\n/g, "<br>");
    return `${top}${headHtml}<blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${escapedOriginal}</blockquote>`;
  }
  const top = bodyOverride ?? comment ?? "";
  const quoted = original.bodyText
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `${top}${head}${quoted}`;
}
