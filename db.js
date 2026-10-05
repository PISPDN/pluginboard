// Storage for the Plug In Dashboard.
// SQLite via Node's built-in driver — no npm packages, one file you can copy or back up.
// Every row gets a real id, which is the whole point of moving off the spreadsheet.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FILE = process.env.DB_FILE || "./data/board.db";
mkdirSync(dirname(FILE), { recursive: true });

export const db = new DatabaseSync(FILE);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY,
  shift_id     TEXT UNIQUE,              -- Connecteam's own id
  engineer     TEXT NOT NULL DEFAULT '',
  job_title    TEXT NOT NULL DEFAULT '',
  starts_at    TEXT,
  ends_at      TEXT,
  location     TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  note         TEXT NOT NULL DEFAULT '',
  status_by    TEXT NOT NULL DEFAULT '',
  status_at    TEXT,
  extra        TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS jobs_live ON jobs(deleted_at, starts_at);

CREATE TABLE IF NOT EXISTS errors (
  id           INTEGER PRIMARY KEY,
  ext_id       TEXT UNIQUE,
  zap          TEXT NOT NULL DEFAULT '',
  step         TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL DEFAULT '',
  serial       TEXT NOT NULL DEFAULT '',
  serial_key   TEXT NOT NULL DEFAULT '',   -- cleaned on the way in, so matching is exact
  job          TEXT NOT NULL DEFAULT '',
  customer     TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  engineer     TEXT NOT NULL DEFAULT '',
  image_url    TEXT NOT NULL DEFAULT '',
  occurred_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  note         TEXT NOT NULL DEFAULT '',
  status_by    TEXT NOT NULL DEFAULT '',
  status_at    TEXT,
  extra        TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS errors_serial ON errors(serial_key);

CREATE TABLE IF NOT EXISTS stock_alerts (
  id           INTEGER PRIMARY KEY,
  ext_id       TEXT UNIQUE,
  engineer     TEXT NOT NULL DEFAULT '',
  item         TEXT NOT NULL DEFAULT '',
  serial       TEXT NOT NULL DEFAULT '',
  serial_key   TEXT NOT NULL DEFAULT '',
  qty          TEXT NOT NULL DEFAULT '',
  job          TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL DEFAULT '',
  image_url    TEXT NOT NULL DEFAULT '',
  occurred_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  note         TEXT NOT NULL DEFAULT '',
  charger_type TEXT NOT NULL DEFAULT '',   -- 5m / 8m / epod
  status_by    TEXT NOT NULL DEFAULT '',
  status_at    TEXT,
  extra        TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS stock_serial ON stock_alerts(serial_key);

-- one row per deduction run: replaces Automation Log + Sortly Log + Quantities Log
CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY,
  run_id         TEXT UNIQUE,
  engineer       TEXT NOT NULL DEFAULT '',
  serial         TEXT NOT NULL DEFAULT '',
  serial_key     TEXT NOT NULL DEFAULT '',
  cu             TEXT NOT NULL DEFAULT '',
  cable          TEXT NOT NULL DEFAULT '',
  job            TEXT NOT NULL DEFAULT '',
  charger_found  TEXT NOT NULL DEFAULT '',
  charger_removed TEXT NOT NULL DEFAULT '',
  cu_adjust      TEXT NOT NULL DEFAULT '',
  cable_adjust   TEXT NOT NULL DEFAULT '',
  sortly_removed TEXT NOT NULL DEFAULT '',
  sortly_cu      TEXT NOT NULL DEFAULT '',
  sortly_cable   TEXT NOT NULL DEFAULT '',
  zap_error      TEXT NOT NULL DEFAULT '',
  sortly_error   TEXT NOT NULL DEFAULT '',
  qty_error      TEXT NOT NULL DEFAULT '',
  ran_at         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  note           TEXT NOT NULL DEFAULT '',
  charger_sorted INTEGER NOT NULL DEFAULT 0,
  ov_removed     TEXT NOT NULL DEFAULT '',
  ov_cu          TEXT NOT NULL DEFAULT '',
  ov_cable       TEXT NOT NULL DEFAULT '',
  status_by      TEXT NOT NULL DEFAULT '',
  status_at      TEXT,
  extra          TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS runs_serial ON runs(serial_key);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY,
  task_id      TEXT UNIQUE,
  title        TEXT NOT NULL DEFAULT '',
  assignee     TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo',
  priority     TEXT NOT NULL DEFAULT 'medium',
  details      TEXT NOT NULL DEFAULT '',
  updates      TEXT NOT NULL DEFAULT '[]',
  parent_id    TEXT NOT NULL DEFAULT '',
  parent_title TEXT NOT NULL DEFAULT '',
  raised_by    TEXT NOT NULL DEFAULT '',
  due          TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);

-- orders and invoices move out of each laptop's browser storage
CREATE TABLE IF NOT EXISTS invoices (
  id          INTEGER PRIMARY KEY,
  ref         TEXT UNIQUE,
  source      TEXT NOT NULL DEFAULT 'us',      -- 'us' | 'wholesaler'
  wholesaler  TEXT NOT NULL DEFAULT '',
  number      TEXT NOT NULL DEFAULT '',
  dated       TEXT NOT NULL DEFAULT '',
  lines       TEXT NOT NULL DEFAULT '[]',
  received    INTEGER NOT NULL DEFAULT 0,
  audited     INTEGER NOT NULL DEFAULT 0,
  resolved    INTEGER NOT NULL DEFAULT 0,
  flagged     INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  file_name   TEXT NOT NULL DEFAULT '',
  file_type   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT
);
CREATE TABLE IF NOT EXISTS invoice_files (
  invoice_ref TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  data        BLOB
);

-- every ingest call is recorded, so "did Zapier actually send it" is answerable
CREATE TABLE IF NOT EXISTS ingest_log (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
`);


/* ---------- automations (replacing the two deduction Zaps) ---------- */
db.exec(`
-- who the engineers are, and where their van stock lives in Sortly.
-- Item ids are optional overrides: blank = find the item by name in the folder.
CREATE TABLE IF NOT EXISTS engineers (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  connecteam_user_id TEXT NOT NULL DEFAULT '',
  sortly_folder_id   TEXT NOT NULL DEFAULT '',
  cable_item_id      TEXT NOT NULL DEFAULT '',
  metal_cu_item_id   TEXT NOT NULL DEFAULT '',
  ip65_cu_item_id    TEXT NOT NULL DEFAULT '',
  active             INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- every Connecteam form submission the app receives, kept whole so a run can be re-done
CREATE TABLE IF NOT EXISTS submissions (
  id              INTEGER PRIMARY KEY,
  submission_id   TEXT NOT NULL UNIQUE,     -- Connecteam formSubmissionId
  form_id         TEXT NOT NULL DEFAULT '',
  event_type      TEXT NOT NULL DEFAULT '',
  payload         TEXT NOT NULL DEFAULT '{}',
  state           TEXT NOT NULL DEFAULT 'queued',   -- queued | processing | done | ignored | failed
  detail          TEXT NOT NULL DEFAULT '',
  attempts        INTEGER NOT NULL DEFAULT 0,
  received_at     TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at    TEXT
);
CREATE INDEX IF NOT EXISTS submissions_state ON submissions(state, id);
`);

db.exec(`
-- Troubleshoot workflow: one row per submission. Ohme → renamed to the RMA number;
-- Hypervolt / EVEC → renamed with the job details and flagged to come back to the warehouse.
CREATE TABLE IF NOT EXISTS troubleshoots (
  id             INTEGER PRIMARY KEY,
  submission_id  TEXT NOT NULL UNIQUE,
  engineer       TEXT NOT NULL DEFAULT '',
  key_account    TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL DEFAULT '',   -- rma | return
  serial         TEXT NOT NULL DEFAULT '',   -- the NEW charger's serial
  serial_key     TEXT NOT NULL DEFAULT '',
  rma            TEXT NOT NULL DEFAULT '',
  customer       TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  issue          TEXT NOT NULL DEFAULT '',
  image_url      TEXT NOT NULL DEFAULT '',
  found          TEXT NOT NULL DEFAULT '',
  item_id        TEXT NOT NULL DEFAULT '',
  previous_name  TEXT NOT NULL DEFAULT '',
  renamed_to     TEXT NOT NULL DEFAULT '',
  renamed        TEXT NOT NULL DEFAULT '',   -- yes | shadow | no
  problem        TEXT NOT NULL DEFAULT '',
  mode           TEXT NOT NULL DEFAULT '',
  steps          TEXT NOT NULL DEFAULT '{}',
  submitted_at   TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  note           TEXT NOT NULL DEFAULT '',
  status_by      TEXT NOT NULL DEFAULT '',
  status_at      TEXT,
  extra          TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT
);

-- Any Other Info workflow: just a flag on the board
CREATE TABLE IF NOT EXISTS other_info (
  id             INTEGER PRIMARY KEY,
  submission_id  TEXT NOT NULL UNIQUE,
  engineer       TEXT NOT NULL DEFAULT '',
  answers        TEXT NOT NULL DEFAULT '[]',   -- [{question, answer, images}]
  submitted_at   TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  note           TEXT NOT NULL DEFAULT '',
  status_by      TEXT NOT NULL DEFAULT '',
  status_at      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT
);
`);

// columns added to runs for the app's own automation — added in place on an existing database
function addColumn(table, col, decl) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  return !have;
}
addColumn("runs", "source", "TEXT NOT NULL DEFAULT 'zapier'");   // zapier | app
addColumn("runs", "mode", "TEXT NOT NULL DEFAULT ''");           // shadow | live
addColumn("runs", "steps", "TEXT NOT NULL DEFAULT '{}'");        // per-step state, so a re-run never repeats a done step
addColumn("runs", "submission_id", "TEXT NOT NULL DEFAULT ''");
addColumn("stock_alerts", "run_id", "TEXT NOT NULL DEFAULT ''");
addColumn("submissions", "kind", "TEXT NOT NULL DEFAULT ''");   // eoj | troubleshoot | otherInfo
addColumn("submissions", "force", "INTEGER NOT NULL DEFAULT 0");   // re-run asked to redo interrupted steps

// Monthly deliveries: only these engineers have their CUs and EV Ultra cable deducted.
const monthlyAdded = addColumn("engineers", "monthly", "INTEGER NOT NULL DEFAULT 0");
addColumn("engineers", "monthly_since", "TEXT NOT NULL DEFAULT ''");
// the six engineers the CU / EV Ultra Zap is set for today (its Path A)
export const MONTHLY_SEED = ["Jake Reed", "Jack Shearer", "Jack Place", "Benjamin Cole", "Brandon Hall", "Sam Day"];

// First start only: the engineers and Sortly folders from VAN_ENGINEERS in Code.gs.
const SEED_ENGINEERS = [
  ["Lewis Hayler", "113512501"], ["Harry Worsell", "113456347"], ["Jack Shearer", "114862975"],
  ["Raymond Higgins", "113456322"], ["Sam Day", "115029010"], ["Scott Menzies", "116945216"],
  ["Surinder Dhir", "113512522"], ["Ethan Heath-Mills", "116894194"], ["Nick Smith", "113456349"],
  ["Jake Reed", "114832592"], ["Brandon Hall", "114979083"], ["Stefano Ruffo", "113456357"],
  ["Matteo Frangiamore", "113456311"], ["Karun Kerai Kerai", "113644431"], ["Ronaldo Bajraktari", "113456146"],
  ["Koray Shukru", "113456304"], ["Andre Theophani", "113456329"], ["Lucas Evangelou", "113456307"],
  ["Gabriel Filipi", "113456291"], ["Brijan Hasmuja", "113456138"], ["Benjamin Cole", "114914803"],
  ["Jack Place", "114862970"], ["Phillip Parsons", "113512479"], ["Jack Cohen", "113750849"],
  ["Conor Holliday", "115478252"], ["Kieran Baugh", "115478253"],
];
if (!db.prepare("SELECT COUNT(*) n FROM engineers").get().n) {
  const ins = db.prepare("INSERT INTO engineers(name, sortly_folder_id) VALUES(?, ?)");
  for (const [n, f] of SEED_ENGINEERS) ins.run(n, f);
}
if (monthlyAdded) {
  const m = db.prepare("UPDATE engineers SET monthly = 1, monthly_since = date('now') WHERE name = ?");
  for (const n of MONTHLY_SEED) m.run(n);
}

// Serials arrive with image URLs glued on ("CHG-11004 https://…jpg"). Clean once, on the
// way in, so nothing downstream has to guess.
export function serialKey(s) {
  return String(s || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
export function cleanSerial(s) {
  return String(s || "").replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
}

const truthy = /^(yes|y|true|1|done|removed|updated|adjusted|success|ok|complete|completed|found)$/i;
const falsy = /^(no|n|false|0|error|fail|failed|notfound|missing|none)$/i;
export function yesNo(v) {
  if (v === true) return "yes";
  if (v === false) return "no";
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (truthy.test(s)) return "yes";
  if (falsy.test(s)) return "no";
  return s;
}

// anything the Zap sends that we don't have a column for is kept, not dropped
export function leftovers(body, known) {
  const out = {};
  for (const k of Object.keys(body || {})) if (!known.has(k)) out[k] = body[k];
  return JSON.stringify(out);
}

export function logIngest(kind, ok, detail, body) {
  db.prepare("INSERT INTO ingest_log(kind, ok, detail, body) VALUES(?,?,?,?)")
    .run(kind, ok ? 1 : 0, String(detail || ""), JSON.stringify(body || {}).slice(0, 4000));
  db.prepare("DELETE FROM ingest_log WHERE id < (SELECT MAX(id) - 5000 FROM ingest_log)").run();
}

// small key → JSON store for the Sortly level checks (last result, variants seen, what's already been alerted)
db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')))");
export function kvGet(k, dflt = null) {
  const r = db.prepare("SELECT v FROM kv WHERE k = ?").get(k);
  if (!r) return dflt;
  try { return JSON.parse(r.v); } catch { return dflt; }
}
export function kvSet(k, v) {
  db.prepare("INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = datetime('now')").run(k, JSON.stringify(v));
}
