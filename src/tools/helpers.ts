import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Wrap server.tool() so every subsequent registration gets `.strict()` applied
// to its inputSchema. Default ZodObject behavior silently strips unknown keys —
// a typoed param like `save_to_path` instead of `output_path` falls through with
// the legitimate args, hiding the bug. Strict mode rejects with the offending
// key named, surfacing the typo at the call site.
//
// Mutating the RegisteredTool's inputSchema is safe: the SDK reads it live from
// `validateToolInput` and from the tools/list manifest builder.
export function strictifyToolRegistration(server: McpServer): void {
  const orig = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: unknown[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (orig as (...a: unknown[]) => any)(...args);
    if (result && result.inputSchema instanceof z.ZodObject) {
      result.inputSchema = (result.inputSchema as z.ZodObject<z.ZodRawShape>).strict();
    }
    return result;
  };
}

export function ok(data: unknown, notice?: string): CallToolResult {
  const content: CallToolResult["content"] = [
    { type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
  ];
  // An optional advisory appended as a second text block — keeps the data block
  // at content[0] so existing callers that parse the first block are unaffected.
  // Used by the poll-detector nudge (see src/lib/poll-detector.ts).
  if (notice) content.push({ type: "text", text: notice });
  return { content };
}

export function err(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export interface Recipient {
  email: string;
  name?: string;
}

// Base64url encode/decode helpers — Gmail API uses base64url throughout.
export function base64urlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecodeToBuffer(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const std = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(std, "base64");
}

export function base64urlToStandardBase64(input: string): string {
  return base64urlDecodeToBuffer(input).toString("base64");
}
