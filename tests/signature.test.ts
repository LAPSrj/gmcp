import { describe, test, expect, afterEach } from "bun:test";
import { signatureEnabledByDefault, wantSignature } from "../src/google/signature.ts";

const ENV = "GMAIL_MCP_AUTO_SIGNATURE";
const original = process.env[ENV];

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe("signatureEnabledByDefault", () => {
  test("truthy values enable it", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) {
      process.env[ENV] = v;
      expect(signatureEnabledByDefault()).toBe(true);
    }
  });

  test("absent or non-truthy values disable it", () => {
    delete process.env[ENV];
    expect(signatureEnabledByDefault()).toBe(false);
    for (const v of ["", "0", "false", "no", "off", "nope"]) {
      process.env[ENV] = v;
      expect(signatureEnabledByDefault()).toBe(false);
    }
  });
});

describe("wantSignature", () => {
  test("explicit arg wins over env", () => {
    process.env[ENV] = "1";
    expect(wantSignature(false)).toBe(false); // opt-out overrides env-on
    delete process.env[ENV];
    expect(wantSignature(true)).toBe(true); // opt-in overrides env-off
  });

  test("undefined arg falls back to env default", () => {
    process.env[ENV] = "1";
    expect(wantSignature(undefined)).toBe(true);
    process.env[ENV] = "0";
    expect(wantSignature(undefined)).toBe(false);
  });
});
