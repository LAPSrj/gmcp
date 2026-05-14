import { OAuth2Client } from "google-auth-library";
import { loadConfig, type Config } from "../config.ts";
import { readClientCredentials, readTokens, writeTokens } from "./store.ts";

let cached: { client: OAuth2Client; config: Config } | null = null;

// Build an OAuth2Client with credentials.json loaded, tokens loaded (if present),
// and a `tokens` listener that persists refreshed tokens back to disk.
// Caller is responsible for triggering interactive sign-in if no tokens exist.
export async function getOAuth(): Promise<{ client: OAuth2Client; config: Config }> {
  if (cached) return cached;
  const config = loadConfig();
  const { clientId, clientSecret } = await readClientCredentials(config.credentialsFile);
  const client = new OAuth2Client({ clientId, clientSecret });

  // Persist refreshed tokens. The library emits `tokens` with the NEW credentials
  // (often just access_token + expiry_date — refresh_token may be undefined on
  // refresh, so we merge with what we already have).
  client.on("tokens", (newTokens) => {
    void (async () => {
      const existing = (await readTokens(config.tokenPath)) ?? {};
      await writeTokens(config.tokenPath, { ...existing, ...newTokens });
    })();
  });

  const stored = await readTokens(config.tokenPath);
  if (stored && (stored.access_token || stored.refresh_token)) {
    client.setCredentials(stored);
  }

  cached = { client, config };
  return cached;
}

// For tests / login flow — reset the singleton.
export function resetOAuthCache(): void {
  cached = null;
}
