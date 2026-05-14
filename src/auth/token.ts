import { getOAuth } from "./oauth.ts";

export async function getAccessToken(): Promise<string> {
  const { client } = await getOAuth();
  const creds = client.credentials;
  if (!creds || (!creds.access_token && !creds.refresh_token)) {
    throw new Error(
      "Not signed in. Run `gmail-mcp-auth login` (or `bun run src/bin/auth.ts login`) first.",
    );
  }
  try {
    // google-auth-library handles refresh automatically when expired.
    const res = await client.getAccessToken();
    if (!res?.token) {
      throw new Error("Token acquisition returned no access token");
    }
    return res.token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("invalid_grant")) {
      throw new Error(
        "Refresh failed (invalid_grant). The refresh token was likely revoked or expired. Run `gmail-mcp-auth login` again.",
      );
    }
    throw err;
  }
}
