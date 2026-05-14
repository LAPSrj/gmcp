import { z } from "zod";
import { writeFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { googleRequest, googleList, GoogleError } from "../google/client.ts";
import {
  ok,
  base64urlEncode,
  base64urlToStandardBase64,
  base64urlDecodeToBuffer,
  type Recipient,
} from "./helpers.ts";
import {
  buildMimeMessage,
  composeQuotedBody,
  extractAttachments,
  extractBody,
  getHeader,
  parseAddress,
  parseAddressList,
  type GmailMessage,
} from "../google/mime.ts";

// ---------- Shared schemas ----------

const recipientSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

const attachmentSchema = z.object({
  name: z.string().describe("File name with extension"),
  content_type: z.string().default("application/octet-stream"),
  content_base64: z.string().describe("Base64-encoded file content (standard base64, not base64url)"),
});

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
      return ok(compacts);
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
      return ok(enriched.map(compactMessageFromHeaders));
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
    "Download an email attachment. Returns base64 by default, or writes to output_path if provided.",
    {
      message_id: z.string(),
      attachment_id: z.string(),
      output_path: z.string().optional().describe("Absolute path to write the file. If omitted, returns base64."),
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

  const composeShape = {
    to: z.array(recipientSchema).min(1),
    cc: z.array(recipientSchema).optional(),
    bcc: z.array(recipientSchema).optional(),
    subject: z.string(),
    body: z.string(),
    body_format: z.enum(["text", "html"]).default("text"),
    attachments: z.array(attachmentSchema).optional(),
  } as const;

  server.tool(
    "mail_send",
    "Compose and send an email immediately. Note: Gmail always saves a copy to SENT; the save_to_sent flag is accepted for outlook parity but has no effect.",
    { ...composeShape, save_to_sent: z.boolean().default(true) },
    async (args) => {
      const { raw } = buildMimeMessage({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        bodyFormat: args.body_format,
        attachments: args.attachments,
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
    "Create a draft email (not sent). Returns the draft id.",
    composeShape,
    async (args) => {
      const { raw } = buildMimeMessage({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        bodyFormat: args.body_format,
        attachments: args.attachments,
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
    "Update fields on an existing draft. The draft is fully replaced — pass all the fields you want it to have.",
    {
      id: z.string(),
      to: z.array(recipientSchema).optional(),
      cc: z.array(recipientSchema).optional(),
      bcc: z.array(recipientSchema).optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      body_format: z.enum(["text", "html"]).default("text"),
      attachments: z.array(attachmentSchema).optional(),
    },
    async ({ id, to, cc, bcc, subject, body, body_format, attachments }) => {
      const { raw } = buildMimeMessage({
        to: to ?? [{ email: "" }], // Gmail accepts empty fields in a draft; caller should refill
        cc,
        bcc,
        subject: subject ?? "",
        body: body ?? "",
        bodyFormat: body_format,
        attachments,
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
    "Reply to a message. Provide `body` for a fully custom body, or `comment` for a note above the quoted original. Threading headers (In-Reply-To, References, threadId) are set automatically.",
    {
      id: z.string(),
      body: z.string().optional(),
      body_format: z.enum(["text", "html"]).default("text"),
      comment: z.string().optional(),
    },
    async ({ id, body, body_format, comment }) => {
      const sentId = await sendReply({
        id,
        body,
        bodyFormat: body_format,
        comment,
        all: false,
      });
      return ok({ sent: true, id: sentId.id, thread_id: sentId.threadId });
    },
  );

  server.tool(
    "mail_reply_all",
    "Reply-all to a message — preserves To/Cc of the original.",
    {
      id: z.string(),
      body: z.string().optional(),
      body_format: z.enum(["text", "html"]).default("text"),
      comment: z.string().optional(),
    },
    async ({ id, body, body_format, comment }) => {
      const sentId = await sendReply({
        id,
        body,
        bodyFormat: body_format,
        comment,
        all: true,
      });
      return ok({ sent: true, id: sentId.id, thread_id: sentId.threadId });
    },
  );

  server.tool(
    "mail_forward",
    "Forward a message to new recipients.",
    {
      id: z.string(),
      to: z.array(recipientSchema).min(1),
      comment: z.string().optional(),
    },
    async ({ id, to, comment }) => {
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
      const composed = composeQuotedBody({
        comment,
        bodyOverride: undefined,
        bodyFormat: "text",
        original: {
          from: origFrom,
          date: origDate,
          subject: origSubject,
          bodyText: origBody,
        },
        mode: "forward",
      });
      const { raw } = buildMimeMessage({
        to,
        subject: fwdSubject,
        body: composed,
        bodyFormat: "text",
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
}): Promise<{ id: string; threadId: string }> {
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

  // Determine "me" for reply-all so we don't include ourselves in To/Cc.
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

  const replyTo: Recipient[] = origFrom.email
    ? [{ email: origFrom.email, ...(origFrom.name ? { name: origFrom.name } : {}) }]
    : [];
  let replyCc: Recipient[] = [];
  if (args.all) {
    const merged = [...origTo, ...origCc]
      .filter((a) => a.email && a.email.toLowerCase() !== me && a.email.toLowerCase() !== origFrom.email?.toLowerCase())
      .map((a) => ({ email: a.email!, ...(a.name ? { name: a.name } : {}) }));
    // dedupe by email
    const seen = new Set<string>();
    replyCc = merged.filter((r) => {
      const k = r.email.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  const references = origReferences
    ? `${origReferences} ${origMessageId ?? ""}`.trim()
    : origMessageId ?? undefined;

  const composedBody = composeQuotedBody({
    comment: args.comment,
    bodyOverride: args.body,
    bodyFormat: args.bodyFormat,
    original: {
      from: origFrom.email ?? null,
      date: origDate,
      subject: origSubject,
      bodyText: origBody,
    },
    mode: "reply",
  });

  const { raw } = buildMimeMessage({
    to: replyTo,
    cc: replyCc.length ? replyCc : undefined,
    subject: replySubject,
    body: composedBody,
    bodyFormat: args.bodyFormat,
    inReplyTo: origMessageId ?? undefined,
    references,
  });

  const sent = await googleRequest<{ id: string; threadId: string }>({
    api: "gmail",
    path: "/users/me/messages/send",
    method: "POST",
    body: { raw, threadId: original.threadId },
  });
  return sent;
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
