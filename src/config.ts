import { homedir } from "node:os";
import { join } from "node:path";

// Scopes — see DECISIONS.md #2. `gmail.modify` covers list/get/modify/labels/trash
// (everything except permanent-delete, which we don't expose, and send, which is
// gated behind its own scope). `calendar` is full read/write. `contacts.readonly`
// is enough for the two contacts tools.
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
];

export interface Config {
  credentialsFile: string;
  tokenPath: string;
  redirectPort: number | undefined;
  scopes: string[];
  profile: string | null;
}

const PROFILE_RE = /^[a-zA-Z0-9_-]+$/;

export function loadConfig(): Config {
  const credentialsFile = process.env.GMAIL_MCP_CREDENTIALS_FILE;
  if (!credentialsFile) {
    throw new Error(
      "GMAIL_MCP_CREDENTIALS_FILE is not set. Download an OAuth client credentials JSON from Google Cloud Console (APIs & Services → Credentials → + Create credentials → OAuth client ID → Desktop app) and point this env var at it. See README §1.",
    );
  }

  const rawProfile = process.env.GMAIL_MCP_PROFILE?.trim();
  const profile = rawProfile ? rawProfile : null;
  if (profile && !PROFILE_RE.test(profile)) {
    throw new Error(
      `GMAIL_MCP_PROFILE "${profile}" must match /^[a-zA-Z0-9_-]+$/ (used as a filename suffix).`,
    );
  }

  const defaultTokenPath = profile
    ? join(homedir(), ".config", "gmail-mcp", `tokens-${profile}.json`)
    : join(homedir(), ".config", "gmail-mcp", "tokens.json");
  const tokenPath = process.env.GMAIL_MCP_TOKEN_PATH ?? defaultTokenPath;

  const portEnv = process.env.GMAIL_MCP_REDIRECT_PORT;
  const redirectPort = portEnv ? Number(portEnv) : undefined;

  return {
    credentialsFile,
    tokenPath,
    redirectPort,
    scopes: SCOPES,
    profile,
  };
}

export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
export const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
export const PEOPLE_BASE = "https://people.googleapis.com/v1";
