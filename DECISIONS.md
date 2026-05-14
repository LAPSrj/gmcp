# gmail-mcp — Decisions taken during v0.1.0 build

PLAN.md's §6 left nine questions open. Leandro greenlit the build with "pick sensible defaults and proceed". This file is the audit trail of what was chosen and why. Anything Leandro wants changed is a small follow-up — none of these locks us into a destructive rewrite.

| # | Question | Chosen | Rationale |
| --- | --- | --- | --- |
| 1 | Separate OAuth client or share gdrive-mcp's `credentials.json`? | **Separate client** in the same Google Cloud project | Clean scope isolation, independent revocation. Setup is one extra OAuth-client click in Cloud Console — README walks through it. |
| 2 | `gmail.modify` breadth vs read-only toggle | **`gmail.modify` always** (no toggle) | Matches outlook-mcp's no-toggle posture. Read-only mode adds env-var surface for a use case nobody's asked for. Easy to add later (`GMAIL_MCP_SCOPE_MODE=readonly`) if needed. |
| 3 | Thread tools in v0.1.0 | **Included** (`mail_get_thread`, `mail_list_threads`) | Threads are first-class on Gmail; agents constantly want "the rest of this conversation". Marginal cost, large ergonomics win. |
| 4 | `mail_flag` tri-state handling | **Collapse to STARRED** (`flagged`/`complete` → add STARRED, `notFlagged` → remove) | Preserves outlook-mcp arg shape so cross-server agent code Just Works. Documented in tool description. |
| 5 | `calendar_respond.propose_new_time` on Google | **Hard reject** with clear error pointing at the limitation | Honest about the gap; no silent half-implementation. Email-sidecar workaround belongs in a future tool if it's actually wanted. |
| 6 | Meet auto-provision when `is_online_meeting: true` | **Yes, auto-provision** via `conferenceData.createRequest` + `conferenceDataVersion=1` | Symmetric with outlook-mcp's `isOnlineMeeting=true` → Teams URL. Surface the resulting `hangoutLink` as `online_meeting_url`. |
| 7 | License | **MIT** | Match outlook-mcp's framing; this is a public utility. |
| 8 | Server name in MCP catalog | **`gmail-mcp`** | Match the package name and outlook-mcp's pattern. |
| 9 | v0.1.0 scope cuts | **Deferred:** Gmail filters API, forwarding-address / SMIME settings, Calendar ACL/sharing, Pub/Sub `users.watch`, multi-account-per-server. | Each is its own design space. Polling-based `mail_listen_inbox` removes the Pub/Sub infra dependency for the common case. |

If any of these need to flip, open an issue (or just tell pigeon next session) — none are load-bearing on the architecture.
