---
name: outreach-ledger
description: Add a thread-tracking outreach ledger to any project — sent/replied/due-touch states, read-only inbox polling, follow-up flags that never auto-send. Use when the user says "add an outreach ledger", "track my threads/outreach/follow-ups", "stop things rotting at awaiting-reply", or a project has emails/conversations in flight with no system watching them. Kills the await-reply failure mode: silence looks identical to progress until a system enforces the cadence.
---

# Outreach Ledger

Give a project a nervous system for its in-flight conversations: a ledger of every thread,
due-touch flags, and optional read-only inbox polling. The system observes and reminds;
humans draft and send.

**Reference implementation ships in this folder**: `outreach.mjs` (ledger + CLI),
`outreach-poll.mjs` (read-only IMAP poller with reply AND bounce detection),
`seed.example.json`. Copy and adapt rather than reinvent. Requires node; `npm install` in
this folder pulls the two dependencies (better-sqlite3, imapflow).

## Recipe

1. **Scope the threads.** List every conversation the project has in flight: who, org,
   email (if known), channel, current state, what was last sent and when. Ask the user to
   confirm the list — seeds are facts, not guesses.
2. **Ledger table** in the project's existing store (SQLite via `outreach.mjs`, or a
   markdown/JSON ledger for code-free projects): target, org, email, thread_subject,
   channel, status (`drafted → sent → replied → in_conversation → terms_sent → signed →
   dormant → closed`, plus `bounced` as a dead-end — rename states to fit the domain),
   doctrine, dates, touch_count, notes. Seed idempotently (re-running the seed must add nothing).
3. **CLI or checklist**: `--list` (grouped by status), `--touch <id>` (update state +
   next date), `--due` (rows where next_touch_at ≤ today, each with a suggested action).
4. **Due-action wording matters**: warm/personal relationships → "human touch due — nudge
   the user, no draft"; cold/transactional sends → "day-N follow-up due — draft with
   approval". Third un-replied touch → suggest marking dormant.
5. **Inbox poller (optional, needs mailbox creds in a gitignored .env)**: IMAP scan since
   last-seen UID; store the UID cursor. Two reconciliations, both mandatory:
   - **Reply**: a From match on a watched address → flip to `replied`, surface an alert.
   - **Bounce**: a delivery-status/NDR from `mailer-daemon`/`postmaster` → parse the failed
     recipient from the body and flip that row to `bounced`. Without it, a dead address sits
     at `sent` forever, indistinguishable from awaiting-reply — the precise failure this skill
     exists to kill. A reply-only poller is not "working fully".
   Read-only per the hard rules below.

## Hard rules (do not soften)

- **No auto-send code path exists, anywhere.** The ledger flags; drafting happens with the
  user; the user approves every outbound. Do not build a "send follow-up" function even
  behind a flag.
- **Respect the project's contact doctrine.** Some threads must never be nudged (a client
  who comes to you; a relationship where chasing costs more than silence). Set
  `doctrine: "no-chase"` — tracked in `--list`, structurally excluded from `--due`.
- **Poller is read-only** — open folders read-only, touch no flags, unread stays unread.
- **Bounces are a state, not a silence.** The poller must detect NDRs and mark the row
  `bounced`; a dead address masquerading as awaiting-reply defeats the whole ledger.
- **Credentials** live in the project's gitignored env file, never committed, never echoed.

## Verify before finishing

Run the seed twice (second run = 0 changes). Run `--due` and sanity-check the suggested
actions against the doctrine rules. If a poller was wired: one `--once` run against the
real inbox, confirm it reports without mutating (a message's unread state must survive),
and confirm a bounce flips its row to `bounced` (send one deliberately-bad-address test,
or check a past NDR is caught) — not just that replies flip to `replied`.
