import { describe, test, expect } from "bun:test";
import {
  buildMimeMessage,
  composeQuotedBody,
  composeQuotedBodyWithSignature,
  extractAttachments,
  extractBody,
  getHeader,
  parseAddress,
  parseAddressList,
  plainTextToHtml,
  withSignature,
} from "../src/google/mime.ts";
import { base64urlDecodeToBuffer } from "../src/tools/helpers.ts";

function decodeRaw(raw: string): string {
  return base64urlDecodeToBuffer(raw).toString("utf8");
}

describe("parseAddress / parseAddressList", () => {
  test("bare email", () => {
    expect(parseAddress("alice@example.com")).toEqual({ email: "alice@example.com", name: null });
  });

  test("Name <email>", () => {
    expect(parseAddress("Alice <alice@example.com>")).toEqual({
      email: "alice@example.com",
      name: "Alice",
    });
  });

  test('quoted "Last, First" <email>', () => {
    expect(parseAddress('"Doe, Jane" <jane@example.com>')).toEqual({
      email: "jane@example.com",
      name: "Doe, Jane",
    });
  });

  test("address list splits on top-level commas only", () => {
    const list = parseAddressList(
      '"Doe, Jane" <jane@example.com>, bob@example.com, "C, D" <cd@example.com>',
    );
    expect(list).toEqual([
      { email: "jane@example.com", name: "Doe, Jane" },
      { email: "bob@example.com", name: null },
      { email: "cd@example.com", name: "C, D" },
    ]);
  });

  test("null returns empty", () => {
    expect(parseAddressList(null)).toEqual([]);
  });
});

describe("buildMimeMessage", () => {
  test("text body, no attachments", () => {
    const { raw } = buildMimeMessage({
      to: [{ email: "alice@example.com", name: "Alice" }],
      subject: "Hello",
      body: "Hi there.",
      bodyFormat: "text",
    });
    const decoded = decodeRaw(raw);
    expect(decoded).toContain("To: Alice <alice@example.com>");
    expect(decoded).toContain("Subject: Hello");
    expect(decoded).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(decoded).toContain("Content-Transfer-Encoding: base64");
    // body is base64-encoded "Hi there." = SGkgdGhlcmUu
    expect(decoded).toContain("SGkgdGhlcmUu");
  });

  test("Cc and Bcc included", () => {
    const { raw } = buildMimeMessage({
      to: [{ email: "a@x.com" }],
      cc: [{ email: "b@x.com" }],
      bcc: [{ email: "c@x.com" }],
      subject: "S",
      body: "B",
      bodyFormat: "text",
    });
    const decoded = decodeRaw(raw);
    expect(decoded).toContain("To: a@x.com");
    expect(decoded).toContain("Cc: b@x.com");
    expect(decoded).toContain("Bcc: c@x.com");
  });

  test("HTML body sets content-type accordingly", () => {
    const { raw } = buildMimeMessage({
      to: [{ email: "a@x.com" }],
      subject: "S",
      body: "<b>hi</b>",
      bodyFormat: "html",
    });
    expect(decodeRaw(raw)).toContain("Content-Type: text/html; charset=UTF-8");
  });

  test("threading headers", () => {
    const { raw } = buildMimeMessage({
      to: [{ email: "a@x.com" }],
      subject: "Re: hi",
      body: "thanks",
      bodyFormat: "text",
      inReplyTo: "<orig-123@example.com>",
      references: "<root@example.com> <orig-123@example.com>",
    });
    const decoded = decodeRaw(raw);
    expect(decoded).toContain("In-Reply-To: <orig-123@example.com>");
    expect(decoded).toContain("References: <root@example.com> <orig-123@example.com>");
  });

  test("attachments build multipart/mixed", () => {
    const { raw } = buildMimeMessage({
      to: [{ email: "a@x.com" }],
      subject: "S",
      body: "see attached",
      bodyFormat: "text",
      attachments: [
        {
          name: "file.txt",
          content_type: "text/plain",
          content_base64: Buffer.from("hello attachment").toString("base64"),
        },
      ],
    });
    const decoded = decodeRaw(raw);
    expect(decoded).toMatch(/Content-Type: multipart\/mixed; boundary="[^"]+"/);
    expect(decoded).toContain('Content-Disposition: attachment; filename="file.txt"');
    expect(decoded).toContain("Content-Type: text/plain; name=\"file.txt\"");
  });

  test("non-ASCII subject is RFC2047-encoded", () => {
    const { raw } = buildMimeMessage({
      to: [{ email: "a@x.com" }],
      subject: "Olá Mundo",
      body: "x",
      bodyFormat: "text",
    });
    const decoded = decodeRaw(raw);
    expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });
});

describe("composeQuotedBody", () => {
  test("reply with comment prepends text and quotes the body with > prefixes", () => {
    const out = composeQuotedBody({
      comment: "Looks good.",
      bodyOverride: undefined,
      bodyFormat: "text",
      original: {
        from: "Alice <alice@x.com>",
        date: "Wed, 13 May 2026 10:00:00 -0300",
        subject: "Hi",
        bodyText: "first line\nsecond line",
      },
      mode: "reply",
    });
    expect(out).toContain("Looks good.");
    expect(out).toContain("On Wed, 13 May 2026 10:00:00 -0300, Alice <alice@x.com> wrote:");
    expect(out).toContain("> first line");
    expect(out).toContain("> second line");
  });

  test("forward uses forwarded-message header", () => {
    const out = composeQuotedBody({
      comment: undefined,
      bodyOverride: "fyi",
      bodyFormat: "text",
      original: {
        from: "Bob <bob@x.com>",
        date: "Wed, 13 May 2026 10:00:00 -0300",
        subject: "Original",
        bodyText: "see this",
      },
      mode: "forward",
    });
    expect(out).toContain("fyi");
    expect(out).toContain("---------- Forwarded message ----------");
    expect(out).toContain("From: Bob <bob@x.com>");
    expect(out).toContain("Subject: Original");
    expect(out).toContain("> see this");
  });

  test("html mode escapes < and wraps in blockquote", () => {
    const out = composeQuotedBody({
      comment: "ok",
      bodyOverride: undefined,
      bodyFormat: "html",
      original: {
        from: "a@x.com",
        date: "now",
        subject: "S",
        bodyText: "<script>x</script>",
      },
      mode: "reply",
    });
    expect(out).toContain("blockquote");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });
});

describe("withSignature", () => {
  test("no signature is a no-op (body + format unchanged)", () => {
    expect(withSignature({ body: "hi", bodyFormat: "text", signatureHtml: null })).toEqual({
      body: "hi",
      bodyFormat: "text",
    });
    expect(withSignature({ body: "hi", bodyFormat: "text", signatureHtml: "   " })).toEqual({
      body: "hi",
      bodyFormat: "text",
    });
  });

  test("html body: signature appended, format stays html", () => {
    const out = withSignature({
      body: "<p>hello</p>",
      bodyFormat: "html",
      signatureHtml: "<b>Me</b>",
    });
    expect(out.bodyFormat).toBe("html");
    expect(out.body).toContain("<p>hello</p>");
    expect(out.body).toContain("<b>Me</b>");
    expect(out.body.indexOf("<p>hello</p>")).toBeLessThan(out.body.indexOf("<b>Me</b>"));
  });

  test("text body auto-upgrades to html and escapes the body", () => {
    const out = withSignature({
      body: "a < b\nnext",
      bodyFormat: "text",
      signatureHtml: "<b>Me</b>",
    });
    expect(out.bodyFormat).toBe("html");
    expect(out.body).toContain("a &lt; b");
    expect(out.body).toContain("<br>"); // newline became a break
    expect(out.body).toContain("<b>Me</b>");
    expect(out.body).not.toContain("a < b"); // raw text was escaped
  });
});

describe("plainTextToHtml", () => {
  test("escapes &, <, > and converts newlines to <br>", () => {
    expect(plainTextToHtml("a & b < c > d\ne")).toBe("a &amp; b &lt; c &gt; d<br>e");
  });
});

describe("composeQuotedBodyWithSignature", () => {
  const original = {
    from: "Alice <alice@x.com>",
    date: "Wed, 13 May 2026 10:00:00 -0300",
    subject: "Hi",
    bodyText: "first line\nsecond line",
  };

  test("no signature → behaves like composeQuotedBody (text quote preserved)", () => {
    const out = composeQuotedBodyWithSignature({
      comment: "Looks good.",
      bodyOverride: undefined,
      bodyFormat: "text",
      signatureHtml: null,
      original,
      mode: "reply",
    });
    expect(out.bodyFormat).toBe("text");
    expect(out.body).toContain("Looks good.");
    expect(out.body).toContain("> first line");
  });

  test("with signature → upgrades to html, signature sits above the quote", () => {
    const out = composeQuotedBodyWithSignature({
      comment: "Looks good.",
      bodyOverride: undefined,
      bodyFormat: "text",
      signatureHtml: "<b>Me</b>",
      original,
      mode: "reply",
    });
    expect(out.bodyFormat).toBe("html");
    expect(out.body).toContain("Looks good.");
    expect(out.body).toContain("<b>Me</b>");
    expect(out.body).toContain("blockquote"); // original is html-quoted now
    // signature comes before the quoted original
    expect(out.body.indexOf("<b>Me</b>")).toBeLessThan(out.body.indexOf("blockquote"));
  });
});

describe("extractBody / extractAttachments / getHeader on Gmail payload tree", () => {
  // Synthetic Gmail payload tree: multipart/alternative (text + html) + an attachment.
  const samplePayload = {
    mimeType: "multipart/mixed",
    headers: [
      { name: "Subject", value: "S" },
      { name: "From", value: "Alice <alice@x.com>" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/plain",
            body: { size: 12, data: Buffer.from("hello world").toString("base64url") },
          },
          {
            mimeType: "text/html",
            body: { size: 30, data: Buffer.from("<p>hello world</p>").toString("base64url") },
          },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "doc.pdf",
        headers: [{ name: "Content-Disposition", value: 'attachment; filename="doc.pdf"' }],
        body: { size: 4096, attachmentId: "att-123" },
      },
    ],
  };

  test("extractBody text preference", () => {
    const r = extractBody(samplePayload, "text");
    expect(r.format).toBe("text");
    expect(r.content).toBe("hello world");
  });

  test("extractBody html preference", () => {
    const r = extractBody(samplePayload, "html");
    expect(r.format).toBe("html");
    expect(r.content).toBe("<p>hello world</p>");
  });

  test("extractAttachments returns metadata, not the body parts", () => {
    const atts = extractAttachments(samplePayload);
    expect(atts).toEqual([
      {
        id: "att-123",
        name: "doc.pdf",
        content_type: "application/pdf",
        size: 4096,
        is_inline: false,
      },
    ]);
  });

  test("getHeader is case-insensitive", () => {
    expect(getHeader(samplePayload, "subject")).toBe("S");
    expect(getHeader(samplePayload, "FROM")).toBe("Alice <alice@x.com>");
    expect(getHeader(samplePayload, "missing")).toBeNull();
  });
});
