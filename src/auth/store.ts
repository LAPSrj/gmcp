import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credentials } from "google-auth-library";

export async function readTokens(path: string): Promise<Credentials | null> {
  try {
    const data = await readFile(path, "utf8");
    return JSON.parse(data) as Credentials;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeTokens(path: string, tokens: Credentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(tokens, null, 2), "utf8");
  try {
    await chmod(path, 0o600);
  } catch {
    // chmod may fail on WSL/non-POSIX FS; not fatal
  }
}

export async function clearTokens(path: string): Promise<void> {
  try {
    await writeFile(path, JSON.stringify({}, null, 2), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

interface CredentialsFileShape {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

export async function readClientCredentials(
  credentialsFile: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const raw = await readFile(credentialsFile, "utf8");
  const parsed = JSON.parse(raw) as CredentialsFileShape;
  const inner = parsed.installed ?? parsed.web;
  if (!inner?.client_id || !inner.client_secret) {
    throw new Error(
      `credentials file ${credentialsFile} missing installed.client_id / installed.client_secret. Did you download the OAuth client of type "Desktop app"?`,
    );
  }
  return { clientId: inner.client_id, clientSecret: inner.client_secret };
}
