import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub googleRequest before importing the tool module. The size-gate logic
// is plain arithmetic — the only thing we need from the network layer is a
// deterministic attachment payload of a given size.
const requestQueue: Array<() => unknown> = [];
mock.module("../src/google/client.ts", () => ({
  googleRequest: async () => {
    const next = requestQueue.shift();
    if (!next) throw new Error("googleRequest called with empty queue");
    return next();
  },
  googleList: async () => [],
  GoogleError: class extends Error {},
}));

// Now safe to import — the module sees the stubbed client.
const mailMod = await import("../src/tools/mail.ts");
const sdkMod = await import("@modelcontextprotocol/sdk/server/mcp.js");
const helpersMod = await import("../src/tools/helpers.ts");

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

function freshServerWithMailTools(): RegisteredTool {
  const server = new sdkMod.McpServer({ name: "t", version: "0.0.0" });
  helpersMod.strictifyToolRegistration(server);
  mailMod.registerMailTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools.mail_get_attachment as RegisteredTool;
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gmail-mcp-attsize-"));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("mail_get_attachment size gate", () => {
  test("small attachment returns inline base64", async () => {
    const tool = freshServerWithMailTools();
    const smallBytes = Buffer.alloc(10 * 1024, 0x41); // 10 KB of 'A'
    // First call: attachment fetch.
    requestQueue.push(() => ({ size: smallBytes.length, data: base64urlEncode(smallBytes) }));
    // Second call: parent message fetch for name/contentType.
    requestQueue.push(() => ({
      payload: {
        parts: [
          {
            filename: "tiny.txt",
            mimeType: "text/plain",
            body: { attachmentId: "a1", size: smallBytes.length },
          },
        ],
      },
    }));

    const res = await tool.handler({ message_id: "m", attachment_id: "a1" }, {});
    const payload = JSON.parse(res.content[0]!.text);
    expect(res.isError).toBeFalsy();
    expect(payload.size).toBe(smallBytes.length);
    expect(payload.content_base64).toBe(smallBytes.toString("base64"));
    expect(payload.name).toBe("tiny.txt");
  });

  test("large attachment without output_path refuses with size + name in error", async () => {
    const tool = freshServerWithMailTools();
    const bigBytes = Buffer.alloc(300 * 1024, 0x42); // 300 KB — over the 200 KB cap
    requestQueue.push(() => ({ size: bigBytes.length, data: base64urlEncode(bigBytes) }));
    requestQueue.push(() => ({
      payload: {
        parts: [
          {
            filename: "photo.jpg",
            mimeType: "image/jpeg",
            body: { attachmentId: "a2", size: bigBytes.length },
          },
        ],
      },
    }));

    const res = await tool.handler({ message_id: "m", attachment_id: "a2" }, {});
    expect(res.isError).toBe(true);
    const msg = res.content[0]!.text;
    expect(msg).toContain("photo.jpg");
    expect(msg).toContain("300"); // mentions KB size
    expect(msg).toContain("output_path");
  });

  test("large attachment WITH output_path writes to disk", async () => {
    const tool = freshServerWithMailTools();
    const bigBytes = Buffer.alloc(500 * 1024, 0x43);
    requestQueue.push(() => ({ size: bigBytes.length, data: base64urlEncode(bigBytes) }));
    requestQueue.push(() => ({
      payload: {
        parts: [
          { filename: "big.bin", mimeType: "application/octet-stream", body: { attachmentId: "a3", size: bigBytes.length } },
        ],
      },
    }));

    const outPath = join(tmpDir, "saved.bin");
    const res = await tool.handler({ message_id: "m", attachment_id: "a3", output_path: outPath }, {});
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.saved_to).toBe(outPath);
    expect(payload.size).toBe(bigBytes.length);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).length).toBe(bigBytes.length);
  });

  test("strict schema rejects typoed key (save_to_path) at validateToolInput", async () => {
    const server = new sdkMod.McpServer({ name: "t", version: "0.0.0" });
    helpersMod.strictifyToolRegistration(server);
    mailMod.registerMailTools(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = (server as any)._registeredTools.mail_get_attachment;
    const schema = tool.inputSchema;
    const parsed = schema.safeParse({
      message_id: "m",
      attachment_id: "a",
      save_to_path: "/tmp/x", // typo — should reject
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain("save_to_path");
  });
});
