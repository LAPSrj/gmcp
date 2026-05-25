import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuth, resetOAuthCache } from "../src/auth/oauth.ts";

function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("getOAuth — token file reload", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gmail-mcp-reload-"));
    resetOAuthCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetOAuthCache();
  });

  test("subsequent getOAuth calls pick up new tokens when the file mtime advances", async () => {
    const credsPath = join(dir, "credentials.json");
    writeFileSync(
      credsPath,
      JSON.stringify({
        installed: { client_id: "test-client", client_secret: "test-secret" },
      }),
    );
    const tokenPath = join(dir, "tokens.json");

    // Start with one set of tokens — simulating an old expired access token.
    writeFileSync(
      tokenPath,
      JSON.stringify({
        access_token: "OLD_ACCESS",
        refresh_token: "OLD_REFRESH",
        expiry_date: 1,
      }),
    );

    await withEnv(
      {
        GMAIL_MCP_CREDENTIALS_FILE: credsPath,
        GMAIL_MCP_TOKEN_PATH: tokenPath,
        GMAIL_MCP_PROFILE: undefined,
      },
      async () => {
        const first = await getOAuth();
        expect(first.client.credentials.access_token).toBe("OLD_ACCESS");
        expect(first.client.credentials.refresh_token).toBe("OLD_REFRESH");

        // Simulate `gmail-mcp-auth wait` persisting new tokens to disk while
        // the server keeps running. Bump mtime explicitly — writeFileSync alone
        // may produce the same mtimeMs on fast filesystems.
        writeFileSync(
          tokenPath,
          JSON.stringify({
            access_token: "NEW_ACCESS",
            refresh_token: "NEW_REFRESH",
            expiry_date: 9999999999999,
          }),
        );
        const future = new Date(Date.now() + 10_000);
        utimesSync(tokenPath, future, future);

        // Same singleton — but the disk-stat reload kicks in.
        const second = await getOAuth();
        expect(second.client).toBe(first.client); // still the same OAuth2Client
        expect(second.client.credentials.access_token).toBe("NEW_ACCESS");
        expect(second.client.credentials.refresh_token).toBe("NEW_REFRESH");
      },
    );
  });

  test("emptied token file (logout) clears in-memory credentials too", async () => {
    const credsPath = join(dir, "credentials.json");
    writeFileSync(
      credsPath,
      JSON.stringify({
        installed: { client_id: "test-client", client_secret: "test-secret" },
      }),
    );
    const tokenPath = join(dir, "tokens.json");
    writeFileSync(
      tokenPath,
      JSON.stringify({ access_token: "A", refresh_token: "R" }),
    );

    await withEnv(
      {
        GMAIL_MCP_CREDENTIALS_FILE: credsPath,
        GMAIL_MCP_TOKEN_PATH: tokenPath,
        GMAIL_MCP_PROFILE: undefined,
      },
      async () => {
        const first = await getOAuth();
        expect(first.client.credentials.access_token).toBe("A");

        writeFileSync(tokenPath, "{}");
        const future = new Date(Date.now() + 10_000);
        utimesSync(tokenPath, future, future);

        const second = await getOAuth();
        expect(second.client.credentials.access_token).toBeFalsy();
        expect(second.client.credentials.refresh_token).toBeFalsy();
      },
    );
  });
});
