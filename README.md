# outreach-ledger

Tracks conversations in flight — who you contacted, what state each thread is in, when
the next touch is due — and polls your inbox read-only to catch replies. Flags follow-ups;
never sends them.

Ships as a standalone CLI and a Claude Code skill.

## Why

Silence looks identical to progress. A thread marked "sent" three weeks ago with nothing
watching it isn't pending — it's dead, and you don't know. The ledger gives every thread a
state and a next-touch date, `--due` says what needs attention today, and the poller flips
threads to `replied` the moment answers land.

## Install

```bash
git clone https://github.com/b1rdmania/outreach-ledger
cd outreach-ledger && npm install
```

As a Claude Code skill (Claude wires the ledger into any project on request):

```bash
git clone https://github.com/b1rdmania/outreach-ledger ~/.claude/skills/outreach-ledger
```

## Usage

```bash
cp seed.example.json seed.json    # edit with your real threads (gitignored)
node outreach.mjs --seed          # idempotent — safe to re-run
node outreach.mjs --list          # everything, grouped by status
node outreach.mjs --due           # what needs a touch today
node outreach.mjs --add --target "Sam Rivers" --org "Acme" --email sam@example.com
node outreach.mjs --touch 3 --status replied --note "wants a call Tue"
node outreach-poll.mjs --once     # read-only inbox scan; cron it for a drumbeat
```

`--due` output:

```
#1 [cold] Sam Rivers (Acme Surveyors) · "intro — your published requirements" · due 2026-07-19 → day-6 follow-up due — draft with approval

1 due. Nothing is sent by this system — drafts need human approval.
```

Statuses: `drafted → sent → replied → in_conversation → terms_sent → signed → dormant → closed`.
They're strings — rename to fit your domain.

## What it doesn't do

- **Send.** There is no send path in this codebase. `--due` suggests actions; a human
  writes and sends. Don't add a send function — that's how ledgers become spam cannons.
- **Nudge protected threads.** Rows with `"doctrine": "no-chase"` (a client who comes to
  you; a relationship where chasing costs more than silence) appear in `--list` but are
  structurally excluded from `--due`.
- **Touch your mailbox.** The poller opens INBOX read-only — never marks, moves, or
  deletes. Unread stays unread.
- **Pester.** The third un-replied follow-up flags "mark dormant after".

## Requirements

Node 18+. For the poller, IMAP credentials in `.env` (copy `.env.example`; use an app
password). Ledger lives in one SQLite file — `./outreach.db` or `$OUTREACH_DB`.

## License

MIT
