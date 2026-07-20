#!/usr/bin/env node
// Outreach ledger — who's in flight, where, and when the next touch is due.
// This file TRACKS and FLAGS only. There is deliberately no send path and no bulk
// operation anywhere in here: drafting happens with a human, sending needs approval.
//
//   node outreach.mjs --seed                 # insert threads from seed.json (idempotent)
//   node outreach.mjs --list                 # ledger grouped by status
//   node outreach.mjs --due                  # touches due — suggested actions, no sending
//   node outreach.mjs --add --target "Sam Rivers" --org "Acme" [--email x@y] [--subject "..."] [--lane cold]
//   node outreach.mjs --touch 3 --status replied [--next 2026-08-01] [--note "..."]
//
// DB path: $OUTREACH_DB or ./outreach.db. Threads with doctrine='no-chase' are tracked
// but never surfaced by --due — some relationships must not be nudged, ever.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.OUTREACH_DB || './outreach.db');

export const STATUSES = ['drafted', 'sent', 'replied', 'in_conversation', 'terms_sent', 'signed', 'dormant', 'closed'];

db.exec(`CREATE TABLE IF NOT EXISTS outreach (
  id integer primary key,
  lane text,                -- warm | cold | client — whatever taxonomy fits the project
  target text,              -- person
  org text,
  email text,
  ref text,                 -- optional link to your project's own record id
  thread_subject text,
  channel text,             -- email | meeting | linkedin | phone
  status text,              -- drafted|sent|replied|in_conversation|terms_sent|signed|dormant|closed
  doctrine text,            -- '' | 'no-chase' — no-chase rows are tracked, never nudged
  sent_at text,
  last_touch_at text,
  next_touch_at text,
  touch_count integer default 0,
  notes text,
  created_at text default (datetime('now'))
)`);

const today = () => new Date().toISOString().slice(0, 10);

function seed() {
  if (!existsSync('./seed.json')) {
    console.log('no seed.json — copy seed.example.json to seed.json and edit your real threads (seed.json is gitignored)');
    return;
  }
  const rows = JSON.parse(readFileSync('./seed.json', 'utf8'));
  const exists = db.prepare('SELECT id FROM outreach WHERE target=? AND thread_subject=?');
  const ins = db.prepare(`INSERT INTO outreach (lane, target, org, email, ref, thread_subject,
    channel, status, doctrine, sent_at, last_touch_at, next_touch_at, touch_count, notes)
    VALUES (@lane, @target, @org, @email, @ref, @thread_subject, @channel, @status, @doctrine,
    @sent_at, @last_touch_at, @next_touch_at, @touch_count, @notes)`);
  let added = 0, skipped = 0;
  for (const row of rows) {
    if (exists.get(row.target, row.thread_subject ?? '')) { skipped++; continue; }
    ins.run({ lane: 'cold', org: null, email: null, ref: null, thread_subject: '', channel: 'email',
      status: 'drafted', doctrine: '', sent_at: null, last_touch_at: null, next_touch_at: null,
      touch_count: 0, notes: null, ...row });
    added++;
  }
  console.log(`[seed] ${added} inserted, ${skipped} already present`);
}

function list() {
  const rows = db.prepare(`SELECT * FROM outreach ORDER BY
    CASE status ${STATUSES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} ELSE 99 END, id`).all();
  let cur = null;
  for (const r of rows) {
    if (r.status !== cur) { cur = r.status; console.log(`\n== ${cur.toUpperCase()} ==`); }
    const overdue = r.next_touch_at && r.next_touch_at <= today() ? '  ⚠ OVERDUE' : '';
    console.log(`  #${r.id} [${r.lane}] ${r.target} — ${r.org ?? ''}` +
      ` · "${r.thread_subject}" · ${r.channel}` +
      (r.doctrine === 'no-chase' ? ' · NO-CHASE' : '') +
      (r.last_touch_at ? ` · last ${r.last_touch_at}` : '') +
      (r.next_touch_at ? ` · next ${r.next_touch_at}${overdue}` : '') +
      (r.notes ? `\n      ${r.notes}` : ''));
  }
  const inFlight = rows.filter((r) => !['dormant', 'closed', 'signed'].includes(r.status)).length;
  console.log(`\n${rows.length} threads · ${inFlight} in flight`);
}

// Due touches — suggestions only. Drafting happens with a human in the loop; warm
// relationships get reminders for a HUMAN touch, not a drafted email.
function due() {
  const rows = db.prepare(`SELECT * FROM outreach WHERE next_touch_at IS NOT NULL
    AND next_touch_at <= ? AND status NOT IN ('dormant','closed','signed')
    AND coalesce(doctrine,'') != 'no-chase' ORDER BY next_touch_at`).all(today());
  if (!rows.length) { console.log('nothing due — drumbeat clear'); return; }
  for (const r of rows) {
    const days = r.sent_at ? Math.round((Date.now() - Date.parse(r.sent_at)) / 864e5) : null;
    const action = r.lane === 'warm' || r.channel === 'meeting'
      ? 'human touch due — nudge the user, no draft'
      : r.status === 'sent'
        ? `day-${days ?? '?'} follow-up due — draft with approval${r.touch_count >= 3 ? ' (3rd touch — mark dormant after)' : ''}`
        : 'touch due — review thread';
    console.log(`#${r.id} [${r.lane}] ${r.target} (${r.org ?? '—'}) · "${r.thread_subject}" · due ${r.next_touch_at} → ${action}`);
  }
  console.log(`\n${rows.length} due. Nothing is sent by this system — drafts need human approval.`);
}

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] || true) : null; };

if (args.includes('--seed')) {
  seed();
} else if (args.includes('--list')) {
  list();
} else if (args.includes('--due')) {
  due();
} else if (args.includes('--add')) {
  const target = flag('target');
  if (!target) { console.error('need --target'); process.exit(1); }
  db.prepare(`INSERT INTO outreach (lane, target, org, email, thread_subject, channel, status, doctrine)
    VALUES (?, ?, ?, ?, ?, ?, 'drafted', ?)`)
    .run(flag('lane') || 'cold', target, flag('org'), flag('email'), flag('subject') || '',
      flag('channel') || 'email', flag('doctrine') || '');
  console.log(`added ${target}`);
} else if (flag('touch')) {
  const id = Number(flag('touch'));
  const status = flag('status');
  const next = flag('next');
  const note = flag('note');
  if (status && !STATUSES.includes(status)) { console.error(`bad status — one of: ${STATUSES.join(' ')}`); process.exit(1); }
  const row = db.prepare('SELECT * FROM outreach WHERE id=?').get(id);
  if (!row) { console.error(`no thread #${id}`); process.exit(1); }
  db.prepare(`UPDATE outreach SET status=coalesce(?,status), next_touch_at=coalesce(?,next_touch_at),
    last_touch_at=datetime('now'), touch_count=touch_count+1,
    notes=CASE WHEN ? IS NULL THEN notes WHEN notes IS NULL THEN ? ELSE notes || ' · ' || ? END
    WHERE id=?`).run(status, next, note, note, note, id);
  console.log(`#${id} ${row.target} → ${status ?? row.status}${next ? ` · next ${next}` : ''}`);
} else {
  console.log('usage: outreach.mjs --seed | --list | --due | --add --target "..." [...] | --touch <id> [--status X] [--next YYYY-MM-DD] [--note "..."]');
}
db.close();
