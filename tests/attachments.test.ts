import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentSchema,
  materializeAttachments,
  resolveReplyRecipients,
} from "../src/tools/mail.ts";
import { buildMimeMessage } from "../src/google/mime.ts";
import { base64urlDecodeToBuffer } from "../src/tools/helpers.ts";

async function withTmpFile(name: string, bytes: Buffer | string, run: (path: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "gmail-mcp-att-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  try {
    await run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("attachmentSchema validation", () => {
  test("accepts content_base64 with explicit name", () => {
    const parsed = attachmentSchema.safeParse({
      name: "file.txt",
      content_base64: Buffer.from("hi").toString("base64"),
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts file_path without name (defaults to basename later)", () => {
    const parsed = attachmentSchema.safeParse({ file_path: "/tmp/x.pdf" });
    expect(parsed.success).toBe(true);
  });

  test("rejects when both content_base64 and file_path are set", () => {
    const parsed = attachmentSchema.safeParse({
      name: "f.txt",
      content_base64: "aGk=",
      file_path: "/tmp/x.pdf",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects when neither content_base64 nor file_path is set", () => {
    const parsed = attachmentSchema.safeParse({ name: "f.txt" });
    expect(parsed.success).toBe(false);
  });

  test("rejects content_base64 without name", () => {
    const parsed = attachmentSchema.safeParse({ content_base64: "aGk=" });
    expect(parsed.success).toBe(false);
  });
});

describe("materializeAttachments", () => {
  test("reads file from disk and base64-encodes it; round-trips byte-identical through buildMimeMessage", async () => {
    const original = Buffer.from("Hello \x00 binary \xff payload!", "binary");
    await withTmpFile("greeting.bin", original, async (path) => {
      const materialized = await materializeAttachments([
        { file_path: path, content_type: "application/octet-stream" },
      ]);
      expect(materialized).toHaveLength(1);
      expect(materialized[0]!.name).toBe("greeting.bin");
      expect(materialized[0]!.content_type).toBe("application/octet-stream");
      expect(Buffer.from(materialized[0]!.content_base64, "base64").equals(original)).toBe(true);

      const { raw } = buildMimeMessage({
        to: [{ email: "a@x.com" }],
        subject: "S",
        body: "see attached",
        bodyFormat: "text",
        attachments: materialized,
      });
      const decoded = base64urlDecodeToBuffer(raw).toString("binary");
      // Find the attachment part's base64 block and decode it.
      const m = decoded.match(/Content-Disposition: attachment; filename="greeting\.bin"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--)/);
      expect(m).not.toBeNull();
      const attB64 = m![1]!.replace(/\r\n/g, "");
      expect(Buffer.from(attB64, "base64").equals(original)).toBe(true);
    });
  });

  test("name override wins over basename", async () => {
    await withTmpFile("ugly-name.txt", "x", async (path) => {
      const out = await materializeAttachments([
        { file_path: path, name: "Pretty Name.txt" },
      ]);
      expect(out[0]!.name).toBe("Pretty Name.txt");
    });
  });

  test("preserves content_base64 path unchanged", async () => {
    const out = await materializeAttachments([
      { name: "x.txt", content_base64: Buffer.from("hi").toString("base64") },
    ]);
    expect(out[0]!.name).toBe("x.txt");
    expect(Buffer.from(out[0]!.content_base64, "base64").toString("utf8")).toBe("hi");
  });

  test("rejects relative file_path", async () => {
    await expect(
      materializeAttachments([{ file_path: "relative/path.txt" }]),
    ).rejects.toThrow(/absolute/);
  });

  test("rejects file_path containing '..' segments", async () => {
    await expect(
      materializeAttachments([{ file_path: "/tmp/../etc/passwd" }]),
    ).rejects.toThrow(/'\.\.'/);
  });

  test("rejects non-existent file with a clear error mentioning the path", async () => {
    const missing = "/tmp/gmail-mcp-this-file-definitely-does-not-exist-9f8e7d.bin";
    await expect(
      materializeAttachments([{ file_path: missing }]),
    ).rejects.toThrow(/Failed to read attachment.file_path/);
  });

  test("empty / undefined input returns []", async () => {
    expect(await materializeAttachments(undefined)).toEqual([]);
    expect(await materializeAttachments([])).toEqual([]);
  });
});

describe("resolveReplyRecipients", () => {
  const alice = { email: "alice@x.com", name: "Alice" };
  const bob = { email: "bob@x.com", name: "Bob" };
  const carol = { email: "carol@x.com", name: "Carol" };
  const me = { email: "me@example.com", name: "Me" };

  test("standard reply: To = sender; Cc empty", () => {
    const r = resolveReplyRecipients({
      from: alice,
      to: [me],
      cc: [bob],
      me: me.email,
      all: false,
    });
    expect(r.to).toEqual([alice]);
    expect(r.cc).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test("standard reply-all: To = sender; Cc = origTo+origCc minus self minus sender", () => {
    const r = resolveReplyRecipients({
      from: alice,
      to: [me, bob],
      cc: [carol],
      me: me.email,
      all: true,
    });
    expect(r.to).toEqual([alice]);
    expect(r.cc).toEqual([bob, carol]);
    expect(r.warnings).toEqual([]);
  });

  test("SENT message (from == self), reply: To = origTo minus self", () => {
    const r = resolveReplyRecipients({
      from: me,
      to: [alice, bob],
      cc: [carol],
      me: me.email,
      all: false,
    });
    expect(r.to.map((x) => x.email).sort()).toEqual(["alice@x.com", "bob@x.com"]);
    expect(r.cc).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test("SENT message, reply-all: To = origTo minus self; Cc = origCc minus self", () => {
    const r = resolveReplyRecipients({
      from: me,
      to: [alice, bob, me],
      cc: [carol, me],
      me: me.email,
      all: true,
    });
    expect(r.to.map((x) => x.email).sort()).toEqual(["alice@x.com", "bob@x.com"]);
    expect(r.cc.map((x) => x.email)).toEqual(["carol@x.com"]);
    expect(r.warnings).toEqual([]);
  });

  test("SENT message with no other recipients falls back to self + warns", () => {
    const r = resolveReplyRecipients({
      from: me,
      to: [me],
      cc: [],
      me: me.email,
      all: false,
    });
    expect(r.to).toEqual([me]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/your own address/);
    expect(r.warnings[0]).toContain("me@example.com");
  });

  test("explicit to override wins over heuristic", () => {
    const r = resolveReplyRecipients({
      from: alice,
      to: [me, bob],
      cc: [carol],
      me: me.email,
      all: true,
      override: { to: [{ email: "elsewhere@x.com" }] },
    });
    expect(r.to).toEqual([{ email: "elsewhere@x.com" }]);
    expect(r.cc).toEqual([]);
  });

  test("explicit cc override wins (with empty to override) — heuristic skipped entirely", () => {
    const r = resolveReplyRecipients({
      from: alice,
      to: [bob],
      cc: [carol],
      me: me.email,
      all: true,
      override: { cc: [{ email: "audit@x.com" }] },
    });
    expect(r.to).toEqual([]);
    expect(r.cc).toEqual([{ email: "audit@x.com" }]);
  });

  test("override that resolves to self still warns", () => {
    const r = resolveReplyRecipients({
      from: alice,
      to: [bob],
      cc: [],
      me: me.email,
      all: false,
      override: { to: [me] },
    });
    expect(r.to).toEqual([me]);
    expect(r.warnings).toHaveLength(1);
  });

  test("dedupes by email (case-insensitive)", () => {
    const r = resolveReplyRecipients({
      from: alice,
      to: [bob, { email: "BOB@x.com", name: "Bob (caps)" }],
      cc: [carol, bob],
      me: me.email,
      all: true,
    });
    expect(r.to).toEqual([alice]);
    expect(r.cc.map((x) => x.email.toLowerCase()).sort()).toEqual(["bob@x.com", "carol@x.com"]);
  });

  test("no `me` known (auth lookup failed): treats from as not-self; standard reply", () => {
    const r = resolveReplyRecipients({
      from: alice,
      to: [bob],
      cc: [],
      me: null,
      all: false,
    });
    expect(r.to).toEqual([alice]);
    expect(r.warnings).toEqual([]);
  });
});

describe("attachment on reply path (integration via materializeAttachments)", () => {
  test("file_path attachment is materialized and round-trips byte-identical when fed into buildMimeMessage just like sendReply does", async () => {
    // sendReply wraps materializeAttachments + buildMimeMessage; the
    // network-touching parts (googleRequest) aren't unit-testable without
    // mocks. This test exercises the data path sendReply uses for
    // attachments.
    const original = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x7f]);
    await withTmpFile("reply-fixture.bin", original, async (path) => {
      const materialized = await materializeAttachments([
        { file_path: path, content_type: "application/octet-stream" },
      ]);
      const { raw } = buildMimeMessage({
        to: [{ email: "other@x.com" }],
        subject: "Re: hi",
        body: "see attached",
        bodyFormat: "text",
        inReplyTo: "<orig-1@example.com>",
        references: "<orig-1@example.com>",
        attachments: materialized,
      });
      const decoded = base64urlDecodeToBuffer(raw).toString("binary");
      const m = decoded.match(
        /Content-Disposition: attachment; filename="reply-fixture\.bin"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--)/,
      );
      expect(m).not.toBeNull();
      const attB64 = m![1]!.replace(/\r\n/g, "");
      expect(Buffer.from(attB64, "base64").equals(original)).toBe(true);
      expect(decoded).toContain("In-Reply-To: <orig-1@example.com>");
    });
  });
});
