import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStatus } from "../auth/login.ts";
import { ok } from "./helpers.ts";

export function registerAuthTools(server: McpServer): void {
  server.tool(
    "auth_status",
    "Report the gmail-mcp auth state for the profile this server is running as. Returns whether tokens are present, whether they still authenticate against Gmail (a tiny probe call), the cached access-token expiry, the profile name, and the on-disk token path. Use this proactively before long workflows, or when any other tool returns an `invalid_grant` / 401 error — the response tells the agent whether to call `auth_login` to re-authenticate.",
    {},
    async () => {
      const s = await getStatus();
      return ok(s);
    },
  );

  server.tool(
    "auth_login",
    "Kick off interactive re-authentication for THIS profile (no risk of writing tokens to the wrong account — the profile is fixed by the server's env). Returns a `monitor` object the agent should hand to Claude Code's Monitor tool: it spawns the `gmail-mcp-auth wait` CLI which spins up a localhost OAuth loopback, prints a JSON `auth_url` event (show that URL to the user), waits for them to complete consent in the browser, then exits 0 (success) / 1 (error) / 2 (timeout). One JSON event per stdout line so Monitor surfaces each as its own notification — agent reads them live, no polling. The CLI persists the new tokens to disk before exiting, so the next gmail-mcp tool call uses them automatically.",
    {
      timeout_seconds: z
        .number()
        .int()
        .min(30)
        .max(1800)
        .optional()
        .describe(
          "How long the wait CLI keeps the loopback open before giving up. Default 300 (5 min). Cap 1800 (30 min) — long enough for a user who walks away mid-flow but not indefinite.",
        ),
    },
    async ({ timeout_seconds }) => {
      // src/tools/auth.ts → ../bin/auth.ts
      const here = dirname(fileURLToPath(import.meta.url));
      const cliPath = resolve(here, "..", "bin", "auth.ts");
      const cliExists = existsSync(cliPath);

      // Monitor strips env from spawned children — bake gmail-mcp's config
      // env vars inline so the wait CLI reaches the same OAuth client + token
      // path as this server. (Same trick as mail_listen_instructions.)
      const envParts: string[] = [];
      const credsFile = process.env.GMAIL_MCP_CREDENTIALS_FILE;
      const profile = process.env.GMAIL_MCP_PROFILE;
      const tokenPath = process.env.GMAIL_MCP_TOKEN_PATH;
      const redirectPort = process.env.GMAIL_MCP_REDIRECT_PORT;
      if (credsFile) envParts.push(`GMAIL_MCP_CREDENTIALS_FILE=${shellQuote(credsFile)}`);
      if (profile) envParts.push(`GMAIL_MCP_PROFILE=${shellQuote(profile)}`);
      if (tokenPath) envParts.push(`GMAIL_MCP_TOKEN_PATH=${shellQuote(tokenPath)}`);
      if (redirectPort) envParts.push(`GMAIL_MCP_REDIRECT_PORT=${shellQuote(redirectPort)}`);
      if (timeout_seconds) {
        envParts.push(`GMAIL_MCP_LOGIN_TIMEOUT_MS=${timeout_seconds * 1000}`);
      }

      const command = [
        ...envParts,
        "bun",
        shellQuote(cliPath),
        "wait",
      ].join(" ");

      const timeoutMs = (timeout_seconds ?? 300) * 1000;

      return ok({
        profile: profile ?? null,
        monitor: {
          command,
          description: `gmail-mcp login (${profile ?? "default"})`,
          persistent: false,
          // Give Monitor a bit of slack beyond the CLI's own timeout so we see
          // the structured `timeout` event before Monitor itself kills the child.
          timeout_ms: timeoutMs + 30_000,
        },
        cli_path: cliPath,
        cli_exists: cliExists,
        instructions: [
          "Pass the `monitor` object above to Claude Code's Monitor tool.",
          "On the first notification, look for `{event: \"auth_url\", url, ...}` and present that URL to the user — they sign in there.",
          "Subsequent notifications (`waiting_for_callback`, `callback_received`, `tokens_persisted`, `done`) report progress.",
          "Exit code 0 = success (tokens persisted, retry your original tool call). Exit 1 = error. Exit 2 = timeout (user never finished sign-in).",
          "The wait CLI holds a per-profile lock file at ~/.config/gmail-mcp/login*.lock — if a second login is already in flight it errors fast.",
        ],
      });
    },
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
