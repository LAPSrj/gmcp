#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, basename } from "node:path";
import {
  loginInteractive,
  logoutLocal,
  getStatus,
  loginWithEvents,
  type LoginEvent,
} from "../auth/login.ts";
import { loadConfig } from "../config.ts";
import { acquireLock, releaseLock, deriveLockPath } from "../auth/lock.ts";

function usage(): never {
  console.error(`gmail-mcp-auth — manage gmail-mcp auth state

Usage:
  gmail-mcp-auth login [profile]     Interactive browser sign-in (one time per profile)
  gmail-mcp-auth status [profile]    Show signed-in account
  gmail-mcp-auth logout [profile]    Revoke + clear local token cache
  gmail-mcp-auth list                List profiles that have tokens on disk
  gmail-mcp-auth wait [profile]      Headless sign-in for agent-triggered re-auth.
                                     Prints one JSON event per stdout line, blocks
                                     until the user completes consent in the browser,
                                     then exits 0/1/2 (success/error/timeout).

Profiles let you sign into multiple Google accounts on the same machine.
Token files: ~/.config/gmail-mcp/tokens.json (no profile) or tokens-<profile>.json.
Profile names must match /^[a-zA-Z0-9_-]+$/.

Environment:
  GMAIL_MCP_CREDENTIALS_FILE  Path to OAuth client credentials.json (required)
  GMAIL_MCP_PROFILE           Profile name (overridden by the [profile] CLI arg)
  GMAIL_MCP_TOKEN_PATH        Token cache path (overrides profile-derived path)
  GMAIL_MCP_REDIRECT_PORT     Fixed loopback port (default: random)
  GMAIL_MCP_LOGIN_TIMEOUT_MS  Timeout for \`wait\` (default 300000 = 5 min)
`);
  process.exit(2);
}

const PROFILE_RE = /^[a-zA-Z0-9_-]+$/;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const profileArg = process.argv[3];
  if (!cmd || cmd === "--help" || cmd === "-h") usage();

  // `list` is special — it doesn't need credentials configured.
  if (cmd === "list") {
    await listProfiles();
    return;
  }

  if (profileArg) {
    if (!PROFILE_RE.test(profileArg)) {
      console.error(`Profile name "${profileArg}" must match /^[a-zA-Z0-9_-]+$/.`);
      process.exit(2);
    }
    // Override the env so loadConfig() picks up the profile-scoped token path.
    process.env.GMAIL_MCP_PROFILE = profileArg;
  }

  const config = loadConfig();
  const label = config.profile ? ` [profile: ${config.profile}]` : "";

  switch (cmd) {
    case "login": {
      const r = await loginInteractive();
      console.log(`Signed in${r.email ? ` as ${r.email}` : ""}${label}.`);
      console.log(`Tokens cached at: ${config.tokenPath}`);
      break;
    }
    case "status": {
      const s = await getStatus();
      if (s.signed_in) {
        console.log(`Signed in${s.email ? ` as ${s.email}` : ""}${label}.`);
        console.log(`Token cache: ${config.tokenPath}`);
        if (!s.valid) {
          console.log(`Token probe failed: ${s.error ?? "(no detail)"}.`);
          process.exit(1);
        }
      } else {
        console.log(`Not signed in${label}. Run \`gmail-mcp-auth login${profileArg ? ` ${profileArg}` : ""}\`.`);
        process.exit(1);
      }
      break;
    }
    case "logout": {
      await logoutLocal();
      console.log(`Local token cache cleared and token revoked (best-effort)${label}.`);
      break;
    }
    case "wait": {
      await runWait(config.tokenPath);
      break;
    }
    default:
      usage();
  }
}

async function runWait(tokenPath: string): Promise<void> {
  const lockPath = deriveLockPath(tokenPath);
  const timeoutMs = Number(process.env.GMAIL_MCP_LOGIN_TIMEOUT_MS ?? 5 * 60 * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    emitEvent({ event: "error", message: "GMAIL_MCP_LOGIN_TIMEOUT_MS must be a positive number." });
    process.exit(1);
  }

  try {
    await acquireLock(lockPath);
  } catch (err) {
    emitEvent({
      event: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Best-effort release on signal so a Ctrl-C doesn't leave a stale lock.
  const cleanup = (): void => {
    void releaseLock(lockPath);
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  let result;
  try {
    result = await loginWithEvents({ emit: emitEvent, timeoutMs });
  } finally {
    await releaseLock(lockPath);
  }

  if (result.reason === "done") process.exit(0);
  if (result.reason === "timeout") process.exit(2);
  process.exit(1);
}

function emitEvent(e: LoginEvent): void {
  // One JSON object per stdout line — Monitor turns each into one notification.
  process.stdout.write(`${JSON.stringify(e)}\n`);
}

async function listProfiles(): Promise<void> {
  const explicitTokenPath = process.env.GMAIL_MCP_TOKEN_PATH;
  const dir = explicitTokenPath
    ? dirname(explicitTokenPath)
    : `${homedir()}/.config/gmail-mcp`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    console.log(`No tokens directory at ${dir}.`);
    return;
  }
  const found: { profile: string; file: string }[] = [];
  for (const f of entries) {
    if (f === "tokens.json") found.push({ profile: "(default)", file: f });
    else {
      const m = /^tokens-([a-zA-Z0-9_-]+)\.json$/.exec(f);
      if (m) found.push({ profile: m[1]!, file: f });
    }
  }
  if (found.length === 0) {
    console.log(`No token files in ${dir}.`);
    return;
  }
  console.log(`Profiles in ${dir}:`);
  for (const p of found) console.log(`  ${p.profile.padEnd(20)} ${basename(p.file)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
