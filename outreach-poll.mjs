#!/usr/bin/env node
// Reply + bounce detection — polls a mailbox, reconciles it against the ledger.
// READ-ONLY on the mailbox: opens INBOX read-only, never deletes/moves/marks, never sends.
// The system tracks and flags; drafting happens with a human and approval.
//
// Two things flip a ledger row (both matter — a dead address stuck at 'sent' looks
// identical to awaiting-reply, the exact failure this skill exists to kill):
//   • From match on a watched address    → 'replied'
//   • bounce/NDR naming a watched address → 'bounced'
//
//   node outreach-poll.mjs --once     # single poll; cron it for a drumbeat
//
// Credentials from ./.env (gitignored; parsed directly, no dotenv) or process.env:
//   OUTREACH_IMAP_HOST · OUTREACH_IMAP_PORT (default 993) · OUTREACH_EMAIL · OUTREACH_EMAIL_PASS
// Poll cursor (last-seen UID + uidvalidity) lives in table outreach_poll_state.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.OUTREACH_DB || './outreach.db');

db.exec(`CREATE TABLE IF NOT EXISTS outreach_poll_state (
  mailbox text primary key,
  uidvalidity integer,
  last_uid integer,
  last_polled_at text
)`);

function env() {
  const out = { ...process.env };
  if (existsSync('./.env')) {
    for (const line of readFileSync('./.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

async function poll() {
  const e = env();
  const host = e.OUTREACH_IMAP_HOST, user = e.OUTREACH_EMAIL, pass = e.OUTREACH_EMAIL_PASS;
  if (!host || !user || !pass) {
    console.log('mailbox not configured — set OUTREACH_IMAP_HOST / OUTREACH_EMAIL / OUTREACH_EMAIL_PASS in .env');
    return;
  }
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host, port: Number(e.OUTREACH_IMAP_PORT || 993), secure: true,
    auth: { user, pass }, logger: false });
  await client.connect();
  const box = await client.mailboxOpen('INBOX', { readOnly: true });

  const uidValidity = Number(box.uidValidity); // imapflow hands back BigInt
  const state = db.prepare("SELECT * FROM outreach_poll_state WHERE mailbox='INBOX'").get();
  let sinceUid = state && state.uidvalidity === uidValidity ? state.last_uid : 0;
  if (sinceUid === 0) console.log(`first poll (or uidvalidity changed) — scanning full inbox, ${box.exists} messages`);

  // ledger rows with a real address, keyed by lowercase email
  const watched = new Map(db.prepare("SELECT * FROM outreach WHERE email LIKE '%@%'").all()
    .map((r) => [r.email.toLowerCase().trim(), r]));

  let maxUid = sinceUid, scanned = 0, hits = 0;
  if (box.exists > 0) {
    for await (const msg of client.fetch({ uid: `${sinceUid + 1}:*` }, { envelope: true, uid: true })) {
      if (msg.uid <= sinceUid) continue; // n:* can echo the last message back
      scanned++;
      if (msg.uid > maxUid) maxUid = msg.uid;
      const from = msg.envelope?.from?.[0];
      const addr = from ? `${from.address ?? ''}`.toLowerCase() : '';
      const subj = msg.envelope?.subject ?? '';

      // Bounce / NDR — comes from mailer-daemon/postmaster, names the dead recipient in its body.
      const looksBounce = /mailer-daemon|postmaster|mail delivery/i.test(addr)
        || /delivery status notification|undeliverable|delivery failure|returned mail/i.test(subj);
      if (looksBounce) {
        let src = '';
        try { const dl = await client.download(msg.uid, undefined, { uid: true }); for await (const c of dl.content) src += c.toString('utf8'); } catch {}
        const failed = new Set([...src.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)].map((m) => m[0].toLowerCase()));
        for (const f of failed) {
          const br = watched.get(f);
          if (br && ['sent', 'drafted'].includes(br.status)) {
            db.prepare(`UPDATE outreach SET status='bounced', last_touch_at=datetime('now'),
              next_touch_at=NULL, notes=coalesce(notes,'')||' · BOUNCED (auto-detected)' WHERE id=?`).run(br.id);
            hits++;
            console.log(`✖ BOUNCE #${br.id} ${br.target} (${f}) — address dead, needs a correct route`);
          }
        }
        continue;
      }

      const row = watched.get(addr);
      if (!row) continue;
      if (!['sent', 'drafted', 'dormant'].includes(row.status)) continue; // already progressed
      db.prepare(`UPDATE outreach SET status='replied', last_touch_at=datetime('now'),
        next_touch_at=NULL WHERE id=?`).run(row.id);
      hits++;
      console.log(`⚡ REPLY  #${row.id} ${row.target} (${addr}) — "${subj}" ${msg.envelope.date?.toISOString?.().slice(0, 10) ?? ''} → status=replied`);
    }
  }
  db.prepare(`INSERT INTO outreach_poll_state (mailbox, uidvalidity, last_uid, last_polled_at)
    VALUES ('INBOX', ?, ?, datetime('now'))
    ON CONFLICT(mailbox) DO UPDATE SET uidvalidity=excluded.uidvalidity,
      last_uid=excluded.last_uid, last_polled_at=excluded.last_polled_at`)
    .run(uidValidity, maxUid);
  await client.logout();
  console.log(`polled INBOX: ${scanned} new message${scanned === 1 ? '' : 's'}, ${hits} repl${hits === 1 ? 'y' : 'ies'} matched · cursor uid ${maxUid} · watching ${watched.size} addresses`);
}

if (process.argv.includes('--once')) {
  await poll();
} else {
  console.log('usage: outreach-poll.mjs --once   (single read-only poll; cron it for a drumbeat)');
}
db.close();
