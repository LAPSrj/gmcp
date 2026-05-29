import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { googleRequest } from "../google/client.ts";
import { getAccountSignature } from "../google/signature.ts";
import { ok } from "./helpers.ts";

interface GmailProfile {
  emailAddress?: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
}

interface PeopleProfile {
  names?: { displayName?: string; givenName?: string; familyName?: string }[];
  emailAddresses?: { value?: string }[];
}

interface VacationSettings {
  enableAutoReply?: boolean;
  responseSubject?: string;
  responseBodyPlainText?: string;
  restrictToContacts?: boolean;
  restrictToDomain?: boolean;
  startTime?: string;
  endTime?: string;
}

interface CalendarSettingsList {
  items?: { id?: string; value?: string }[];
}

export function registerAccountTools(server: McpServer): void {
  server.tool(
    "who_am_i",
    "Identify the signed-in user (display name, primary email, profile counts).",
    {},
    async () => {
      const [profile, people] = await Promise.all([
        googleRequest<GmailProfile>({ api: "gmail", path: "/users/me/profile" }),
        googleRequest<PeopleProfile>({
          api: "people",
          path: "/people/me",
          query: { personFields: "names,emailAddresses" },
        }).catch(() => null),
      ]);
      const name = people?.names?.[0];
      return ok({
        email: profile.emailAddress ?? null,
        display_name: name?.displayName ?? null,
        given_name: name?.givenName ?? null,
        surname: name?.familyName ?? null,
        messages_total: profile.messagesTotal ?? null,
        threads_total: profile.threadsTotal ?? null,
        history_id: profile.historyId ?? null,
      });
    },
  );

  server.tool(
    "mailbox_get_settings",
    "Get the user's Gmail + Calendar settings: timezone, auto-reply (vacation) state, and the HTML signature (if any). Use this to pick sensible defaults for calendar tools. Note: unlike Outlook, Gmail/Calendar does not expose working hours on the profile — pass them explicitly to calendar_find_free_slots.",
    {},
    async () => {
      const [vacation, calSettings, signature] = await Promise.all([
        googleRequest<VacationSettings>({
          api: "gmail",
          path: "/users/me/settings/vacation",
        }).catch(() => null),
        googleRequest<CalendarSettingsList>({
          api: "calendar",
          path: "/users/me/settings",
        }).catch(() => null),
        getAccountSignature(),
      ]);
      const tz = calSettings?.items?.find((s) => s.id === "timezone")?.value ?? null;
      const locale = calSettings?.items?.find((s) => s.id === "locale")?.value ?? null;
      const dateFormat = calSettings?.items?.find((s) => s.id === "dateFieldOrder")?.value ?? null;
      return ok({
        timezone: tz,
        language: locale,
        date_format: dateFormat,
        time_format: null,
        working_hours: null, // not exposed on Google; pass explicit hours to calendar_find_free_slots
        signature, // HTML signature from the primary send-as identity, or null when none is set
        automatic_replies: vacation
          ? {
              status: vacation.enableAutoReply ? "enabled" : "disabled",
              external_audience: vacation.restrictToContacts
                ? "contactsOnly"
                : vacation.restrictToDomain
                  ? "internalOnly"
                  : "all",
              internal_message: vacation.responseBodyPlainText ?? null,
              external_message: vacation.responseBodyPlainText ?? null,
              subject: vacation.responseSubject ?? null,
              scheduled_start: vacation.startTime ?? null,
              scheduled_end: vacation.endTime ?? null,
            }
          : null,
      });
    },
  );
}
