import { z } from "zod";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { googleRequest, googleList, GoogleError } from "../google/client.ts";
import {
  ok,
  err,
  base64urlEncode,
  base64urlToStandardBase64,
  base64urlDecodeToBuffer,
  type Recipient,
} from "./helpers.ts";
import { pollNudge } from "../lib/poll-detector.ts";

// Inline-base64 size cap on mail_get_attachment. Base64 inflates ~33%, so a
// 200 KB attachment becomes ~267 KB of agent output — under the harness limit
// while still useful for small images/PDFs. Larger attachments must use
// output_path to write server-side. Mirrors the SEND-side `file_path` guard
// so bytes never accidentally flow through the agent's context in either
// direction.
const INLINE_ATTACHMENT_BYTE_LIMIT = 200 * 1024;
import {
  buildMimeMessage,
  composeQuotedBodyWithSignature,
  extractAttachments,
  extractBody,
  getHeader,
  parseAddress,
  parseAddressList,
  withSignature,
  type GmailMessage,
} from "../google/mime.ts";
import {
  getAccountSignature,
  signatureEnabledByDefault,
  wantSignature,
} from "../google/signature.ts";

// ---------- Shared schemas ----------

const recipientSchema = z
  .object({
    email: z.string().email(),
    name: z.string().optional(),
  })
  .strict();

const attachmentSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe("File name with extension. Required when content_base64 is used; defaults to basename(file_path) when omitted."),
    content_type: z.string().default("application/octet-stream"),
    content_base64: z
      .string()
      .optional()
      .describe(
        "Base64-encoded file content (standard base64, not base64url). Mutually exclusive with file_path. Use this for inline bytes the agent already has; prefer file_path for anything larger than a few KB to keep bytes out of the agent's context window.",
      ),
    file_path: z
      .string()
      .optional()
      .describe(
        "Absolute path to a file on the MCP server's disk. The server reads and base64-encodes it server-side, so the bytes never enter the agent's context. Mutually exclusive with content_base64. Path must be absolute and free of '..' segments.",
      ),
  })
  // .strict() must come BEFORE .refine() — .refine() returns ZodEffects (not
  // ZodObject), and .strict() is a ZodObject method. Strict is preserved by
  // the ZodEffects wrapper at parse time.
  .strict()
  .refine((a) => Boolean(a.content_base64) !== Boolean(a.file_path), {
    message: "Provide exactly one of content_base64 or file_path.",
  })
  .refine((a) => !a.content_base64 || (a.name && a.name.length > 0), {
    message: "name is required when content_base64 is used (it can be omitted with file_path to default to basename).",
  });

type AttachmentInput = z.input<typeof attachmentSchema>;

interface MaterializedAttachment {
  name: string;
  content_type: string;
  content_base64: string;
}

async function materializeAttachments(
  atts: AttachmentInput[] | undefined,
): Promise<MaterializedAttachment[]> {
  if (!atts || atts.length === 0) return [];
  return Promise.all(
    atts.map(async (a) => {
      if (a.file_path) {
        if (!isAbsolute(a.file_path)) {
          throw new Error(`attachment.file_path must be absolute: ${a.file_path}`);
        }
        if (a.file_path.split(/[\\/]/).includes("..")) {
          throw new Error(`attachment.file_path must not contain '..' segments: ${a.file_path}`);
        }
        let buf: Buffer;
        try {
          buf = await readFile(a.file_path);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`Failed to read attachment.file_path (${a.file_path}): ${msg}`);
        }
        return {
          name: a.name ?? basename(a.file_path),
          content_type: a.content_type ?? "application/octet-stream",
          content_base64: buf.toString("base64"),
        };
      }
      return {
        name: a.name!,
        content_type: a.content_type ?? "application/octet-stream",
        content_base64: a.content_base64!,
      };
    }),
  );
}

// ---------- Folder ↔ label mapping ----------

// Outlook well-known folder names → Gmail system label ids.
const FOLDER_LABEL_MAP: Record<string, string> = {
  inbox: "INBOX",
  drafts: "DRAFT",
  draft: "DRAFT",
  sentitems: "SENT",
  sent: "SENT",
  deleteditems: "TRASH",
  trash: "TRASH",
  junkemail: "SPAM",
  spam: "SPAM",
  important: "IMPORTANT",
  starred: "STARRED",
  unread: "UNREAD",
};

function resolveLabel(input: string): string {
  const lower = input.toLowerCase();
  if (FOLDER_LABEL_MAP[lower]) return FOLDER_LABEL_MAP[lower]!;
  return input;
}

// ---------- Compact shape ----------

function compactMessageFromHeaders(m: GmailMessage): Record<string, unknown> {
  const from = parseAddress(getHeader(m.payload, "From") ?? "");
  const to = parseAddressList(getHeader(m.payload, "To"));
  const cc = parseAddressList(getHeader(m.payload, "Cc"));
  const dateHeader = getHeader(m.payload, "Date");
  const subject = getHeader(m.payload, "Subject");
  const messageIdHeader = getHeader(m.payload, "Message-ID") ?? getHeader(m.payload, "Message-Id");
  const labels = m.labelIds ?? [];
  return {
    id: m.id,
    thread_id: m.threadId,
    subject: subject,
    from: from.email ? { email: from.email, name: from.name } : null,
    to: to.map((a) => ({ email: a.email, name: a.name })),
    cc: cc.map((a) => ({ email: a.email, name: a.name })),
    received: dateHeader,
    sent: dateHeader,
    is_read: !labels.includes("UNREAD"),
    is_starred: labels.includes("STARRED"),
    is_important: labels.includes("IMPORTANT"),
    labels,
    has_attachments: hasAnyAttachment(m),
    body_preview: m.snippet ?? null,
    internal_date: m.internalDate ?? null,
    history_id: m.historyId ?? null,
    rfc822_message_id: messageIdHeader,
    web_link: `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`,
  };
}

function hasAnyAttachment(m: GmailMessage): boolean {
  function walk(p: { filename?: string; parts?: { filename?: string; parts?: unknown[] }[] }): boolean {
    if (p.filename && p.filename.length > 0) return true;
    if (p.parts) {
      for (const child of p.parts) {
        if (walk(child as never)) return true;
      }
    }
    return false;
  }
  return walk((m.payload ?? {}) as never);
}

// Fetch a list of message ids and enrich each with metadata headers. Parallel,
// bounded to `top`. Gmail allows ~250 quota/sec — burst of 25 is fine.
async function enrichMessages(
  ids: string[],
  format: "metadata" | "full" = "metadata",
): Promise<GmailMessage[]> {
  const headers = ["Subject", "From", "To", "Cc", "Date", "Message-ID"];
  const out = await Promise.all(
    ids.map((id) =>
      googleRequest<GmailMessage>({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(id)}`,
        query: {
          format,
          ...(format === "metadata" ? { metadataHeaders: headers } : {}),
        },
      }),
    ),
  );
  return out;
}

// ---------- Tool registration ----------

export function registerMailTools(server: McpServer): void {
  // ----- READ -----

  server.tool(
    "mail_list",
    "List email messages in a folder (default: inbox). Returns compact summaries. Folder values: outlook-style names (inbox, drafts, sentitems, deleteditems, junkemail) are translated to Gmail labels (INBOX/DRAFT/SENT/TRASH/SPAM); you can also pass a Gmail label id directly. For 'archive' (no system label), pass q='-label:inbox' via mail_search instead.",
    {
      folder: z
        .string()
        .optional()
        .describe(
          "Folder/label. Default: inbox. Accepts outlook-style well-known names or Gmail label ids.",
        ),
      top: z.number().int().min(1).max(100).default(25),
      unread_only: z.boolean().default(false),
      from: z.string().optional().describe("Filter by sender email (added to q as from:)"),
      has_attachments: z.boolean().optional(),
      order_by: z
        .enum(["receivedDateTime desc", "receivedDateTime asc", "subject"])
        .default("receivedDateTime desc")
        .describe("Gmail always returns newest-first by internalDate. asc/subject sort is applied client-side after fetch."),
    },
    async ({ folder, top, unread_only, from, has_attachments, order_by }) => {
      const labelId = resolveLabel(folder ?? "inbox");
      const qParts: string[] = [];
      if (unread_only) qParts.push("is:unread");
      if (from) qParts.push(`from:${from}`);
      if (has_attachments !== undefined) qParts.push(has_attachments ? "has:attachment" : "-has:attachment");
      const query = qParts.join(" ");

      const ids = await googleList<{ id: string }>({
        api: "gmail",
        path: "/users/me/messages",
        query: {
          labelIds: [labelId],
          maxResults: top,
          ...(query ? { q: query } : {}),
        },
        extract: (p) => p.messages,
        maxResults: top,
        pageSize: top,
        pageSizeParam: "maxResults",
      });
      const enriched = await enrichMessages(ids.map((i) => i.id), "metadata");
      const compacts = enriched.map(compactMessageFromHeaders);

      // Apply client-side ordering when caller asked for something other than the default.
      if (order_by === "receivedDateTime asc") compacts.reverse();
      else if (order_by === "subject") {
        compacts.sort((a, b) => String(a.subject ?? "").localeCompare(String(b.subject ?? "")));
      }
      const notice = pollNudge(
        `mail_list:${labelId}:${query}`,
        Date.now(),
        "It looks like you're re-listing this folder on a timer to watch for new mail. For change-only notifications, call mail_listen_instructions and pass the returned command to Monitor — it long-polls Gmail's history API server-side and emits one line per new arrival (optionally filtered to one thread), instead of you polling. For a single blocking wait, mail_listen_inbox is also cheaper than a poll loop.",
      );
      return ok(compacts, notice);
    },
  );

  server.tool(
    "mail_search",
    "Search using Gmail's q syntax. Examples: 'from:alice@x.com project', 'subject:invoice', 'has:attachment newer_than:7d', 'label:inbox is:unread', '-label:inbox -label:trash' (archived).",
    {
      query: z.string().describe("Gmail search query"),
      top: z.number().int().min(1).max(100).default(25),
      folder: z
        .string()
        .optional()
        .describe("Optional label/folder to restrict to (added as labelIds filter, not appended to q)."),
    },
    async ({ query, top, folder }) => {
      const labelIds = folder ? [resolveLabel(folder)] : undefined;
      const ids = await googleList<{ id: string }>({
        api: "gmail",
        path: "/users/me/messages",
        query: { q: query, maxResults: top, ...(labelIds ? { labelIds } : {}) },
        extract: (p) => p.messages,
        maxResults: top,
        pageSize: top,
        pageSizeParam: "maxResults",
      });
      const enriched = await enrichMessages(ids.map((i) => i.id), "metadata");
      const notice = pollNudge(
        `mail_search:${folder ?? ""}:${query}`,
        Date.now(),
        "It looks like you're re-running this same search on a timer to watch for new matches. For change-only notifications, call mail_listen_instructions and pass the returned command to Monitor — it long-polls Gmail's history API server-side and emits one line per new inbox arrival (optionally filtered to one thread), instead of you polling.",
      );
      return ok(enriched.map(compactMessageFromHeaders), notice);
    },
  );

  server.tool(
    "mail_get",
    "Get a single email message with full body and attachment metadata.",
    {
      id: z.string(),
      format: z.enum(["text", "html"]).default("text"),
      include_attachments_meta: z.boolean().default(true),
    },
    async ({ id, format, include_attachments_meta }) => {
      const msg = await googleRequest<GmailMessage>({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(id)}`,
        query: { format: "full" },
      });
      const body = extractBody(msg.payload, format);
      const attachments = include_attachments_meta ? extractAttachments(msg.payload) : [];
      const compact = compactMessageFromHeaders(msg);
      return ok({
        ...compact,
        body: { format: body.format, content: body.content },
        attachments,
      });
    },
  );

  server.tool(
    "mail_get_attachment",
    `Download an email attachment. Writes to output_path when provided, otherwise returns inline base64 — but only for attachments at or below ${Math.round(INLINE_ATTACHMENT_BYTE_LIMIT / 1024)} KB. Anything larger requires output_path; the inline-base64 response would blow the agent's output limit (base64 inflates ~33%).`,
    {
      message_id: z.string(),
      attachment_id: z.string(),
      output_path: z
        .string()
        .optional()
        .describe(
          "Absolute path to write the file. REQUIRED for attachments larger than ~200 KB. Omit only for small attachments (icons, tiny PDFs) where you actually want the bytes inline.",
        ),
    },
    async ({ message_id, attachment_id, output_path }) => {
      const att = await googleRequest<{ size?: number; data?: string }>({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(message_id)}/attachments/${encodeURIComponent(attachment_id)}`,
      });
      if (!att.data) {
        return ok({ size: att.size ?? 0, content_base64: "" });
      }
      // Also fetch the parent message so we can recover filename + content-type
      // by looking up the part with this attachmentId. Cheaper paths skip names
      // entirely; this is a small fetch and matches outlook-mcp's response shape.
      let name = "(unnamed)";
      let contentType = "application/octet-stream";
      try {
        const msg = await googleRequest<GmailMessage>({
          api: "gmail",
          path: `/users/me/messages/${encodeURIComponent(message_id)}`,
          query: { format: "full" },
        });
        const found = extractAttachments(msg.payload).find((a) => a.id === attachment_id);
        if (found) {
          name = found.name;
          contentType = found.content_type;
        }
      } catch {
        // non-fatal
      }
      const bytes = base64urlDecodeToBuffer(att.data);
      if (output_path) {
        await writeFile(output_path, bytes);
        return ok({ name, content_type: contentType, size: bytes.length, saved_to: output_path });
      }
      if (bytes.length > INLINE_ATTACHMENT_BYTE_LIMIT) {
        const kb = (bytes.length / 1024).toFixed(1);
        const limitKb = Math.round(INLINE_ATTACHMENT_BYTE_LIMIT / 1024);
        return err(
          `attachment '${name}' is ${bytes.length} bytes (${kb} KB) — exceeds the ${limitKb} KB inline-base64 cap. Re-call mail_get_attachment with output_path set to an absolute file path; returning inline base64 would exceed the agent's output limit.`,
        );
      }
      return ok({
        name,
        content_type: contentType,
        size: bytes.length,
        content_base64: bytes.toString("base64"),
      });
    },
  );

  server.tool(
    "mail_list_labels",
    "List all Gmail labels (system labels like INBOX/SENT/STARRED + user-created labels). Outlook agents: this replaces mail_list_folders.",
    {},
    async () => {
      const page = await googleRequest<{ labels?: GmailLabel[] }>({
        api: "gmail",
        path: "/users/me/labels",
      });
      return ok(
        (page.labels ?? []).map((l) => ({
          id: l.id,
          name: l.name,
          type: l.type ?? "user",
          messages_total: l.messagesTotal ?? null,
          messages_unread: l.messagesUnread ?? null,
          threads_total: l.threadsTotal ?? null,
          threads_unread: l.threadsUnread ?? null,
          color: l.color
            ? { text: l.color.textColor, background: l.color.backgroundColor }
            : null,
          label_list_visibility: l.labelListVisibility ?? null,
          message_list_visibility: l.messageListVisibility ?? null,
        })),
      );
    },
  );

  server.tool(
    "mail_create_label",
    "Create a new user label.",
    {
      name: z.string().describe("Label name. Nested labels use '/' as separator (e.g. 'Projects/Acme')."),
      message_list_visibility: z.enum(["show", "hide"]).default("show"),
      label_list_visibility: z
        .enum(["labelShow", "labelShowIfUnread", "labelHide"])
        .default("labelShow"),
    },
    async ({ name, message_list_visibility, label_list_visibility }) => {
      const created = await googleRequest<GmailLabel>({
        api: "gmail",
        path: "/users/me/labels",
        method: "POST",
        body: {
          name,
          messageListVisibility: message_list_visibility,
          labelListVisibility: label_list_visibility,
        },
      });
      return ok({ id: created.id, name: created.name });
    },
  );

  server.tool(
    "mail_apply_labels",
    "Add and/or remove labels on a message. Gmail messages can have many labels at once; this is the honest primitive behind 'move' and 'mark as'. System labels (INBOX, UNREAD, STARRED, ...) and user label ids both work.",
    {
      id: z.string(),
      add: z.array(z.string()).optional().describe("Label ids to add"),
      remove: z.array(z.string()).optional().describe("Label ids to remove"),
    },
    async ({ id, add, remove }) => {
      await googleRequest({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(id)}/modify`,
        method: "POST",
        body: {
          addLabelIds: (add ?? []).map(resolveLabel),
          removeLabelIds: (remove ?? []).map(resolveLabel),
        },
      });
      return ok({ updated: true });
    },
  );

  server.tool(
    "mail_get_thread",
    "Get a full email thread (conversation) with all messages.",
    {
      id: z.string().describe("Thread id (returned as thread_id on every message)."),
      format: z.enum(["text", "html"]).default("text"),
    },
    async ({ id, format }) => {
      const thread = await googleRequest<{ id: string; historyId?: string; messages?: GmailMessage[] }>({
        api: "gmail",
        path: `/users/me/threads/${encodeURIComponent(id)}`,
        query: { format: "full" },
      });
      const msgs = (thread.messages ?? []).map((m) => {
        const body = extractBody(m.payload, format);
        return {
          ...compactMessageFromHeaders(m),
          body: { format: body.format, content: body.content },
          attachments: extractAttachments(m.payload),
        };
      });
      return ok({
        id: thread.id,
        history_id: thread.historyId ?? null,
        messages: msgs,
      });
    },
  );

  server.tool(
    "mail_list_threads",
    "List email threads (conversations). Same filter shape as mail_list but returns threads instead of individual messages.",
    {
      folder: z.string().optional(),
      top: z.number().int().min(1).max(100).default(25),
      query: z.string().optional().describe("Optional Gmail q expression appended to the label filter."),
    },
    async ({ folder, top, query }) => {
      const labelId = resolveLabel(folder ?? "inbox");
      const ids = await googleList<{ id: string }>({
        api: "gmail",
        path: "/users/me/threads",
        query: {
          labelIds: [labelId],
          maxResults: top,
          ...(query ? { q: query } : {}),
        },
        extract: (p) => p.threads,
        maxResults: top,
        pageSize: top,
        pageSizeParam: "maxResults",
      });
      // Fetch each thread with format=metadata to get the latest message subject + snippet.
      const headers = ["Subject", "From", "Date"];
      const threads = await Promise.all(
        ids.map((t) =>
          googleRequest<{ id: string; historyId?: string; messages?: GmailMessage[] }>({
            api: "gmail",
            path: `/users/me/threads/${encodeURIComponent(t.id)}`,
            query: { format: "metadata", metadataHeaders: headers },
          }),
        ),
      );
      return ok(
        threads.map((t) => {
          const last = t.messages?.[t.messages.length - 1];
          return {
            id: t.id,
            history_id: t.historyId ?? null,
            message_count: t.messages?.length ?? 0,
            latest_message: last ? compactMessageFromHeaders(last) : null,
            participants: collectParticipants(t.messages ?? []),
          };
        }),
      );
    },
  );

  // ----- WRITE: compose / send / drafts -----

  const signatureDesc =
    "Append your Gmail signature (from Gmail Settings → Accounts → 'send mail as') to the message. " +
    "When omitted, defaults to the GMAIL_MCP_AUTO_SIGNATURE env var (off unless set to 1/true/yes/on). " +
    "Because Gmail signatures are HTML, a plain-text body is sent as HTML when a signature is appended. " +
    "IMPORTANT: when this is on, do NOT also write a sign-off/signature into `body` — the account signature is added for you and writing one too would duplicate it.";

  // When the env default is on, every send carries a signature unless the caller
  // opts out — so the agent must be told up front not to write one into `body`.
  // A static param description isn't enough: an agent may compose the body
  // without ever reading the optional `include_signature` arg. So we surface the
  // warning on the tool description itself, but only when it actually applies.
  const autoSigNote = signatureEnabledByDefault()
    ? " SIGNATURE: GMAIL_MCP_AUTO_SIGNATURE is enabled, so your Gmail signature is appended to this message automatically — do NOT write a sign-off/signature into `body` (it would be duplicated). Pass include_signature:false to suppress it for a single call."
    : "";

  const composeShape = {
    to: z.array(recipientSchema).min(1),
    cc: z.array(recipientSchema).optional(),
    bcc: z.array(recipientSchema).optional(),
    subject: z.string(),
    body: z.string(),
    body_format: z.enum(["text", "html"]).default("text"),
    attachments: z.array(attachmentSchema).optional(),
    include_signature: z.boolean().optional().describe(signatureDesc),
  } as const;

  server.tool(
    "mail_send",
    "Compose and send an email immediately. Note: Gmail always saves a copy to SENT; the save_to_sent flag is accepted for outlook parity but has no effect." +
      autoSigNote,
    { ...composeShape, save_to_sent: z.boolean().default(true) },
    async (args) => {
      const attachments = await materializeAttachments(args.attachments);
      const sig = wantSignature(args.include_signature) ? await getAccountSignature() : null;
      const composed = withSignature({
        body: args.body,
        bodyFormat: args.body_format,
        signatureHtml: sig,
      });
      const { raw } = buildMimeMessage({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: composed.body,
        bodyFormat: composed.bodyFormat,
        attachments,
      });
      const sent = await googleRequest<{ id: string; threadId: string }>({
        api: "gmail",
        path: "/users/me/messages/send",
        method: "POST",
        body: { raw },
      });
      return ok({ sent: true, id: sent.id, thread_id: sent.threadId });
    },
  );

  server.tool(
    "mail_create_draft",
    "Create a draft email (not sent). Returns the draft id." + autoSigNote,
    composeShape,
    async (args) => {
      const attachments = await materializeAttachments(args.attachments);
      const sig = wantSignature(args.include_signature) ? await getAccountSignature() : null;
      const composed = withSignature({
        body: args.body,
        bodyFormat: args.body_format,
        signatureHtml: sig,
      });
      const { raw } = buildMimeMessage({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: composed.body,
        bodyFormat: composed.bodyFormat,
        attachments,
      });
      const created = await googleRequest<{ id: string; message?: { id: string; threadId: string } }>({
        api: "gmail",
        path: "/users/me/drafts",
        method: "POST",
        body: { message: { raw } },
      });
      return ok({ id: created.id, message_id: created.message?.id ?? null });
    },
  );

  server.tool(
    "mail_update_draft",
    "Update fields on an existing draft. The draft is fully replaced — pass all the fields you want it to have." +
      autoSigNote,
    {
      id: z.string(),
      to: z.array(recipientSchema).optional(),
      cc: z.array(recipientSchema).optional(),
      bcc: z.array(recipientSchema).optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      body_format: z.enum(["text", "html"]).default("text"),
      attachments: z.array(attachmentSchema).optional(),
      include_signature: z.boolean().optional(),
    },
    async ({ id, to, cc, bcc, subject, body, body_format, attachments, include_signature }) => {
      const materialized = await materializeAttachments(attachments);
      const sig = wantSignature(include_signature) ? await getAccountSignature() : null;
      const composed = withSignature({ body: body ?? "", bodyFormat: body_format, signatureHtml: sig });
      const { raw } = buildMimeMessage({
        to: to ?? [{ email: "" }], // Gmail accepts empty fields in a draft; caller should refill
        cc,
        bcc,
        subject: subject ?? "",
        body: composed.body,
        bodyFormat: composed.bodyFormat,
        attachments: materialized,
      });
      await googleRequest({
        api: "gmail",
        path: `/users/me/drafts/${encodeURIComponent(id)}`,
        method: "PUT",
        body: { message: { raw } },
      });
      return ok({ updated: true });
    },
  );

  server.tool(
    "mail_send_draft",
    "Send an existing draft email.",
    { id: z.string() },
    async ({ id }) => {
      const sent = await googleRequest<{ id: string; threadId: string }>({
        api: "gmail",
        path: "/users/me/drafts/send",
        method: "POST",
        body: { id },
      });
      return ok({ sent: true, id: sent.id, thread_id: sent.threadId });
    },
  );

  server.tool(
    "mail_reply",
    "Reply to a message. Provide `body` for a fully custom body, or `comment` for a note above the quoted original. Threading headers (In-Reply-To, References, threadId) are set automatically. If the message being replied to was sent by YOU (e.g. continuing a thread you started), recipients are resolved from the original To/Cc minus self, not from the original From. Pass explicit `to`/`cc`/`bcc` to override the heuristic. The response includes a `warnings` array — non-empty when the resolver lands on a suspicious recipient (e.g. yourself)." +
      autoSigNote,
    {
      id: z.string(),
      body: z.string().optional(),
      body_format: z.enum(["text", "html"]).default("text"),
      comment: z.string().optional(),
      to: z.array(recipientSchema).optional().describe("Override the resolved To. When set, the heuristic is skipped."),
      cc: z.array(recipientSchema).optional().describe("Override the resolved Cc. When set, the heuristic is skipped."),
      bcc: z.array(recipientSchema).optional().describe("Bcc list (no heuristic — always honored as-is)."),
      attachments: z.array(attachmentSchema).optional(),
      include_signature: z.boolean().optional().describe(signatureDesc),
    },
    async ({ id, body, body_format, comment, to, cc, bcc, attachments, include_signature }) => {
      const result = await sendReply({
        id,
        body,
        bodyFormat: body_format,
        comment,
        all: false,
        override: { to, cc, bcc },
        attachments,
        includeSignature: include_signature,
      });
      return ok({
        sent: true,
        id: result.id,
        thread_id: result.threadId,
        warnings: result.warnings,
      });
    },
  );

  server.tool(
    "mail_reply_all",
    "Reply-all to a message — preserves To/Cc of the original. If the message was sent by YOU, recipients are resolved from the original To/Cc minus self (so the reply goes to the other parties, not back to yourself). Pass explicit `to`/`cc`/`bcc` to override." +
      autoSigNote,
    {
      id: z.string(),
      body: z.string().optional(),
      body_format: z.enum(["text", "html"]).default("text"),
      comment: z.string().optional(),
      to: z.array(recipientSchema).optional().describe("Override the resolved To. When set, the heuristic is skipped."),
      cc: z.array(recipientSchema).optional().describe("Override the resolved Cc. When set, the heuristic is skipped."),
      bcc: z.array(recipientSchema).optional().describe("Bcc list (no heuristic — always honored as-is)."),
      attachments: z.array(attachmentSchema).optional(),
      include_signature: z.boolean().optional().describe(signatureDesc),
    },
    async ({ id, body, body_format, comment, to, cc, bcc, attachments, include_signature }) => {
      const result = await sendReply({
        id,
        body,
        bodyFormat: body_format,
        comment,
        all: true,
        override: { to, cc, bcc },
        attachments,
        includeSignature: include_signature,
      });
      return ok({
        sent: true,
        id: result.id,
        thread_id: result.threadId,
        warnings: result.warnings,
      });
    },
  );

  server.tool(
    "mail_forward",
    "Forward a message to new recipients." + autoSigNote,
    {
      id: z.string(),
      to: z.array(recipientSchema).min(1),
      comment: z.string().optional(),
      attachments: z.array(attachmentSchema).optional(),
      include_signature: z.boolean().optional().describe(signatureDesc),
    },
    async ({ id, to, comment, attachments, include_signature }) => {
      const original = await googleRequest<GmailMessage>({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(id)}`,
        query: { format: "full" },
      });
      const origSubject = getHeader(original.payload, "Subject") ?? "";
      const origFrom = getHeader(original.payload, "From");
      const origDate = getHeader(original.payload, "Date");
      const fwdSubject = /^fwd?:/i.test(origSubject) ? origSubject : `Fwd: ${origSubject}`;
      const origBody = extractBody(original.payload, "text").content;
      const sig = wantSignature(include_signature) ? await getAccountSignature() : null;
      const composed = composeQuotedBodyWithSignature({
        comment,
        bodyOverride: undefined,
        bodyFormat: "text",
        signatureHtml: sig,
        original: {
          from: origFrom,
          date: origDate,
          subject: origSubject,
          bodyText: origBody,
        },
        mode: "forward",
      });
      const materializedAtts = await materializeAttachments(attachments);
      const { raw } = buildMimeMessage({
        to,
        subject: fwdSubject,
        body: composed.body,
        bodyFormat: composed.bodyFormat,
        attachments: materializedAtts,
        // Forwards don't use In-Reply-To; they start their own thread.
      });
      const sent = await googleRequest<{ id: string; threadId: string }>({
        api: "gmail",
        path: "/users/me/messages/send",
        method: "POST",
        body: { raw },
      });
      return ok({ sent: true, id: sent.id, thread_id: sent.threadId });
    },
  );

  // ----- WRITE: labels / move / mark / flag / delete -----

  server.tool(
    "mail_move",
    "Move a message to another folder. Gmail equivalent: add the destination label and remove INBOX. Documented for outlook-mcp parity — for full control use mail_apply_labels.",
    {
      id: z.string(),
      destination: z.string().describe("Outlook-style well-known name (archive, trash, spam, ...) or Gmail label id"),
    },
    async ({ id, destination }) => {
      const lower = destination.toLowerCase();
      if (lower === "archive") {
        await googleRequest({
          api: "gmail",
          path: `/users/me/messages/${encodeURIComponent(id)}/modify`,
          method: "POST",
          body: { removeLabelIds: ["INBOX"] },
        });
        return ok({ moved: true });
      }
      const dest = resolveLabel(destination);
      // For special destinations TRASH/SPAM use the dedicated endpoints so they
      // behave like outlook's move (which has audit/recovery semantics).
      if (dest === "TRASH") {
        await googleRequest({
          api: "gmail",
          path: `/users/me/messages/${encodeURIComponent(id)}/trash`,
          method: "POST",
        });
        return ok({ moved: true, destination: "TRASH" });
      }
      await googleRequest({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(id)}/modify`,
        method: "POST",
        body: { addLabelIds: [dest], removeLabelIds: ["INBOX"] },
      });
      return ok({ moved: true });
    },
  );

  server.tool(
    "mail_mark_read",
    "Mark a message as read (removes the UNREAD label).",
    { id: z.string() },
    async ({ id }) => {
      await googleRequest({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(id)}/modify`,
        method: "POST",
        body: { removeLabelIds: ["UNREAD"] },
      });
      return ok({ updated: true });
    },
  );

  server.tool(
    "mail_mark_unread",
    "Mark a message as unread (adds the UNREAD label).",
    { id: z.string() },
    async ({ id }) => {
      await googleRequest({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(id)}/modify`,
        method: "POST",
        body: { addLabelIds: ["UNREAD"] },
      });
      return ok({ updated: true });
    },
  );

  server.tool(
    "mail_flag",
    "Set the follow-up flag on a message. Gmail has STARRED only — outlook's `flagged` and `complete` both map to add-STARRED; `notFlagged` removes it.",
    {
      id: z.string(),
      flag_status: z.enum(["notFlagged", "flagged", "complete"]),
    },
    async ({ id, flag_status }) => {
      const add = flag_status !== "notFlagged" ? ["STARRED"] : [];
      const remove = flag_status === "notFlagged" ? ["STARRED"] : [];
      await googleRequest({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(id)}/modify`,
        method: "POST",
        body: { addLabelIds: add, removeLabelIds: remove },
      });
      return ok({ updated: true });
    },
  );

  server.tool(
    "mail_delete",
    "Move a message to TRASH (recoverable for ~30 days; matches outlook's soft-delete).",
    { id: z.string() },
    async ({ id }) => {
      await googleRequest({
        api: "gmail",
        path: `/users/me/messages/${encodeURIComponent(id)}/trash`,
        method: "POST",
      });
      return ok({ deleted: true });
    },
  );

  // ----- LISTEN -----

  server.tool(
    "mail_listen_inbox",
    "Wait for new email to arrive in the inbox (long-poll). Uses Gmail's history API for delta-accurate detection. Blocks up to `timeout_seconds`; returns as soon as one or more new messages arrive, or on timeout. Pass `next_token` from the previous response to resume seamlessly. If your stored token is older than ~1 week, Google returns 404 and we reseed from the current historyId (some messages may be missed in the gap — caller is informed via `reseeded: true`).",
    {
      since_token: z
        .string()
        .optional()
        .describe(
          "history_id from a previous call's `next_token`. If omitted, starts watching from 'now' — only future arrivals will be returned.",
        ),
      timeout_seconds: z.number().int().min(5).max(300).default(60),
      poll_interval_seconds: z.number().int().min(2).max(60).default(10),
      max_results: z.number().int().min(1).max(100).default(25),
    },
    async ({ since_token, timeout_seconds, poll_interval_seconds, max_results }) => {
      let cursor = since_token;
      let reseeded = false;
      if (!cursor) {
        const prof = await googleRequest<{ historyId?: string }>({
          api: "gmail",
          path: "/users/me/profile",
        });
        cursor = prof.historyId ?? undefined;
        if (!cursor) {
          return ok({ new_messages: [], next_token: null, timed_out: true, reseeded: false });
        }
      }
      const deadline = Date.now() + timeout_seconds * 1000;
      while (true) {
        let page: HistoryPage;
        try {
          page = await googleRequest<HistoryPage>({
            api: "gmail",
            path: "/users/me/history",
            query: {
              startHistoryId: cursor!,
              labelId: "INBOX",
              historyTypes: ["messageAdded"],
              maxResults: max_results,
            },
          });
        } catch (e) {
          if (e instanceof GoogleError && e.status === 404) {
            // History too old — reseed and report.
            const prof = await googleRequest<{ historyId?: string }>({
              api: "gmail",
              path: "/users/me/profile",
            });
            cursor = prof.historyId ?? cursor;
            reseeded = true;
            page = { history: [], historyId: cursor };
          } else {
            throw e;
          }
        }
        const added: string[] = [];
        for (const h of page.history ?? []) {
          for (const ma of h.messagesAdded ?? []) {
            const msgLabels = ma.message?.labelIds ?? [];
            if (msgLabels.includes("INBOX") && ma.message?.id) added.push(ma.message.id);
          }
          if (added.length >= max_results) break;
        }
        if (added.length > 0) {
          const enriched = await enrichMessages(added.slice(0, max_results), "metadata");
          return ok({
            new_messages: enriched.map(compactMessageFromHeaders),
            next_token: page.historyId ?? cursor ?? null,
            timed_out: false,
            reseeded,
          });
        }
        if (page.historyId) cursor = page.historyId;
        if (Date.now() >= deadline) {
          return ok({
            new_messages: [],
            next_token: cursor ?? null,
            timed_out: true,
            reseeded,
          });
        }
        await new Promise((r) => setTimeout(r, poll_interval_seconds * 1000));
      }
    },
  );

  // ----- LISTEN INSTRUCTIONS (Monitor handoff) -----

  server.tool(
    "mail_listen_instructions",
    "Returns the exact Monitor() invocation needed to start a persistent INBOX listener (long-poll over Gmail's history API). The listener path is resolved from this server's own install location, so the caller does not need to know where the package lives. Pass the returned `monitor` object directly to Claude Code's Monitor tool. Each stdout line is one JSON message event (same compact shape as `mail_list`). Pass `thread_id` to filter server-side to one thread — that's the 'watch for replies to a specific email' pattern (look up the email's thread_id via `mail_get` first). For a full firehose, omit `thread_id` and the caller can post-filter however it likes.",
    {
      thread_id: z
        .string()
        .optional()
        .describe(
          "Optional Gmail threadId. When set, the listener only emits messages whose threadId matches — use this to watch for replies to one specific email. Filter is applied server-side before the metadata fetch, so non-matching arrivals are nearly free.",
        ),
      poll_interval_seconds: z
        .number()
        .int()
        .min(5)
        .max(60)
        .optional()
        .describe("How often the listener calls history.list. Default 10."),
    },
    async ({ thread_id, poll_interval_seconds }) => {
      // src/tools/mail.ts → ../../scripts/gmail-listen.ts
      const here = dirname(fileURLToPath(import.meta.url));
      const listenerPath = resolve(here, "..", "..", "scripts", "gmail-listen.ts");
      const listenerExists = existsSync(listenerPath);

      // Monitor strips env from spawned children; bake the gmail-mcp config
      // env vars inline so the listener can reach the same OAuth client +
      // token cache as the server. Tokens themselves stay on disk
      // (~/.config/gmail-mcp/tokens-<profile>.json, 0600) — only the path
      // hints land on the command line.
      const envParts: string[] = [];
      const credsFile = process.env.GMAIL_MCP_CREDENTIALS_FILE;
      const profile = process.env.GMAIL_MCP_PROFILE;
      const tokenPath = process.env.GMAIL_MCP_TOKEN_PATH;
      if (credsFile) envParts.push(`GMAIL_MCP_CREDENTIALS_FILE=${shellQuote(credsFile)}`);
      if (profile) envParts.push(`GMAIL_MCP_PROFILE=${shellQuote(profile)}`);
      if (tokenPath) envParts.push(`GMAIL_MCP_TOKEN_PATH=${shellQuote(tokenPath)}`);

      const flags: string[] = [];
      if (thread_id) flags.push(`--thread-id=${shellQuote(thread_id)}`);
      if (poll_interval_seconds) flags.push(`--poll=${poll_interval_seconds}`);

      const command = [
        ...envParts,
        "bun",
        shellQuote(listenerPath),
        ...flags,
      ].join(" ");

      return ok({
        monitor: {
          command,
          description: thread_id ? `Gmail thread ${thread_id}` : "Gmail inbox",
          persistent: true,
          timeout_ms: 3600000,
        },
        listener_path: listenerPath,
        listener_exists: listenerExists,
        profile: profile ?? null,
        notes: [
          "Each stdout line is one JSON message event with the same shape as `mail_list` entries (id, thread_id, subject, from, to, cc, snippet, labels, history_id, …).",
          "Stderr is diagnostics — connection banner, reseed events, transient errors.",
          "Cursor is delta-accurate via Gmail's history API. On reconnect within ~7 days no messages are missed; if the cursor goes stale (404) the listener reseeds and logs a `reseeded` warning to stderr — a gap may have been missed in that window.",
          thread_id
            ? `Filtering server-side to thread_id=${thread_id}. Other arrivals are silently dropped before the metadata fetch.`
            : "Firehose mode (no thread filter). To watch for replies to a specific email instead, call this tool again with `thread_id` set to that email's threadId (look it up via `mail_get`).",
          "Env vars (GMAIL_MCP_CREDENTIALS_FILE / GMAIL_MCP_PROFILE / GMAIL_MCP_TOKEN_PATH) are baked into the command line because Monitor spawns children with a stripped env. Tokens themselves stay on disk in ~/.config/gmail-mcp/, not on the command line.",
        ],
      });
    },
  );
}

function shellQuote(s: string): string {
  // Single-quote everything; escape any embedded single quote by closing,
  // inserting an escaped quote, and reopening. Safe for arbitrary paths.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------- helpers used by reply tools ----------

interface GmailLabel {
  id?: string;
  name?: string;
  type?: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  labelListVisibility?: string;
  messageListVisibility?: string;
  color?: { textColor?: string; backgroundColor?: string };
}

interface HistoryRecord {
  id?: string;
  messagesAdded?: { message?: { id?: string; threadId?: string; labelIds?: string[] } }[];
}

interface HistoryPage {
  history?: HistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
}

async function sendReply(args: {
  id: string;
  body: string | undefined;
  bodyFormat: "text" | "html";
  comment: string | undefined;
  all: boolean;
  override?: { to?: Recipient[]; cc?: Recipient[]; bcc?: Recipient[] };
  attachments?: AttachmentInput[];
  includeSignature?: boolean;
}): Promise<{ id: string; threadId: string; warnings: string[] }> {
  const original = await googleRequest<GmailMessage>({
    api: "gmail",
    path: `/users/me/messages/${encodeURIComponent(args.id)}`,
    query: { format: "full" },
  });
  const origSubject = getHeader(original.payload, "Subject") ?? "";
  const origFrom = parseAddress(getHeader(original.payload, "From") ?? "");
  const origTo = parseAddressList(getHeader(original.payload, "To"));
  const origCc = parseAddressList(getHeader(original.payload, "Cc"));
  const origMessageId =
    getHeader(original.payload, "Message-ID") ?? getHeader(original.payload, "Message-Id");
  const origReferences = getHeader(original.payload, "References");
  const origDate = getHeader(original.payload, "Date");
  const origBody = extractBody(original.payload, "text").content;

  const replySubject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;

  // Determine "me" for SENT-detection and self-filtering.
  let me: string | null = null;
  try {
    const prof = await googleRequest<{ emailAddress?: string }>({
      api: "gmail",
      path: "/users/me/profile",
    });
    me = prof.emailAddress?.toLowerCase() ?? null;
  } catch {
    // best-effort
  }

  const resolved = resolveReplyRecipients({
    from: origFrom,
    to: origTo,
    cc: origCc,
    me,
    all: args.all,
    override: args.override,
  });

  const references = origReferences
    ? `${origReferences} ${origMessageId ?? ""}`.trim()
    : origMessageId ?? undefined;

  const sig = wantSignature(args.includeSignature) ? await getAccountSignature() : null;
  const composed = composeQuotedBodyWithSignature({
    comment: args.comment,
    bodyOverride: args.body,
    bodyFormat: args.bodyFormat,
    signatureHtml: sig,
    original: {
      from: origFrom.email ?? null,
      date: origDate,
      subject: origSubject,
      bodyText: origBody,
    },
    mode: "reply",
  });

  const materializedAtts = await materializeAttachments(args.attachments);

  const { raw } = buildMimeMessage({
    to: resolved.to,
    cc: resolved.cc.length ? resolved.cc : undefined,
    bcc: resolved.bcc && resolved.bcc.length ? resolved.bcc : undefined,
    subject: replySubject,
    body: composed.body,
    bodyFormat: composed.bodyFormat,
    inReplyTo: origMessageId ?? undefined,
    references,
    attachments: materializedAtts,
  });

  const sent = await googleRequest<{ id: string; threadId: string }>({
    api: "gmail",
    path: "/users/me/messages/send",
    method: "POST",
    body: { raw, threadId: original.threadId },
  });
  return { id: sent.id, threadId: sent.threadId, warnings: resolved.warnings };
}

// Pure recipient-resolution helper for reply / reply-all. Exported for unit
// testing.
//
// Heuristic: when the message being replied to was sent by the caller
// (`from.email == me`), continue the thread *to the other party* — resolve
// To from the original recipients minus self, not from the sender. Without
// this, mail_reply on one of your own sent messages addresses the reply
// back to yourself.
//
// Caller can short-circuit the heuristic by passing any of `override.to`,
// `override.cc`, `override.bcc`. When set, the override list is used as-is
// (overrides are not merged with heuristic results).
//
// Returns a `warnings` array; non-empty when the resolved To still includes
// the caller's own address. Caller decides whether to surface, abort, etc.
export function resolveReplyRecipients(args: {
  from: { email: string | null; name: string | null };
  to: { email: string | null; name: string | null }[];
  cc: { email: string | null; name: string | null }[];
  me: string | null;
  all: boolean;
  override?: { to?: Recipient[]; cc?: Recipient[]; bcc?: Recipient[] };
}): { to: Recipient[]; cc: Recipient[]; bcc?: Recipient[]; warnings: string[] } {
  const me = args.me?.toLowerCase() ?? null;
  const warnings: string[] = [];

  const dedupe = (list: Recipient[]): Recipient[] => {
    const seen = new Set<string>();
    return list.filter((r) => {
      const k = r.email.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const toRecipient = (a: { email: string | null; name: string | null }): Recipient | null =>
    a.email ? { email: a.email, ...(a.name ? { name: a.name } : {}) } : null;

  const notSelf = (r: Recipient): boolean => !me || r.email.toLowerCase() !== me;

  const overrideUsed = Boolean(
    args.override && (args.override.to || args.override.cc || args.override.bcc),
  );

  let to: Recipient[];
  let cc: Recipient[];
  let bcc: Recipient[] | undefined;

  if (overrideUsed) {
    to = dedupe(args.override!.to ?? []);
    cc = dedupe(args.override!.cc ?? []);
    bcc = args.override!.bcc ? dedupe(args.override!.bcc) : undefined;
  } else {
    const fromIsSelf = !!me && args.from.email?.toLowerCase() === me;
    if (fromIsSelf) {
      // Continue this thread to the other party.
      const recipients = args.to
        .map(toRecipient)
        .filter((r): r is Recipient => r !== null)
        .filter(notSelf);
      to = dedupe(recipients);
      if (args.all) {
        const ccRecipients = args.cc
          .map(toRecipient)
          .filter((r): r is Recipient => r !== null)
          .filter(notSelf);
        cc = dedupe(ccRecipients);
      } else {
        cc = [];
      }
      // Sent-to-self-only: nothing left after filtering. Fall back to the
      // sender (still self) so we don't produce an empty To.
      if (to.length === 0) {
        const fallback = toRecipient(args.from);
        if (fallback) to = [fallback];
      }
    } else {
      const replyTo = toRecipient(args.from);
      to = replyTo ? [replyTo] : [];
      if (args.all) {
        const fromEmail = args.from.email?.toLowerCase() ?? null;
        const merged = [...args.to, ...args.cc]
          .map(toRecipient)
          .filter((r): r is Recipient => r !== null)
          .filter(notSelf)
          .filter((r) => !fromEmail || r.email.toLowerCase() !== fromEmail);
        cc = dedupe(merged);
      } else {
        cc = [];
      }
    }
  }

  if (me && to.some((r) => r.email.toLowerCase() === me)) {
    const list = to.map((r) => r.email).join(", ");
    warnings.push(
      `reply will be sent to [${list}] — your own address; pass an explicit 'to' override to send elsewhere`,
    );
  }

  return { to, cc, ...(bcc !== undefined ? { bcc } : {}), warnings };
}

function collectParticipants(msgs: GmailMessage[]): { email: string; name: string | null }[] {
  const seen = new Map<string, { email: string; name: string | null }>();
  for (const m of msgs) {
    for (const hdr of ["From", "To", "Cc"]) {
      const v = getHeader(m.payload, hdr);
      for (const a of parseAddressList(v)) {
        if (!a.email) continue;
        const k = a.email.toLowerCase();
        if (!seen.has(k)) seen.set(k, { email: a.email, name: a.name });
      }
    }
  }
  return [...seen.values()];
}

// Re-export for tests / external use; silences unused-import warnings.
export { base64urlEncode, base64urlToStandardBase64 };
export { attachmentSchema, materializeAttachments };
export type { AttachmentInput, MaterializedAttachment };
