import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, deriveLockPath, type LockInfo } from "../src/auth/lock.ts";

describe("deriveLockPath", () => {
  test("default tokens.json → login.lock", () => {
    expect(deriveLockPath("/x/y/tokens.json")).toBe("/x/y/login.lock");
  });
  test("profile token → profile lock", () => {
    expect(deriveLockPath("/x/y/tokens-work.json")).toBe("/x/y/login-work.lock");
    expect(deriveLockPath("/x/y/tokens-foo_bar-1.json")).toBe("/x/y/login-foo_bar-1.lock");
  });
  test("custom path that doesn't match → appends suffix", () => {
    expect(deriveLockPath("/x/y/weird.json")).toBe("/x/y/weird.json.login.lock");
  });
});

describe("acquireLock / releaseLock", () => {
  let dir: string;
  let lockPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gmail-mcp-lock-"));
    lockPath = join(dir, "login.lock");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("acquire writes a lock file containing our PID", async () => {
    await acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    const info = JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
    expect(info.pid).toBe(process.pid);
    expect(typeof info.started_at).toBe("number");
  });

  test("acquire fails if a live process already holds the lock", async () => {
    // PID 1 (init) is virtually always alive on linux/wsl.
    writeFileSync(lockPath, JSON.stringify({ pid: 1, started_at: Date.now() }));
    await expect(acquireLock(lockPath)).rejects.toThrow(/Another login is already in progress/);
  });

  test("acquire reclaims a stale lock (dead PID)", async () => {
    // PID 999999 — almost certainly not running.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, started_at: 0 }));
    await acquireLock(lockPath);
    const info = JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
    expect(info.pid).toBe(process.pid);
  });

  test("acquire reclaims a corrupt lock", async () => {
    writeFileSync(lockPath, "not json{{{");
    await acquireLock(lockPath);
    const info = JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
    expect(info.pid).toBe(process.pid);
  });

  test("release removes the file; double-release is a no-op", async () => {
    await acquireLock(lockPath);
    await releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
    await releaseLock(lockPath); // must not throw
  });
});
