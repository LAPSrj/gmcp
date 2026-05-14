import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function ok(data: unknown): CallToolResult {
  return {
    content: [
      { type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
    ],
  };
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
