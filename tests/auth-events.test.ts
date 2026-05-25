import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginWithEvents, type LoginEvent } from "../src/auth/login.ts";
import { resetOAuthCache } from "../src/auth/oauth.ts";

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

describe("loginWithEvents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gmail-mcp-events-"));
    resetOAuthCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetOAuthCache();
  });

  test("emits starting → auth_url → waiting_for_callback → timeout when no callback arrives", async () => {
    const credsPath = join(dir, "credentials.json");
    writeFileSync(
      credsPath,
      JSON.stringify({
        installed: { client_id: "test-client-id", client_secret: "test-secret" },
      }),
    );
    const tokenPath = join(dir, "tokens.json");

    const events: LoginEvent[] = [];
    const result = await withEnv(
      {
        GMAIL_MCP_CREDENTIALS_FILE: credsPath,
        GMAIL_MCP_TOKEN_PATH: tokenPath,
        GMAIL_MCP_PROFILE: undefined,
        GMAIL_MCP_REDIRECT_PORT: undefined,
      },
      () => loginWithEvents({ emit: (e) => events.push(e), timeoutMs: 500 }),
    );

    expect(result.reason).toBe("timeout");
    expect(result.email).toBeNull();

    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("starting");
    expect(kinds).toContain("auth_url");
    expect(kinds).toContain("waiting_for_callback");
    expect(kinds[kinds.length - 1]).toBe("timeout");

    const start = events.find((e) => e.event === "starting");
    if (start && start.event === "starting") {
      expect(start.timeout_ms).toBe(500);
      expect(start.token_path).toBe(tokenPath);
      expect(start.profile).toBeNull();
    }

    const authUrl = events.find((e) => e.event === "auth_url");
    if (authUrl && authUrl.event === "auth_url") {
      expect(authUrl.url).toContain("https://accounts.google.com/");
      expect(authUrl.url).toContain("client_id=test-client-id");
      expect(authUrl.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(authUrl.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
