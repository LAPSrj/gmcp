import { googleRequest } from "./client.ts";

interface SendAsEntry {
  sendAsEmail?: string;
  isPrimary?: boolean;
  signature?: string;
}

let cache: { value: string | null } | undefined;

// Fetch the account's HTML signature from Gmail's sendAs settings (the primary
// send-as identity). Gmail's API does NOT auto-append signatures on send — they
// are a compose-time client feature — so we fetch and append them ourselves.
// Cached for the process lifetime: signatures change rarely and every send would
// otherwise pay an extra round-trip. Only successful fetches are cached, so a
// transient error doesn't disable signatures for the rest of the process.
// Reading sendAs is covered by the gmail.modify scope we already hold.
export async function getAccountSignature(): Promise<string | null> {
  if (cache) return cache.value;
  try {
    const res = await googleRequest<{ sendAs?: SendAsEntry[] }>({
      api: "gmail",
      path: "/users/me/settings/sendAs",
    });
    const entries = res.sendAs ?? [];
    const primary = entries.find((e) => e.isPrimary) ?? entries[0];
    const sig = primary?.signature?.trim();
    cache = { value: sig ? sig : null };
    return cache.value;
  } catch {
    return null; // not cached → retried on the next call
  }
}

// Whether to include the signature by default, from GMAIL_MCP_AUTO_SIGNATURE.
// A per-call `include_signature` arg overrides this.
export function signatureEnabledByDefault(): boolean {
  const v = process.env.GMAIL_MCP_AUTO_SIGNATURE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Resolve the effective include-signature decision: explicit per-call arg wins,
// else fall back to the env default.
export function wantSignature(arg: boolean | undefined): boolean {
  return arg ?? signatureEnabledByDefault();
}
