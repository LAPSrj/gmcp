import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  started_at: number;
}

// Single-flight guard for `gmail-mcp-auth wait` per profile.
// Lock file lives next to the token file (~/.config/gmail-mcp/login-<profile>.lock)
// and stores the holder's PID. A stale lock (PID no longer alive) is reclaimed
// transparently. Callers MUST release on every exit path.
export async function acquireLock(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const myInfo: LockInfo = { pid: process.pid, started_at: Date.now() };
  const payload = JSON.stringify(myInfo);

  try {
    await writeFile(lockPath, payload, { flag: "wx" });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // Lock exists. Check if the holder is alive.
  let existing: LockInfo | null = null;
  try {
    existing = JSON.parse(await readFile(lockPath, "utf8")) as LockInfo;
  } catch {
    // Corrupt lock — treat as stale.
  }

  if (existing && isPidAlive(existing.pid)) {
    throw new Error(
      `Another login is already in progress (pid ${existing.pid}, started ${new Date(
        existing.started_at,
      ).toISOString()}). Wait for it to finish, or remove the stale lock at ${lockPath}.`,
    );
  }

  // Stale — overwrite.
  await writeFile(lockPath, payload);
}

export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we don't own it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Derive the lock-file path from the token-file path so they share fate per
// profile. tokens.json -> login.lock; tokens-<profile>.json -> login-<profile>.lock.
export function deriveLockPath(tokenPath: string): string {
  const dir = dirname(tokenPath);
  const base = tokenPath.slice(dir.length + 1);
  const m = /^tokens(-[a-zA-Z0-9_-]+)?\.json$/.exec(base);
  if (m) return `${dir}/login${m[1] ?? ""}.lock`;
  // Custom GMAIL_MCP_TOKEN_PATH that doesn't match the pattern — just append.
  return `${tokenPath}.login.lock`;
}
