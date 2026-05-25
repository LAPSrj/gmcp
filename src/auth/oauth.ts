import { stat } from "node:fs/promises";
import { OAuth2Client } from "google-auth-library";
import { loadConfig, type Config } from "../config.ts";
import { readClientCredentials, readTokens, writeTokens } from "./store.ts";

interface OAuthCache {
  client: OAuth2Client;
  config: Config;
  // mtimeMs of tokens.json the last time we synced credentials with disk.
  // 0 = never loaded (or file was missing). On each getOAuth() call we stat
  // the file and reload if it advanced — that's how the long-running MCP
  // server picks up tokens written by an external `gmail-mcp-auth wait`
  // (agent-triggered re-auth) without needing a server restart.
  loadedMtime: number;
}

let cached: OAuthCache | null = null;

export async function getOAuth(): Promise<{ client: OAuth2Client; config: Config }> {
  if (cached) {
    await maybeReloadFromDisk(cached);
    return cached;
  }
  const config = loadConfig();
  const { clientId, clientSecret } = await readClientCredentials(config.credentialsFile);
  const client = new OAuth2Client({ clientId, clientSecret });

  // Persist refreshed tokens. The library emits `tokens` with the NEW credentials
  // (often just access_token + expiry_date — refresh_token may be undefined on
  // refresh, so we merge with what we already have). After writing, bump our
  // cached mtime so the disk-reload check below doesn't churn on our own write.
  client.on("tokens", (newTokens) => {
    void (async () => {
      const existing = (await readTokens(config.tokenPath)) ?? {};
      await writeTokens(config.tokenPath, { ...existing, ...newTokens });
      if (cached) {
        try {
          const s = await stat(config.tokenPath);
          cached.loadedMtime = s.mtimeMs;
        } catch {
          // ignore — best effort
        }
      }
    })();
  });

  const stored = await readTokens(config.tokenPath);
  let loadedMtime = 0;
  if (stored && (stored.access_token || stored.refresh_token)) {
    client.setCredentials(stored);
    try {
      const s = await stat(config.tokenPath);
      loadedMtime = s.mtimeMs;
    } catch {
      // ignore — keep 0; next call will pick it up if the file appears
    }
  }

  cached = { client, config, loadedMtime };
  return cached;
}

async function maybeReloadFromDisk(c: OAuthCache): Promise<void> {
  let mtimeMs: number;
  try {
    const s = await stat(c.config.tokenPath);
    mtimeMs = s.mtimeMs;
  } catch {
    // File missing — nothing to reload. (logout clears the file; subsequent
    // tools will surface "Not signed in" via getAccessToken.)
    return;
  }
  if (mtimeMs <= c.loadedMtime) return;

  const fresh = await readTokens(c.config.tokenPath);
  if (fresh && (fresh.access_token || fresh.refresh_token)) {
    c.client.setCredentials(fresh);
  } else {
    // File present but emptied (logout) — clear in-memory creds too.
    c.client.setCredentials({});
  }
  c.loadedMtime = mtimeMs;
}

// For tests / login flow — reset the singleton.
export function resetOAuthCache(): void {
  cached = null;
}
