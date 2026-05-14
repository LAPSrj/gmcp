import { spawn } from "node:child_process";
import http from "node:http";
import { platform } from "node:os";
import type { AddressInfo } from "node:net";
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

export async function loginInteractive(): Promise<LoginResult> {
  const { client, config } = await getOAuth();

  const portToBind = config.redirectPort ?? 0;
  const tokens = await runLoopback(client, config.scopes, portToBind);

  await writeTokens(config.tokenPath, tokens);
  client.setCredentials(tokens);

  // Best-effort identity lookup for the CLI message.
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

function runLoopback(
  client: import("google-auth-library").OAuth2Client,
  scopes: string[],
  preferredPort: number,
): Promise<import("google-auth-library").Credentials> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(preferredPort, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        server.close();
        reject(new Error("Failed to bind loopback redirect server."));
        return;
      }
      const redirectUri = `http://127.0.0.1:${addr.port}`;
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        scope: scopes,
        prompt: "consent",
        redirect_uri: redirectUri,
      });
      console.error(`Opening browser for sign-in...\nIf nothing happens, visit:\n  ${authUrl}`);
      openBrowserCmd(authUrl);
    });

    server.on("request", async (req, res) => {
      try {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        const code = u.searchParams.get("code");
        const error = u.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<html><body style='font-family:system-ui;text-align:center;padding:4em'><h2>Sign-in failed.</h2><p>${escapeHtml(error)}</p></body></html>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Missing authorization code</h1>");
          return;
        }
        const addr = server.address() as AddressInfo;
        const redirectUri = `http://127.0.0.1:${addr.port}`;
        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body style='font-family:system-ui;text-align:center;padding:4em'><h2>Signed in.</h2><p>You can close this tab and return to the terminal.</p></body></html>",
        );
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end("<h1>Token exchange failed</h1>");
        server.close();
        reject(err);
      }
    });

    server.on("error", reject);
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

export async function getStatus(): Promise<
  | { signedIn: false }
  | { signedIn: true; email: string | null }
> {
  const { client } = await getOAuth();
  const creds = client.credentials;
  if (!creds || (!creds.access_token && !creds.refresh_token)) return { signedIn: false };
  try {
    const res = await client.request<{ email?: string }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    });
    return { signedIn: true, email: res.data.email ?? null };
  } catch {
    return { signedIn: true, email: null };
  }
}
