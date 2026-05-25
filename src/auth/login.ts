import { spawn } from "node:child_process";
import http from "node:http";
import { platform } from "node:os";
import type { AddressInfo } from "node:net";
import type { Credentials, OAuth2Client } from "google-auth-library";
import { getOAuth } from "./oauth.ts";
import { writeTokens } from "./store.ts";

function openBrowserCmd(url: string): void {
  const p = platform();
  let cmd: string;
  let args: string[];
  if (p === "darwin") {
    cmd = "open";
    args = [url];
  } else if (p === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    // Linux / WSL — try xdg-open, then wslview, then powershell.exe
    cmd = "sh";
    args = [
      "-c",
      `xdg-open '${url}' >/dev/null 2>&1 || wslview '${url}' >/dev/null 2>&1 || powershell.exe -NoProfile -Command "Start-Process '${url}'" >/dev/null 2>&1`,
    ];
  }
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export interface LoginResult {
  email: string | null;
}

// Existing CLI entrypoint — opens a browser, blocks until callback, returns email.
export async function loginInteractive(): Promise<LoginResult> {
  const { client, config } = await getOAuth();
  const portToBind = config.redirectPort ?? 0;

  const tokens = await runLoopback({
    client,
    scopes: config.scopes,
    preferredPort: portToBind,
    onUrl: (url) => {
      console.error(`Opening browser for sign-in...\nIf nothing happens, visit:\n  ${url}`);
      openBrowserCmd(url);
    },
  });

  await writeTokens(config.tokenPath, tokens);
  client.setCredentials(tokens);

  let email: string | null = null;
  try {
    const res = await client.request<{ email?: string }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    });
    email = res.data.email ?? null;
  } catch {
    // Non-fatal — tokens are stored even if the probe fails.
  }
  return { email };
}

// Event shape emitted by loginWithEvents. One event per JSON line so a
// caller running this under Monitor sees each as a single notification.
export type LoginEvent =
  | { event: "starting"; profile: string | null; timeout_ms: number; token_path: string }
  | { event: "auth_url"; url: string; redirect_uri: string; expires_at: string }
  | { event: "waiting_for_callback" }
  | { event: "callback_received" }
  | { event: "tokens_persisted"; email: string | null; token_path: string }
  | { event: "done"; profile: string | null; email: string | null }
  | { event: "timeout"; timeout_ms: number }
  | { event: "error"; message: string };

export type LoginExitReason = "done" | "timeout" | "error";

export interface LoginEventsOptions {
  emit: (e: LoginEvent) => void;
  timeoutMs?: number;
}

export interface LoginEventsResult {
  reason: LoginExitReason;
  email: string | null;
}

// Headless variant — no browser, no console output. Emits structured events
// for the caller (CLI or test) to forward to stdout / Monitor.
export async function loginWithEvents(
  opts: LoginEventsOptions,
): Promise<LoginEventsResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const { client, config } = await getOAuth();
  const portToBind = config.redirectPort ?? 0;

  opts.emit({
    event: "starting",
    profile: config.profile,
    timeout_ms: timeoutMs,
    token_path: config.tokenPath,
  });

  let tokens: Credentials;
  try {
    tokens = await runLoopback({
      client,
      scopes: config.scopes,
      preferredPort: portToBind,
      timeoutMs,
      onUrl: (url, redirectUri) => {
        opts.emit({
          event: "auth_url",
          url,
          redirect_uri: redirectUri,
          expires_at: new Date(Date.now() + timeoutMs).toISOString(),
        });
        opts.emit({ event: "waiting_for_callback" });
      },
      onCallback: () => opts.emit({ event: "callback_received" }),
    });
  } catch (err) {
    if (err instanceof LoginTimeoutError) {
      opts.emit({ event: "timeout", timeout_ms: timeoutMs });
      return { reason: "timeout", email: null };
    }
    opts.emit({
      event: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return { reason: "error", email: null };
  }

  await writeTokens(config.tokenPath, tokens);
  client.setCredentials(tokens);

  let email: string | null = null;
  try {
    const res = await client.request<{ email?: string }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    });
    email = res.data.email ?? null;
  } catch {
    // Non-fatal — tokens are persisted regardless.
  }

  opts.emit({ event: "tokens_persisted", email, token_path: config.tokenPath });
  opts.emit({ event: "done", profile: config.profile, email });
  return { reason: "done", email };
}

class LoginTimeoutError extends Error {
  constructor(ms: number) {
    super(`Login timed out after ${ms} ms with no callback.`);
  }
}

interface LoopbackOpts {
  client: OAuth2Client;
  scopes: string[];
  preferredPort: number;
  onUrl?: (authUrl: string, redirectUri: string) => void;
  onCallback?: () => void;
  timeoutMs?: number;
}

function runLoopback(opts: LoopbackOpts): Promise<Credentials> {
  const { client, scopes, preferredPort, onUrl, onCallback, timeoutMs } = opts;
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        server.close();
      } catch {
        // ignore — best effort
      }
      action();
    };

    server.listen(preferredPort, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        finish(() => reject(new Error("Failed to bind loopback redirect server.")));
        return;
      }
      const redirectUri = `http://127.0.0.1:${addr.port}`;
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        scope: scopes,
        prompt: "consent",
        redirect_uri: redirectUri,
      });
      onUrl?.(authUrl, redirectUri);

      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          finish(() => reject(new LoginTimeoutError(timeoutMs)));
        }, timeoutMs);
      }
    });

    server.on("request", (req, res) => {
      void (async () => {
        try {
          const u = new URL(req.url ?? "/", "http://127.0.0.1");
          const code = u.searchParams.get("code");
          const error = u.searchParams.get("error");
          if (error) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(
              `<html><body style='font-family:system-ui;text-align:center;padding:4em'><h2>Sign-in failed.</h2><p>${escapeHtml(error)}</p></body></html>`,
            );
            finish(() => reject(new Error(`OAuth error: ${error}`)));
            return;
          }
          if (!code) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end("<h1>Missing authorization code</h1>");
            return;
          }
          onCallback?.();
          const addr = server.address() as AddressInfo;
          const redirectUri = `http://127.0.0.1:${addr.port}`;
          const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body style='font-family:system-ui;text-align:center;padding:4em'><h2>Signed in.</h2><p>You can close this tab and return to the terminal.</p></body></html>",
          );
          finish(() => resolve(tokens));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end("<h1>Token exchange failed</h1>");
          finish(() => reject(err));
        }
      })();
    });

    server.on("error", (err) => finish(() => reject(err)));
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function logoutLocal(): Promise<void> {
  const { client, config } = await getOAuth();
  // Best-effort token revocation with Google, then clear local cache.
  try {
    const creds = client.credentials;
    const token = creds.refresh_token ?? creds.access_token;
    if (token) await client.revokeToken(token);
  } catch {
    // ignore — local clear is the source of truth for "logged out"
  }
  await writeTokens(config.tokenPath, {});
  client.setCredentials({});
}

export interface StatusResult {
  signed_in: boolean;
  email: string | null;
  token_path: string;
  profile: string | null;
  // expires_at: ISO timestamp when the access token expires. Null if no creds.
  expires_at: string | null;
  // True iff a probe to Gmail succeeded with the current/refreshed token.
  valid: boolean;
  // Populated when the probe fails — e.g. invalid_grant, network error.
  error: string | null;
}

export async function getStatus(): Promise<StatusResult> {
  const { client, config } = await getOAuth();
  const creds = client.credentials;
  const base = {
    token_path: config.tokenPath,
    profile: config.profile,
  };
  if (!creds || (!creds.access_token && !creds.refresh_token)) {
    return {
      ...base,
      signed_in: false,
      email: null,
      expires_at: null,
      valid: false,
      error: null,
    };
  }
  const expires_at = creds.expiry_date ? new Date(creds.expiry_date).toISOString() : null;
  try {
    const res = await client.request<{ emailAddress?: string; email?: string }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    });
    const email = res.data.emailAddress ?? res.data.email ?? null;
    return {
      ...base,
      signed_in: true,
      email,
      expires_at,
      valid: true,
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      signed_in: true,
      email: null,
      expires_at,
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
