import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

  test("emits starting → auth_url_ready → waiting_for_callback → timeout, writes and cleans up url file", async () => {
    const credsPath = join(dir, "credentials.json");
    writeFileSync(
      credsPath,
      JSON.stringify({
        installed: { client_id: "test-client-id", client_secret: "test-secret" },
      }),
    );
    const tokenPath = join(dir, "tokens.json");
    const urlFilePath = join(dir, "login.url");

    const events: LoginEvent[] = [];
    // Capture URL file contents at the moment the event fires — the file is
    // cleaned up on the timeout exit, so checking after-the-fact would race.
    let urlAtEventTime: string | null = null;
    const emit = (e: LoginEvent): void => {
      events.push(e);
      if (e.event === "auth_url_ready") {
        urlAtEventTime = readFileSync(e.url_file, "utf8").trim();
      }
    };

    const result = await withEnv(
      {
        GMAIL_MCP_CREDENTIALS_FILE: credsPath,
        GMAIL_MCP_TOKEN_PATH: tokenPath,
        GMAIL_MCP_PROFILE: undefined,
        GMAIL_MCP_REDIRECT_PORT: undefined,
      },
      () => loginWithEvents({ emit, timeoutMs: 500, urlFilePath }),
    );

    expect(result.reason).toBe("timeout");
    expect(result.email).toBeNull();

    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("starting");
    expect(kinds).toContain("auth_url_ready");
    expect(kinds).toContain("waiting_for_callback");
    expect(kinds[kinds.length - 1]).toBe("timeout");

    const ready = events.find((e) => e.event === "auth_url_ready");
    if (ready && ready.event === "auth_url_ready") {
      expect(ready.url_file).toBe(urlFilePath);
      expect(ready.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(ready.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    // The URL was written to the sidecar at the moment of the event.
    expect(urlAtEventTime).not.toBeNull();
    expect(urlAtEventTime ?? "").toContain("https://accounts.google.com/");
    expect(urlAtEventTime ?? "").toContain("client_id=test-client-id");

    // …and the sidecar is cleaned up on the timeout exit.
    expect(existsSync(urlFilePath)).toBe(false);
  });
});
