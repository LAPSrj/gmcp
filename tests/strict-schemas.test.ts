import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { strictifyToolRegistration } from "../src/tools/helpers.ts";
import { attachmentSchema } from "../src/tools/mail.ts";

describe("strictifyToolRegistration", () => {
  test("registered tools reject unknown keys with the key named", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    strictifyToolRegistration(server);

    const registered = server.tool(
      "echo",
      "echo back",
      {
        output_path: z.string().optional(),
        attachment_id: z.string(),
        message_id: z.string(),
      },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );

    // After strictification, the inputSchema should be a strict ZodObject.
    expect(registered.inputSchema).toBeInstanceOf(z.ZodObject);
    const schema = registered.inputSchema as z.ZodObject<z.ZodRawShape>;
    expect(schema._def.unknownKeys).toBe("strict");

    // Parse with a typoed key — should fail and name the offending key.
    const bad = schema.safeParse({
      message_id: "m1",
      attachment_id: "a1",
      save_to_path: "/tmp/file.bin", // typo of output_path
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const msg = bad.error.message;
      expect(msg).toContain("save_to_path");
      expect(msg).toContain("unrecognized_keys");
    }

    // Valid input still parses.
    const good = schema.safeParse({
      message_id: "m1",
      attachment_id: "a1",
      output_path: "/tmp/file.bin",
    });
    expect(good.success).toBe(true);
  });

  test("nested attachmentSchema rejects typoed key like 'namee'", () => {
    // Top-level inputSchema strict only catches top-level typos. Nested
    // shared schemas (attachmentSchema, recipientSchema, calendar
    // attendee/recurrence/online-meeting) must be .strict() themselves
    // so a typo inside an attachment entry doesn't silently drop.
    const parsed = attachmentSchema.safeParse({
      namee: "foo.txt", // typo of `name`
      content_base64: Buffer.from("hi").toString("base64"),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.message).toContain("namee");
      expect(parsed.error.message).toContain("unrecognized_keys");
    }
  });

  test("attachmentSchema refinements still fire under strict", () => {
    // .strict() must not interfere with the .refine() rules — both must
    // still apply (mutual-exclusivity of content_base64/file_path; name
    // required when content_base64 is used).
    const missingName = attachmentSchema.safeParse({
      content_base64: Buffer.from("hi").toString("base64"),
    });
    expect(missingName.success).toBe(false);

    const both = attachmentSchema.safeParse({
      name: "a.txt",
      content_base64: Buffer.from("hi").toString("base64"),
      file_path: "/tmp/x",
    });
    expect(both.success).toBe(false);
  });

  test("optional/default fields still work under strict", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    strictifyToolRegistration(server);

    const t = server.tool(
      "with_defaults",
      "",
      {
        id: z.string(),
        top: z.number().int().min(1).max(100).default(25),
        unread_only: z.boolean().default(false),
      },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );

    const schema = t.inputSchema as z.ZodObject<z.ZodRawShape>;
    const parsed = schema.safeParse({ id: "1" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ id: "1", top: 25, unread_only: false });
    }
  });
});
