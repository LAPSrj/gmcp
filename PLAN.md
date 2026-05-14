# gmail-mcp — Plan

An MCP server for personal Gmail + Google Calendar, modelled on `outlook-mcp`.
The official Google MCP is too limited (no compose/send, no calendar mutation, no listen-loop). This server gives Claude (or any MCP client) the same shape of mail/calendar/contacts tools that `outlook-mcp` provides for Microsoft Graph.

Goals:

1. **Parity** with `outlook-mcp` tool surface — same names, same args, same compact JSON shape — so an agent that knows one knows the other.
2. **Same auth ergonomics**: one-time browser sign-in, refresh-token cached locally, no per-call interaction.
3. **Call out Google's quirks** (labels vs folders, threads, RRULE recurrence, Meet link semantics, history-based inbox watch) where the abstraction can't be perfectly preserved.

---

## 1. Tool-for-tool mapping (outlook → gmail)

Tool names stay identical wherever the operation is recognisable; new Gmail-only tools are added where the model genuinely differs (labels, threads). The "missing" column flags where Google has no direct analogue.

### Account (2 tools — full parity)

| outlook tool             | gmail-mcp tool         | backend                                                     | notes |
| ---                      | ---                    | ---                                                         | --- |
| `who_am_i`               | `who_am_i`             | `gmail.users.getProfile` + `people.people.get('me')`        | profile email comes from Gmail; display name from People API |
| `mailbox_get_settings`   | `mailbox_get_settings` | `gmail.users.settings.{getLanguage,getAutoForwarding,getVacation}` + `calendar.settings.list` | working-hours not a Gmail concept — surface the user's `timezone` setting from Calendar and a fixed `working_hours: null` (callers can pass explicit working hours to `calendar_find_free_slots`). Surface vacation auto-responder. |

### Mail (Gmail core — close-but-not-identical parity)

The biggest semantic gap: **Gmail has labels, not folders**. `INBOX`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, `STARRED`, `IMPORTANT`, `UNREAD`, `CATEGORY_PERSONAL/SOCIAL/PROMOTIONS/UPDATES/FORUMS` are system labels; user labels are arbitrary tags. A message can have *many* labels at once. We expose folder-shaped tools by treating `INBOX` etc. as the "default folder" but keep the underlying mechanism honest (a `label:` filter, not a parent_id).

| outlook tool          | gmail-mcp tool                    | backend                                                  | notes |
| ---                   | ---                               | ---                                                      | --- |
| `mail_list`           | `mail_list`                       | `users.messages.list` (`labelIds=[INBOX]`, `q=`)         | folder→labelId map. `unread_only` → `q=is:unread`. `from` → `q=from:`. `has_attachments` → `q=has:attachment`. `order_by` — Gmail always returns newest-first by `internalDate`; `asc`/`subject` flags must be applied client-side or via `q=newer/older_than:` ranges. Then `users.messages.get(format=metadata, metadataHeaders=[Subject,From,To,Cc,Date])` per id to enrich (parallelised, batched). |
| `mail_search`         | `mail_search`                     | `users.messages.list` with `q=`                          | Gmail's `q` syntax is richer than Graph's `$search` — accept it verbatim. Examples we'll document: `from:alice@x.com project`, `subject:invoice`, `has:attachment label:inbox newer_than:7d`. |
| `mail_get`            | `mail_get`                        | `users.messages.get(format=full)`                        | decode `payload` MIME tree → `{ format, content }`. `format: "text"` → text/plain part; `"html"` → text/html part. Attachments are listed with `attachmentId` + `size` + `mimeType`. |
| `mail_get_attachment` | `mail_get_attachment`             | `users.messages.attachments.get`                         | returns base64url — we re-encode to standard base64 for parity. |
| `mail_list_folders`   | `mail_list_labels`                | `users.labels.list`                                      | renamed for honesty. Returns `{ id, name, type: "system"\|"user", messages_total, messages_unread, color }`. Add a deprecated alias `mail_list_folders` that calls the same thing. |
| —                     | `mail_create_label` (NEW)         | `users.labels.create`                                    | Gmail lets users create labels at runtime — required for `mail_move`-style flows. |
| —                     | `mail_apply_labels` (NEW)         | `users.messages.modify` (`addLabelIds`, `removeLabelIds`)| since messages have many labels, "move" is really "add label X / remove INBOX". One tool that takes `add`/`remove` is cleaner than separate add/remove pairs. |
| `mail_send`           | `mail_send`                       | `users.messages.send` with `raw` (RFC 822 base64url)     | build MIME with multipart/alternative + multipart/mixed when attachments. CC/BCC headers honoured. `save_to_sent` → Gmail always saves to SENT (no opt-out); document the difference and accept the arg silently. |
| `mail_create_draft`   | `mail_create_draft`               | `users.drafts.create`                                    | |
| `mail_update_draft`   | `mail_update_draft`               | `users.drafts.update`                                    | |
| `mail_send_draft`     | `mail_send_draft`                 | `users.drafts.send`                                      | |
| `mail_reply`          | `mail_reply`                      | `users.messages.send` with `threadId` + `In-Reply-To` / `References` headers from the original | Gmail threads by header chain; we set `threadId` to keep the response in-thread. `comment`-style replies (note above quoted body): we build the quoted body ourselves from the original message — Graph's `comment`+`reply` server-side composition has no exact Gmail equivalent. |
| `mail_reply_all`      | `mail_reply_all`                  | same as above; include `Cc:` from original                | |
| `mail_forward`        | `mail_forward`                    | `users.messages.send` (`Subject: Fwd: …`, body wraps original) | no native forward endpoint; we compose. |
| `mail_move`           | `mail_move`                       | thin wrapper over `mail_apply_labels`: `add: [<dest>]`, `remove: [INBOX]` (or whatever the message currently has from the "system mailbox" set) | document this is "add label & remove from INBOX" — semantically different from a folder move. |
| `mail_mark_read`      | `mail_mark_read`                  | `users.messages.modify` `removeLabelIds=[UNREAD]`        | |
| `mail_mark_unread`    | `mail_mark_unread`                | `users.messages.modify` `addLabelIds=[UNREAD]`           | |
| `mail_flag`           | `mail_flag`                       | `users.messages.modify` `addLabelIds=[STARRED]` / removeLabelIds | Gmail has STARRED only (no tri-state "flagged/complete/notFlagged"). Accept the outlook arg shape but collapse `flagged`+`complete`→add STARRED, `notFlagged`→remove STARRED. Document. |
| `mail_delete`         | `mail_delete`                     | `users.messages.trash` (recoverable; in TRASH 30 days) | matches outlook's "soft delete → Deleted Items". No permanent-delete tool by design. |
| `mail_listen_inbox`   | `mail_listen_inbox`               | poll loop over `users.history.list(startHistoryId)` filtered to `historyTypes=messageAdded` and `labelId=INBOX` | History API is the right tool: delta queries, no clock skew issues. First call seeds `since_token` from `users.getProfile().historyId`. Subsequent calls send the cursor back as `next_token`. Falls back to `messages.list(q='newer_than:1h')` only if history is too old (>1 week, server returns 404). |
| —                     | `mail_get_thread` (NEW)           | `users.threads.get`                                      | Threads are first-class in Gmail and very useful. Returns all messages in the conversation, sorted, with full bodies (configurable like `mail_get`). |
| —                     | `mail_list_threads` (NEW)         | `users.threads.list` with `q=`                           | mirror of `mail_list` but at thread granularity. Cheap because outlook agents often reach for "find this conversation". |

Notes:
- **No `mail_listen_folder`-equivalent for arbitrary labels** in v1 — `mail_listen_inbox` always uses `INBOX`. Easy to generalise later if needed.
- **Batch endpoint**: Gmail offers `users.messages.batchGet` / `batchModify` — we'll use these where parity tools fan out (e.g., `mail_list` enrichment) but the public surface is single-id.
- **Pagination**: Gmail uses `pageToken` (not `@odata.nextLink`). The internal `gmailList()` helper will mirror `graphList()` and handle `nextPageToken` + a `maxResults` cap.

### Calendar (mostly parity, with model differences flagged)

| outlook tool                    | gmail-mcp tool                  | backend                                       | notes |
| ---                             | ---                             | ---                                           | --- |
| `calendar_list_calendars`       | `calendar_list_calendars`       | `calendarList.list`                           | same shape: `{ id, name, color, is_default: c.primary===true, can_edit: c.accessRole in ['owner','writer'], owner }`. |
| `calendar_list_events`          | `calendar_list_events`          | `events.list(timeMin, timeMax, singleEvents=true, orderBy=startTime)` | `singleEvents=true` expands recurrences (matches Graph's `calendarView`). Timezone honoured via `timeZone=` param. |
| `calendar_get_event`            | `calendar_get_event`            | `events.get`                                  | |
| `calendar_find_free_slots`      | `calendar_find_free_slots`      | `freebusy.query` (preferred) + same client-side working-hours filter (reuse `lib/working-hours.ts` and `lib/intervals.ts` from outlook-mcp verbatim) | `freebusy` is purpose-built and supports multi-calendar in one call — better than outlook's fetch-and-merge. Working-hours filter logic is unchanged. |
| `calendar_create_event`         | `calendar_create_event`         | `events.insert` (`sendUpdates`, `conferenceDataVersion=1` when Meet) | recurrence: `recurrence` arg → RRULE string array (built from the same structured `pattern`+`range` shape as outlook for parity; see "Recurrence translation" below). |
| `calendar_update_event`         | `calendar_update_event`         | `events.patch`                                | RRULE replacement same as create. |
| `calendar_list_event_instances` | `calendar_list_event_instances` | `events.instances(calendarId, eventId)`       | each instance has its own id; pass it to `calendar_update_event`/`calendar_delete_event` to modify or skip that occurrence. |
| `calendar_delete_event`         | `calendar_delete_event`         | `events.delete` (with `sendUpdates=all` when `cancel_with_notification=true`) | Google has no separate "cancel" verb — `delete` with `sendUpdates=all` is the cancel-with-notification path. Match the outlook arg semantics. |
| `calendar_respond`              | `calendar_respond`              | `events.patch` with the caller as attendee, `responseStatus` updated | Google has no `accept`/`decline` action endpoint — you patch your own attendee row. `propose_new_time` is not supported in the v3 API; we'll return a clear "not supported on Google Calendar" error if passed (or no-op + warning). |

### Online meetings (Google Meet)

Outlook's online-meeting pain is Teams free auto-overriding the URL. **Gmail's pain is different**: Meet URLs are *only* created when you set `conferenceData.createRequest` with a fresh `requestId` and pass `conferenceDataVersion=1`. You can't attach a Zoom link in `conferenceData` — third-party meeting providers require G-Suite Marketplace add-ons. Practical behaviour for v1:

- `is_online_meeting: true` + no `online_meeting` arg → create a Google Meet (`conferenceData.createRequest` with `conferenceSolutionKey.type=hangoutsMeet`). After creation, surface the `hangoutLink` field as `online_meeting_url`.
- `online_meeting: { join_url: "<zoom>..." }` → put the URL in `location` and prepend it to the body. Return a `warnings` entry: `{ kind: "third_party_meeting_in_body", ... }` mirroring outlook-mcp's warning shape. Document this clearly.
- The contract is: **agents using `calendar_create_event` get a Meet link for free if they ask for one; if they pass their own URL, it goes in location/body.** Symmetric with outlook's personal-account behaviour.

### Recurrence translation

Outlook uses a structured `{pattern, range}` JSON. Google uses RFC 5545 RRULE strings. We keep the outlook-shaped arg and translate inside the tool — agents don't have to learn two recurrence languages:

| outlook `pattern.type` | RRULE `FREQ=` + extras |
| --- | --- |
| `daily`             | `FREQ=DAILY;INTERVAL=n` |
| `weekly`            | `FREQ=WEEKLY;INTERVAL=n;BYDAY=MO,WE,FR` (from `days_of_week`); `WKST=` from `first_day_of_week` |
| `absoluteMonthly`   | `FREQ=MONTHLY;INTERVAL=n;BYMONTHDAY=<day_of_month>` |
| `relativeMonthly`   | `FREQ=MONTHLY;INTERVAL=n;BYDAY=<n>MO` (index → 1/2/3/4/-1) |
| `absoluteYearly`    | `FREQ=YEARLY;BYMONTH=m;BYMONTHDAY=d` |
| `relativeYearly`    | `FREQ=YEARLY;BYMONTH=m;BYDAY=<n>MO` |

Range:
- `range.type=endDate` → `UNTIL=YYYYMMDDT235959Z` (converted to UTC from `range.timezone`).
- `range.type=noEnd` → no terminator.
- `range.type=numbered` → `COUNT=n`.

Google's `events.insert` also wants `start.timeZone` / `end.timeZone` (IANA — no Windows TZ strings, so we'll reject Windows TZs at the boundary with a helpful error pointing at IANA equivalents).

### Contacts (read-only, 2 tools — parity)

| outlook tool      | gmail-mcp tool    | backend                                                                                    | notes |
| ---               | ---               | ---                                                                                        | --- |
| `contacts_search` | `contacts_search` | `people.people.searchContacts(query, readMask=names,emailAddresses,phoneNumbers,organizations)` | "Other contacts" (people you've emailed but not saved) are reachable via `otherContacts.search` — we union both for parity with Outlook's "personal contacts" set, which is similarly inclusive. |
| `contacts_get`    | `contacts_get`    | `people.people.get(resourceName=people/<id>, personFields=…)`                              | |

---

## 2. Auth strategy

**Recommendation: fresh OAuth, separate client + token cache, but reuse `gdrive-mcp`'s pattern verbatim.**

Why not literally reuse `gdrive-mcp`'s credentials / token file:
- Different scopes (gmail.modify + gmail.send + calendar + contacts.readonly vs drive.readonly + spreadsheets.readonly). Sharing one token = over-granted on both sides, and re-consent prompts every time scopes change.
- gdrive-mcp's OAuth client is one Cloud project; if the user wants to revoke just gmail-mcp later, separate clients keep that simple.
- A single Cloud project can host multiple OAuth clients with the same verification + branding, so this isn't more setup work.

What we reuse from `gdrive-mcp/src/auth.ts`:
- Loopback redirect on `127.0.0.1:0` (random port) — same pattern, same `googleapis` `OAuth2Client.generateAuthUrl` + token exchange.
- `prompt: "consent"` on first sign-in so we always get a `refresh_token`.
- `credentialsFile` env var pointing at the downloaded `credentials.json` (installed-app type from Google Cloud Console).
- `tokenFile` env var with a sane default.

Differences from gdrive-mcp:
- Add a CLI (`gmail-mcp-auth login | status | logout`) matching the outlook-mcp ergonomics — gdrive-mcp authenticates on every server start, which is slower and surfaces browser flow into Claude Code's MCP logs at startup. Better to do it once via CLI like outlook-mcp does.
- Refresh-token rotation: Google's refresh tokens don't rotate unless you opt in, but they *do* get revoked on inactivity (>6 months) or password change. The token-acquire path should detect `invalid_grant` and emit a clear "Run `gmail-mcp-auth login` again" error, same as outlook-mcp's "Not signed in" message.

Scopes (full surface; we'll add `.metadata` variants if we ever want a read-only mode):
```
https://www.googleapis.com/auth/gmail.modify         # list/get/modify/trash/labels — covers everything except permanent delete (we don't expose) and send (separate)
https://www.googleapis.com/auth/gmail.send           # mail_send / mail_send_draft / mail_reply*
https://www.googleapis.com/auth/calendar             # full calendar r/w
https://www.googleapis.com/auth/contacts.readonly    # contacts_search / contacts_get
```

(Not `gmail.readonly` — it's a strict subset of `gmail.modify`. Not `gmail.compose` — it's send-without-list, which we don't want.)

Env vars (parity with outlook-mcp naming):
| Var                            | Default                                       | Purpose |
| ---                            | ---                                           | --- |
| `GMAIL_MCP_CREDENTIALS_FILE`   | _(required)_                                  | Path to downloaded `credentials.json` from Google Cloud Console (OAuth 2.0 client id, "Desktop app" type). |
| `GMAIL_MCP_TOKEN_PATH`         | `~/.config/gmail-mcp/tokens.json`             | Where the refresh token + access token cache live. `0600`. |
| `GMAIL_MCP_REDIRECT_PORT`      | _(random)_                                    | Pin the loopback port if firewall policy requires it. |

---

## 3. Differences worth flagging up front (and how the plan addresses each)

1. **Labels vs folders.** Documented above. Tool surface keeps `mail_move` for muscle memory but its semantics are documented as "add label, remove INBOX". New tool `mail_apply_labels` is the honest primitive.
2. **Threads vs conversations.** Outlook has `conversationId` as metadata; Gmail elevates the thread. We surface `thread_id` on every compact message and add `mail_get_thread` / `mail_list_threads`.
3. **Recurrence: RRULE vs structured.** Translation table above; we keep the structured arg shape from outlook-mcp so agents don't need to learn RFC 5545.
4. **Recurrence instance ids.** Graph: `<series_id>` → list_instances returns child events with their own ids. Google: `events.instances` returns instance ids of shape `<recurringEventId>_<occurrenceStartUTC>`. Either way the agent just passes the id back to update/delete. Document the shape, don't try to hide it.
5. **Meet URLs.** `conferenceData.createRequest` model documented; no Zoom/Webex injection (workaround: location/body, same as outlook on personal accounts).
6. **Send-from-sent flag.** Gmail always saves to SENT; we accept the outlook flag and silently ignore.
7. **Flag tri-state.** Gmail has STARRED only; we collapse outlook's `flagged|complete|notFlagged` into add/remove STARRED.
8. **History API vs polling.** `mail_listen_inbox` uses `users.history.list` — strictly better than outlook-mcp's `receivedDateTime gt cursor` polling (no clock skew, no missed events, server-side delta). Slight cost: have to detect "history too old" (history records older than ~7 days are garbage-collected) and fall back gracefully.
9. **Working hours.** Gmail/Calendar doesn't expose working-hours on the user profile. `mailbox_get_settings` returns the user's Calendar timezone; `calendar_find_free_slots` takes explicit `working_hours_start`/`_end` args (already the case in outlook-mcp). The reusable lib/working-hours.ts code is unchanged.
10. **`$search` vs `q`.** Gmail's `q` syntax is *more* powerful and well-documented. We expose `q` verbatim through `mail_search` and document common patterns in the tool description (mirroring how outlook-mcp documents KQL examples).
11. **Attachment size.** Gmail uploads >5MB need resumable upload; we'll cap `mail_send` attachments at 25MB total (Gmail's send limit) and document. Per-attachment >5MB still goes through the simple `messages.send` path with raw RFC 822 because we're constructing the MIME ourselves — same shape as the small case.
12. **Rate limits.** Per-user ≈ 250 quota units/sec for Gmail; Calendar lower. Same exponential-backoff-with-Retry-After helper as outlook-mcp's `graphRequest`, ported to the Google client. Retry on 429 + 5xx.
13. **`responseStatus`** Google's attendee response semantics are looser than Outlook's — there's no `tentativelyAccept` action endpoint, you patch the attendee row. The tool surface stays the same; the implementation patches `attendees[me].responseStatus` then PATCHes the event.

---

## 4. Repo layout

Mirror outlook-mcp 1:1 — the structure has earned its keep:

```
gmail-mcp/
├─ README.md                 # quickstart + Google Cloud Console setup steps
├─ LICENSE                   # MIT (match outlook-mcp)
├─ package.json
├─ tsconfig.json
├─ PLAN.md                   # this file (kept until v0.1.0 ships)
└─ src/
   ├─ server.ts              # MCP stdio entrypoint — register{Account,Mail,Calendar,Contacts}Tools
   ├─ config.ts              # env-driven config + SCOPES const
   ├─ auth/
   │  ├─ oauth.ts            # google-auth-library OAuth2Client factory (mirrors outlook-mcp/auth/msal.ts)
   │  ├─ store.ts            # file-backed token cache, 0600 (mirrors outlook-mcp/auth/store.ts)
   │  ├─ login.ts            # interactive loopback flow + logout/status
   │  └─ token.ts            # getAccessToken() — refresh-on-demand for runtime
   ├─ google/
   │  ├─ client.ts           # authed fetch wrapper + paging + 429/5xx retry (mirrors outlook-mcp/graph/client.ts)
   │  ├─ mime.ts             # RFC 822 build/parse for send + get (NEW vs outlook-mcp)
   │  └─ rrule.ts            # pattern/range ↔ RRULE translation (NEW)
   ├─ lib/
   │  ├─ intervals.ts        # ← copy verbatim from outlook-mcp (pure)
   │  └─ working-hours.ts    # ← copy verbatim from outlook-mcp (pure)
   ├─ tools/
   │  ├─ helpers.ts          # ok/err/recipientList — adapted for Gmail headers
   │  ├─ account.ts          # who_am_i, mailbox_get_settings
   │  ├─ mail.ts             # mail_* + mail_list_threads / mail_get_thread / mail_create_label / mail_apply_labels
   │  ├─ calendar.ts         # calendar_*
   │  └─ contacts.ts         # contacts_search / contacts_get
   └─ bin/
      └─ auth.ts             # gmail-mcp-auth CLI: login | status | logout

tests/
├─ rrule.test.ts             # pattern ↔ RRULE round-trip
├─ mime.test.ts              # MIME build (headers, multipart, attachments, threading headers)
├─ intervals.test.ts         # copied
└─ working-hours.test.ts     # copied
```

**Dependencies** (lean — match outlook-mcp's philosophy):
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "googleapis": "^144.0.0",          // for type-safe Gmail/Calendar/People clients + OAuth2Client
    "zod": "^3.23.8"
  }
}
```
Runtime: `bun` (parity with outlook-mcp). `googleapis` works fine under Bun.

---

## 5. Phased build order (smallest shippable first)

Each phase ends with something an agent can actually use. Don't build all of calendar before mail is usable, etc.

**Phase 0 — Scaffolding** (½ day)
- `package.json`, `tsconfig.json`, README skeleton.
- `src/config.ts` (env vars + scopes).
- `src/auth/{oauth.ts, store.ts, login.ts, token.ts}` ported from gdrive-mcp + outlook-mcp patterns.
- `src/bin/auth.ts` CLI.
- `src/server.ts` boots MCP and registers nothing yet.
- **Smoke test**: `gmail-mcp-auth login` works end-to-end.

**Phase 1 — Mail read** (1 day)
- `src/google/client.ts` (authed fetch + retry + pagination helper).
- `src/google/mime.ts` (parse only for now).
- `src/tools/account.ts`: `who_am_i`, `mailbox_get_settings`.
- `src/tools/mail.ts`: `mail_list`, `mail_search`, `mail_get`, `mail_get_attachment`, `mail_list_labels`, `mail_get_thread`, `mail_list_threads`.
- **Ships at end of phase 1**: agent can read and triage mail. This alone is the most-asked-for missing feature in the official Google MCP.

**Phase 2 — Mail write** (1 day)
- `src/google/mime.ts` (build): RFC 822 with multipart/alternative + multipart/mixed.
- `mail_send`, `mail_create_draft`, `mail_update_draft`, `mail_send_draft`, `mail_reply`, `mail_reply_all`, `mail_forward`.
- `mail_apply_labels`, `mail_create_label`, `mail_move` (alias), `mail_mark_read`, `mail_mark_unread`, `mail_flag`, `mail_delete`.
- **Ships at end of phase 2**: full mail parity with outlook-mcp.

**Phase 3 — Inbox listener** (½ day)
- `mail_listen_inbox` using `users.history.list`.
- Handle the "history too old" 404 → reseed from `getProfile().historyId`.
- **Ships**: agent loops that watch the inbox in near-real-time.

**Phase 4 — Calendar read** (½ day)
- `src/lib/intervals.ts` + `working-hours.ts` (copy from outlook-mcp).
- `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`, `calendar_list_event_instances`, `calendar_find_free_slots` (via `freebusy.query`).
- **Ships**: scheduling-assistant flows.

**Phase 5 — Calendar write** (1 day)
- `src/google/rrule.ts` (pattern/range → RRULE).
- `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_respond`.
- Meet auto-provisioning via `conferenceData.createRequest`.
- **Ships**: full calendar parity. v0.1.0 candidate.

**Phase 6 — Contacts + polish** (½ day)
- `contacts_search` (union of People `searchContacts` + `otherContacts.search`), `contacts_get`.
- README finalised (Google Cloud Console step-by-step with screenshots-in-prose, matching outlook-mcp README's tone).
- `tests/` filled out.
- **Ships v0.1.0**.

Total: ~5 days of focused work, smaller chunks individually shippable. Each phase can be its own PR.

---

## 6. Open questions for Leandro

These genuinely need a decision before code starts — please answer inline.

1. **Single OAuth client or shared with gdrive-mcp?** Recommendation: separate OAuth client in the same Google Cloud project as gdrive-mcp. Confirm? (Alternative: reuse the same `credentials.json` path and just request more scopes — works but conflates revocation/audit.)

2. **Scope breadth.** Plan above uses `gmail.modify` + `gmail.send` + `calendar` + `contacts.readonly`. Are you OK granting `gmail.modify` (it's everything except permanent-delete + send), or do you want a read-only mode toggle (`GMAIL_MCP_READ_ONLY=true` → switch to `gmail.readonly`)? Outlook-mcp doesn't have one.

3. **Threads tools — included or skipped for v0.1.0?** Adding `mail_get_thread` + `mail_list_threads` *is* a parity break (outlook has no equivalents), but it's the biggest single ergonomics win on Gmail. Recommend: include. Confirm?

4. **`mail_flag` tri-state.** Recommend collapsing `flagged`+`complete` → STARRED, `notFlagged` → unstar. Alternative: rename to `mail_star`/`mail_unstar` and drop parity. Which?

5. **`calendar_respond` with `propose_new_time`.** Not natively supported on Google Calendar. Options:
   - (a) accept the arg, return a `warnings` entry, ignore the proposal silently;
   - (b) reject with a clear error if `propose_new_time` is set on Google;
   - (c) implement it as a sidecar email reply with the proposed time in the body.

   Recommend (b) — surfaces the limit honestly, matches "don't pretend semantics we don't have".

6. **Meet auto-provisioning default.** Should `is_online_meeting: true` (with no `online_meeting` arg) automatically create a Meet link? Recommend: yes — symmetric with outlook-mcp's "set isOnlineMeeting=true and get a Teams URL". Confirm.

7. **License.** outlook-mcp is MIT. gdrive-mcp is PolyForm-Strict-1.0.0 (non-commercial-friendly). Which for gmail-mcp? Recommend MIT to match outlook-mcp's "public utility" framing.

8. **Server name in MCP catalog.** Match outlook-mcp's pattern: `name: "gmail-mcp"`. Confirm or do you want a different display label?

9. **Out of scope for v0.1.0 (confirm)**:
   - Gmail filters API (`users.settings.filters.*`).
   - Forwarding addresses / SMIME (`users.settings.{forwardingAddresses,smimeInfo}.*`).
   - Calendar ACL / sharing (`acl.*`).
   - Cloud Pub/Sub `users.watch` push notifications (we use history-API polling instead — no Pub/Sub infra dependency).
   - Multi-account in one server instance.

   Recommend deferring all of these. Confirm?
