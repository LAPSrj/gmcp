import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { googleRequest } from "../google/client.ts";
import { ok } from "./helpers.ts";

interface Person {
  resourceName?: string;
  names?: { displayName?: string; givenName?: string; familyName?: string }[];
  emailAddresses?: { value?: string; type?: string }[];
  phoneNumbers?: { value?: string; type?: string }[];
  organizations?: { name?: string; title?: string }[];
}

function compactPerson(p: Person): Record<string, unknown> {
  const n = p.names?.[0];
  const o = p.organizations?.[0];
  return {
    id: p.resourceName ?? null,
    display_name: n?.displayName ?? null,
    given_name: n?.givenName ?? null,
    surname: n?.familyName ?? null,
    company: o?.name ?? null,
    job_title: o?.title ?? null,
    emails: (p.emailAddresses ?? []).map((e) => ({ address: e.value, type: e.type ?? null })),
    business_phones: (p.phoneNumbers ?? [])
      .filter((ph) => ph.type === "work")
      .map((ph) => ph.value)
      .filter(Boolean),
    mobile_phone:
      p.phoneNumbers?.find((ph) => ph.type === "mobile")?.value ??
      p.phoneNumbers?.[0]?.value ??
      null,
  };
}

const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations";

export function registerContactsTools(server: McpServer): void {
  server.tool(
    "contacts_search",
    "Search the user's contacts. Unions saved contacts (people.searchContacts) with 'other contacts' (otherContacts.search — people you've emailed but not explicitly saved). Read-only.",
    {
      query: z.string().describe("Search query (matches name, email, organization)."),
      top: z.number().int().min(1).max(50).default(25),
    },
    async ({ query, top }) => {
      // Google requires a "warmup" call with empty query first for searchContacts to index
      // freshly. Skipping that — for an interactive MCP, the index is generally warm.
      const [saved, other] = await Promise.all([
        googleRequest<{ results?: { person?: Person }[] }>({
          api: "people",
          path: "/people:searchContacts",
          query: { query, pageSize: top, readMask: PERSON_FIELDS },
        }).catch(() => ({ results: [] as { person?: Person }[] })),
        googleRequest<{ results?: { person?: Person }[] }>({
          api: "people",
          path: "/otherContacts:search",
          query: { query, pageSize: top, readMask: "names,emailAddresses" },
        }).catch(() => ({ results: [] as { person?: Person }[] })),
      ]);
      const merged: Person[] = [];
      const seen = new Set<string>();
      for (const r of [...(saved.results ?? []), ...(other.results ?? [])]) {
        const p = r.person;
        if (!p) continue;
        const key = p.resourceName ?? p.emailAddresses?.[0]?.value ?? Math.random().toString();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(p);
        if (merged.length >= top) break;
      }
      return ok(merged.map(compactPerson));
    },
  );

  server.tool(
    "contacts_get",
    "Get a single contact by id (resourceName, e.g. 'people/c1234...').",
    { id: z.string() },
    async ({ id }) => {
      const p = await googleRequest<Person>({
        api: "people",
        path: `/${id.startsWith("people/") ? id : `people/${id}`}`,
        query: { personFields: PERSON_FIELDS },
      });
      return ok(compactPerson(p));
    },
  );
}
