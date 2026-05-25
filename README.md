# gmail-mcp

An MCP server that gives Claude (or any MCP client) read/write access to a Google account — Gmail, Google Calendar, and read-only People (contacts) — via the Google REST APIs.

Modelled on `outlook-mcp`; tool names and argument shapes match wherever the underlying systems allow, so an agent that knows one knows the other. Differences (labels vs folders, threads, RRULE recurrence, Google Meet vs third-party meetings) are documented in `PLAN.md` §3.

## Capabilities

**Account (2 tools):** `who_am_i`, `mailbox_get_settings` (timezone, auto-responder).

**Auth (2 tools):** `auth_status` (cheap probe — are tokens still valid for this profile?), `auth_login` (returns a Monitor() invocation that drives `gmail-mcp-auth wait`; the agent shows the returned `auth_url` to the user, the loopback collects the callback and persists new tokens — no shell-out, no risk of writing to the wrong profile).

**Mail (23 tools):** `mail_list`, `mail_search` (Gmail `q` syntax), `mail_get`, `mail_get_attachment`, `mail_list_labels`, `mail_create_label`, `mail_apply_labels`, `mail_get_thread`, `mail_list_threads`, `mail_send`, `mail_create_draft`, `mail_update_draft`, `mail_send_draft`, `mail_reply`, `mail_reply_all`, `mail_forward`, `mail_move`, `mail_mark_read`, `mail_mark_unread`, `mail_flag`, `mail_delete`, `mail_listen_inbox` (long-poll via history API), `mail_listen_instructions` (returns a Monitor() invocation for a persistent NDJSON event stream — firehose, or filtered to one thread for "watch replies to this email").

**Calendar (7 tools):** `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`, `calendar_list_event_instances`, `calendar_find_free_slots` (multi-calendar via `freeBusy`), `calendar_create_event` (with Google Meet auto-provision), `calendar_update_event`, `calendar_delete_event`, `calendar_respond`.

**Contacts (2 tools, read-only):** `contacts_search` (unions saved + "other" contacts), `contacts_get`.

## Quickstart

```bash
git clone <this-repo> gmail-mcp && cd gmail-mcp
bun install
cp .env.example .env                                          # then edit .env with your credentials path
bun run login                                                 # one-time browser sign-in (reads .env)
claude mcp add gmail --scope user \
  -e GMAIL_MCP_CREDENTIALS_FILE="$(grep ^GMAIL_MCP_CREDENTIALS_FILE .env | cut -d= -f2-)" \
  -- bun run "$PWD/src/server.ts"
```

Restart Claude Code; the Gmail and Calendar tools become available to any agent.

## One-time setup

### 1. Create an OAuth client in Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and pick (or create) a project. If you also use `gdrive-mcp`, you can use the same project — but create a **separate OAuth client** for gmail-mcp so scopes and revocation stay isolated (see `DECISIONS.md` #1).

2. **Enable the APIs** this server uses:
   - APIs & Services → Library → enable each:
     - **Gmail API**
     - **Google Calendar API**
     - **People API**

3. **Configure the OAuth consent screen** (one-time per project, if not already done):
   - APIs & Services → OAuth consent screen
   - User type: **External**
   - App name: anything (e.g. `gmail-mcp`)
   - Add yourself as a **Test user** so the unverified-app consent screen will accept your Google account during development.
   - Scopes — you do not need to add them here; Google asks for them at sign-in time.

4. **Create the OAuth client:**
   - APIs & Services → Credentials → **+ Create credentials** → **OAuth client ID**
   - Application type: **Desktop app**
   - Name: e.g. `gmail-mcp desktop`
   - Click Create. In the dialog, click **Download JSON** — save it somewhere safe (e.g. `~/.config/gmail-mcp/credentials.json`).

The downloaded file has `installed.client_id` and `installed.client_secret` — that's what gmail-mcp reads.

### 2. Install the server

```bash
git clone <this-repo> gmail-mcp
cd gmail-mcp
bun install
```

### 3. Sign in (one time)

Copy the example env file and fill in the path to the credentials JSON you just downloaded:

```bash
cp .env.example .env
$EDITOR .env   # set GMAIL_MCP_CREDENTIALS_FILE to the path of your downloaded JSON
bun run login
```

`bun run` auto-loads `.env`, so subsequent `bun run status` / `bun run logout` / `bun test` all see those values without having to `export` anything. (You can still set the env vars explicitly in the shell if you prefer — the explicit form wins over `.env`.)

A browser tab opens. Sign in with the same Google account you added as a test user, then grant the scopes Google lists. Tokens are written to `~/.config/gmail-mcp/tokens.json` (mode `0600`). Google's refresh tokens for unverified apps expire after **7 days** of inactivity — you'll need to re-run `login` if that happens. For an app marked "In production" + verified, refresh tokens last indefinitely until revoked.

Useful commands:

```bash
bun run status    # who am I signed in as
bun run logout    # revoke + clear local token cache
```

### Multiple accounts (profiles)

To sign into more than one Google account on the same machine, pass a profile name as a positional argument. Each profile gets its own token file at `~/.config/gmail-mcp/tokens-<profile>.json`; the original `tokens.json` (no profile) is untouched.

```bash
bun run login work      # signs into account #2, tokens → tokens-work.json
bun run status work     # who am I in 'work'
bun run logout work     # revoke just 'work'
bun run profiles        # list profiles with tokens on disk
```

When wiring multiple profiles into Claude Code, register each as its own MCP server with `GMAIL_MCP_PROFILE` set:

```bash
# Default account (no profile)
claude mcp add gmail --scope user \
  -e GMAIL_MCP_CREDENTIALS_FILE="$HOME/.config/gmail-mcp/credentials.json" \
  -- bun run "$PWD/src/server.ts"

# Second account (profile: work)
claude mcp add gmail-work --scope user \
  -e GMAIL_MCP_CREDENTIALS_FILE="$HOME/.config/gmail-mcp/credentials.json" \
  -e GMAIL_MCP_PROFILE=work \
  -- bun run "$PWD/src/server.ts"
```

Claude then exposes both as separately namespaced tool sets: `mcp__gmail__mail_list`, `mcp__gmail-work__mail_list`, etc. Profile names must match `/^[a-zA-Z0-9_-]+$/`.

### 4. Wire into Claude Code

Add to your Claude Code MCP settings (`~/.config/claude-code/config.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "gmail": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/gmail-mcp/src/server.ts"],
      "env": {
        "GMAIL_MCP_CREDENTIALS_FILE": "/absolute/path/to/credentials.json"
      }
    }
  }
}
```

Or equivalently:

```bash
claude mcp add gmail --scope user \
  -e GMAIL_MCP_CREDENTIALS_FILE=/absolute/path/to/credentials.json \
  -- bun run "$PWD/src/server.ts"
```

Restart Claude Code. The Gmail and Calendar tools become available to any agent in that environment.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `GMAIL_MCP_CREDENTIALS_FILE` | _(required)_ | Path to the OAuth client JSON downloaded from Google Cloud Console (the file containing `installed.client_id` and `installed.client_secret`). |
| `GMAIL_MCP_TOKEN_PATH` | `~/.config/gmail-mcp/tokens.json` | Where the refresh + access tokens are cached (mode `0600`). |
| `GMAIL_MCP_REDIRECT_PORT` | _(random)_ | Pin the loopback redirect port (useful if your network policy is strict). |
| `GMAIL_MCP_LOGIN_TIMEOUT_MS` | `300000` (5 min) | Timeout for `gmail-mcp-auth wait` and the `auth_login` MCP tool. |

## Scopes requested

```
https://www.googleapis.com/auth/gmail.modify         # list/get/modify/labels/trash — everything except permanent delete (not exposed) and send (next line)
https://www.googleapis.com/auth/gmail.send           # mail_send / mail_send_draft / mail_reply* / mail_forward
https://www.googleapis.com/auth/calendar             # full calendar r/w
https://www.googleapis.com/auth/contacts.readonly    # saved contacts
https://www.googleapis.com/auth/contacts.other.readonly  # "other" contacts (people you've emailed but not saved)
```

## Safety notes

- `mail_delete` moves the message to **TRASH** (Gmail's recoverable bin — 30 days). There is no permanent-delete tool — by design.
- `calendar_delete_event` with `cancel_with_notification=true` sends Google's standard cancellation emails to attendees. Pass `false` to delete silently if you're the organizer and don't want a notification storm.
- Token cache is created with `0600` permissions where supported.

## Differences from outlook-mcp

| Concept | Outlook | Gmail |
| --- | --- | --- |
| Categorization | Folders (parent_id, one) | **Labels** (one message → many) |
| Conversation | `conversationId` metadata | **Threads** are first-class; new tools `mail_get_thread` / `mail_list_threads` |
| Search | Graph `$search` (KQL-like) | Gmail `q` (richer; `from:`, `subject:`, `has:attachment`, `newer_than:7d`, `label:`, `-label:inbox`, …) |
| Listen | Poll by `receivedDateTime` | History API delta (`users.history.list`) |
| Recurrence | Structured `{pattern, range}` | RRULE strings (translated for you — same outlook-shaped arg) |
| Meeting link | Auto-provisioned Teams URL (and Teams free auto-overwrites Zoom/Meet on personal accounts) | Auto-provisioned **Google Meet** URL via `conferenceData.createRequest`. Third-party URLs (Zoom/Webex/etc.) cannot be attached to `conferenceData` — they go in `location` and body, with a `warnings` entry. |
| Flag | Tri-state `notFlagged \| flagged \| complete` | STARRED only (the tri-state collapses to add/remove STARRED — accepted for arg parity) |
| `propose_new_time` on responses | Supported by Graph | **Not supported by Google Calendar API** — `calendar_respond` rejects this arg with a clear error. |

See `PLAN.md` §3 for the full list and `DECISIONS.md` for the v0.1.0 choices.

## Layout

```
src/
├─ server.ts            # MCP stdio entrypoint
├─ config.ts            # env-driven config + scopes
├─ auth/
│  ├─ oauth.ts          # google-auth-library OAuth2Client factory
│  ├─ store.ts          # file-backed token cache, 0600
│  ├─ login.ts          # loopback flow (interactive + headless event-emitting) + logout/status
│  ├─ lock.ts           # per-profile single-flight lock for `gmail-mcp-auth wait`
│  └─ token.ts          # getAccessToken — auto-refreshes
├─ google/
│  ├─ client.ts         # authed fetch wrapper + paging + 429/5xx retry
│  ├─ mime.ts           # RFC 822 build/parse for send + get
│  └─ rrule.ts          # pattern/range ↔ RRULE translation
├─ lib/
│  ├─ intervals.ts      # pure: merge busy intervals
│  └─ working-hours.ts  # pure: tz-aware working-hours filter
├─ tools/
│  ├─ helpers.ts
│  ├─ account.ts        # who_am_i, mailbox_get_settings
│  ├─ auth.ts           # auth_status, auth_login (agent-triggered re-auth)
│  ├─ mail.ts           # mail_* tools (22)
│  ├─ calendar.ts       # calendar_* tools (7)
│  └─ contacts.ts       # contacts_* tools (read-only)
└─ bin/
   └─ auth.ts           # gmail-mcp-auth CLI

tests/                  # bun:test unit tests for the pure helpers
```

## Troubleshooting

- **`invalid_grant` from auth tools, hours-or-days after `login`:** for unverified apps Google expires refresh tokens after 7 days of inactivity. Re-run `gmail-mcp-auth login`. To eliminate the 7-day clock, publish the OAuth consent screen and verify the app.
- **`access_denied` at the consent screen:** the Google account you're signing in with isn't on the **Test users** list. Add it in OAuth consent screen → Test users.
- **`This app isn't verified` warning at consent:** expected for an unverified Desktop client. Click "Advanced" → "Go to gmail-mcp (unsafe)" — it's *your* OAuth client; only you can sign into it.
- **`Not signed in` from the MCP server:** the server reuses the local token cache. Run `bun run src/bin/auth.ts status` to verify, then `... login` if missing. From inside an agent session you can also call the `auth_login` MCP tool — it returns a Monitor() invocation that drives the `gmail-mcp-auth wait` CLI for the **same profile this server is running as**, so there's no risk of writing tokens to the wrong account.
- **Third-party meeting URL silently moved to `location`:** intended — Google's `conferenceData` does not accept third-party join URLs. See `PLAN.md` §3 item 5 and the `warnings` entry on the response.
- **`calendar_respond` rejects `propose_new_time`:** intended — Google Calendar has no equivalent API. Decline with a comment + email the organizer instead.
- **`mail_listen_inbox` returns `reseeded: true`:** your `since_token` was older than ~7 days (Gmail's history retention). The cursor was reset to "now" and some messages may have been missed in the gap.

## License

MIT — see `LICENSE`.
