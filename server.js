// Plug In Dashboard — the app.
// Zapier POSTs here instead of writing to a Google Sheet; the board reads and writes here
// instead of talking to Apps Script. No npm packages: Node 22+ only.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { db, serialKey, cleanSerial, yesNo, leftovers, logIngest } from "./db.js";
import { levels, vanLevels, folders, startLevelChecks, slack as notifySlack } from "./levels.js";
import { receiveFromZapier, receiveWebhook, rerun, backfill, automationStatus, listEngineers, saveEngineer, resumeQueue } from "./automations.js";

const PORT = Number(process.env.PORT || 8080);
const INGEST_KEY = process.env.INGEST_KEY || "";          // the header your Zaps send
const APP_PASSWORD = process.env.APP_PASSWORD || "";      // what the three of you type in
const APP_SECRET = process.env.APP_SECRET || "";          // signs the login cookie
const PEOPLE = (process.env.PEOPLE || "Andre,Andy,Andreas").split(",").map(s => s.trim()).filter(Boolean);

for (const [k, v] of Object.entries({ INGEST_KEY, APP_PASSWORD, APP_SECRET })) {
  if (!v) { console.error(`Refusing to start: ${k} is not set. See README.`); process.exit(1); }
}

/* ---------------- helpers ---------------- */
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(s);
};
const nowIso = () => new Date().toISOString();

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  const text = raw.toString("utf8");
  try { return JSON.parse(text); } catch {
    // Zapier can be set to form-encoded; accept that too rather than failing silently
    const out = {}; for (const [k, v] of new URLSearchParams(text)) out[k] = v; return out;
  }
}

function sign(value) {
  return createHmac("sha256", APP_SECRET).update(value).digest("base64url");
}
function makeCookie(name) {
  const payload = Buffer.from(JSON.stringify({ name, t: Date.now() })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function readCookie(req) {
  const raw = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("pib="));
  if (!raw) return null;
  const [payload, sig] = raw.slice(4).split(".");
  if (!payload || !sig) return null;
  const want = sign(payload);
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Date.now() - o.t > 30 * 24 * 3600 * 1000) return null;   // 30 days
    return o.name || "";
  } catch { return null; }
}
function keyOk(req) {
  const got = req.headers["x-api-key"] || "";
  if (got.length !== INGEST_KEY.length) return false;
  return timingSafeEqual(Buffer.from(String(got)), Buffer.from(INGEST_KEY));
}

/* ---------------- ingest (Zapier posts here) ---------------- */
const pick = (b, ...names) => { for (const n of names) if (b[n] !== undefined && b[n] !== "") return b[n]; return ""; };

const INGEST = {
  job(b) {
    const shift = String(pick(b, "shift_id", "shiftId", "id") || "").trim();
    if (!shift) throw new Error("shift_id is required");
    const known = new Set(["shift_id","shiftId","id","engineer","job_title","title","start","starts_at","end","ends_at","location","address","notes","note"]);
    const row = {
      shift_id: shift,
      engineer: String(pick(b, "engineer", "assigned_engineer") || ""),
      job_title: String(pick(b, "job_title", "title", "job") || ""),
      starts_at: String(pick(b, "start", "starts_at", "job_dates") || ""),
      ends_at: String(pick(b, "end", "ends_at") || ""),
      location: String(pick(b, "location", "address") || ""),
      notes: String(pick(b, "notes", "note", "job_notes") || ""),
      extra: leftovers(b, known),
    };
    // one endpoint for both the "new shift" and "updated shift" Zaps — no duplicate cards
    db.prepare(`
      INSERT INTO jobs (shift_id, engineer, job_title, starts_at, ends_at, location, notes, extra)
      VALUES (@shift_id, @engineer, @job_title, @starts_at, @ends_at, @location, @notes, @extra)
      ON CONFLICT(shift_id) DO UPDATE SET
        engineer=excluded.engineer, job_title=excluded.job_title, starts_at=excluded.starts_at,
        ends_at=excluded.ends_at, location=excluded.location, notes=excluded.notes,
        extra=excluded.extra, updated_at=datetime('now'), deleted_at=NULL
    `).run(row);
    return { shift_id: shift };
  },

  error(b) {
    const known = new Set(["error_id","id","zap","zap_name","step","action","message","error","serial","serial_number","job","job_details","customer","client","address","engineer","image_url","image","when","time","timestamp"]);
    const serial = cleanSerial(pick(b, "serial", "serial_number"));
    const r = db.prepare(`
      INSERT INTO errors (ext_id, zap, step, message, serial, serial_key, job, customer, address, engineer, image_url, occurred_at, extra)
      VALUES (@ext_id,@zap,@step,@message,@serial,@serial_key,@job,@customer,@address,@engineer,@image_url,@occurred_at,@extra)
      ON CONFLICT(ext_id) DO UPDATE SET message=excluded.message, deleted_at=NULL
    `).run({
      ext_id: String(pick(b, "error_id", "id") || `err_${randomUUID()}`),
      zap: String(pick(b, "zap", "zap_name") || ""),
      step: String(pick(b, "step", "action") || ""),
      message: String(pick(b, "message", "error") || ""),
      serial, serial_key: serialKey(pick(b, "serial", "serial_number")),
      job: String(pick(b, "job", "job_details") || ""),
      customer: String(pick(b, "customer", "client") || ""),
      address: String(pick(b, "address") || ""),
      engineer: String(pick(b, "engineer") || ""),
      image_url: String(pick(b, "image_url", "image") || ""),
      occurred_at: String(pick(b, "when", "time", "timestamp") || nowIso()),
      extra: leftovers(b, known),
    });
    return { id: r.lastInsertRowid };
  },

  "stock-alert"(b) {
    const known = new Set(["alert_id","id","engineer","item","serial","serial_number","qty","quantity","job","message","detail","image_url","image","when","time","timestamp"]);
    const r = db.prepare(`
      INSERT INTO stock_alerts (ext_id, engineer, item, serial, serial_key, qty, job, message, image_url, occurred_at, extra)
      VALUES (@ext_id,@engineer,@item,@serial,@serial_key,@qty,@job,@message,@image_url,@occurred_at,@extra)
      ON CONFLICT(ext_id) DO UPDATE SET message=excluded.message, deleted_at=NULL
    `).run({
      ext_id: String(pick(b, "alert_id", "id") || `stk_${randomUUID()}`),
      engineer: String(pick(b, "engineer") || ""),
      item: String(pick(b, "item") || ""),
      serial: cleanSerial(pick(b, "serial", "serial_number")),
      serial_key: serialKey(pick(b, "serial", "serial_number")),
      qty: String(pick(b, "qty", "quantity") || ""),
      job: String(pick(b, "job") || ""),
      message: String(pick(b, "message", "detail") || ""),
      image_url: String(pick(b, "image_url", "image") || ""),
      occurred_at: String(pick(b, "when", "time", "timestamp") || nowIso()),
      extra: leftovers(b, known),
    });
    return { id: r.lastInsertRowid };
  },

  run(b) {
    const known = new Set(["run_id","flow_id","id","engineer","serial","charger_serial","cu","cable","cable_m","job","charger_found","charger_removed","remove_charger","cu_adjust","cable_adjust","sortly_removed","sortly_cu_updated","sortly_cable_updated","error","zap_error","sortly_error","qty_error","when","time","timestamp"]);
    const row = {
      run_id: String(pick(b, "run_id", "flow_id", "id") || `run_${randomUUID()}`),
      engineer: String(pick(b, "engineer") || ""),
      serial: cleanSerial(pick(b, "serial", "charger_serial")),
      serial_key: serialKey(pick(b, "serial", "charger_serial")),
      cu: String(pick(b, "cu") || ""),
      cable: String(pick(b, "cable", "cable_m") || ""),
      job: String(pick(b, "job") || ""),
      charger_found: yesNo(pick(b, "charger_found")),
      charger_removed: yesNo(pick(b, "charger_removed", "remove_charger")),
      cu_adjust: String(pick(b, "cu_adjust") ?? ""),
      cable_adjust: String(pick(b, "cable_adjust") ?? ""),
      sortly_removed: yesNo(pick(b, "sortly_removed")),
      sortly_cu: yesNo(pick(b, "sortly_cu_updated")),
      sortly_cable: yesNo(pick(b, "sortly_cable_updated")),
      zap_error: String(pick(b, "error", "zap_error") || ""),
      sortly_error: String(pick(b, "sortly_error") || ""),
      qty_error: String(pick(b, "qty_error") || ""),
      ran_at: String(pick(b, "when", "time", "timestamp") || nowIso()),
      extra: leftovers(b, known),
    };
    // a Zap may post once at the end, or twice — the second call fills in what it learned
    db.prepare(`
      INSERT INTO runs (run_id,engineer,serial,serial_key,cu,cable,job,charger_found,charger_removed,
                        cu_adjust,cable_adjust,sortly_removed,sortly_cu,sortly_cable,
                        zap_error,sortly_error,qty_error,ran_at,extra)
      VALUES (@run_id,@engineer,@serial,@serial_key,@cu,@cable,@job,@charger_found,@charger_removed,
              @cu_adjust,@cable_adjust,@sortly_removed,@sortly_cu,@sortly_cable,
              @zap_error,@sortly_error,@qty_error,@ran_at,@extra)
      ON CONFLICT(run_id) DO UPDATE SET
        engineer=COALESCE(NULLIF(excluded.engineer,''), runs.engineer),
        serial=COALESCE(NULLIF(excluded.serial,''), runs.serial),
        serial_key=COALESCE(NULLIF(excluded.serial_key,''), runs.serial_key),
        cu=COALESCE(NULLIF(excluded.cu,''), runs.cu),
        cable=COALESCE(NULLIF(excluded.cable,''), runs.cable),
        job=COALESCE(NULLIF(excluded.job,''), runs.job),
        charger_found=COALESCE(NULLIF(excluded.charger_found,''), runs.charger_found),
        charger_removed=COALESCE(NULLIF(excluded.charger_removed,''), runs.charger_removed),
        cu_adjust=COALESCE(NULLIF(excluded.cu_adjust,''), runs.cu_adjust),
        cable_adjust=COALESCE(NULLIF(excluded.cable_adjust,''), runs.cable_adjust),
        sortly_removed=COALESCE(NULLIF(excluded.sortly_removed,''), runs.sortly_removed),
        sortly_cu=COALESCE(NULLIF(excluded.sortly_cu,''), runs.sortly_cu),
        sortly_cable=COALESCE(NULLIF(excluded.sortly_cable,''), runs.sortly_cable),
        zap_error=COALESCE(NULLIF(excluded.zap_error,''), runs.zap_error),
        sortly_error=COALESCE(NULLIF(excluded.sortly_error,''), runs.sortly_error),
        qty_error=COALESCE(NULLIF(excluded.qty_error,''), runs.qty_error),
        deleted_at=NULL
    `).run(row);
    return { run_id: row.run_id };
  },
};

/* ---------------- what the board reads ---------------- */
const live = t => db.prepare(`SELECT * FROM ${t} WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 5000`).all();
// Only the columns the board should show. Housekeeping columns are dropped, or they turn up
// in the card's "other columns" list and look like data.
const PLUMBING = new Set(["id", "extra", "created_at", "updated_at", "deleted_at", "serial_key",
  "ext_id", "starts_at", "ends_at", "occurred_at", "ran_at", "image_url", "run_id", "raised_by",
  "steps", "submission_id", "serial_key", "item_id"]);
function shape(r, add) {
  const out = { _id: r.id };
  for (const [k, v] of Object.entries(r)) if (!PLUMBING.has(k) && v !== "" && v !== null) out[k] = v;
  try { Object.assign(out, JSON.parse(r.extra || "{}")); } catch {}
  for (const [k, v] of Object.entries(add || {})) if (v !== "" && v != null) out[k] = v;
  if (r.status_by) out["last changed by"] = r.status_by;
  delete out.status_by; delete out.status_at;
  return out;
}

function snapshot() {
  return {
    ok: true,
    people: PEOPLE,
    jobs: live("jobs").map(r => shape(r, { start: r.starts_at, end: r.ends_at })),
    errors: live("errors").map(r => shape(r, { error_id: r.ext_id, image: r.image_url, when: r.occurred_at })),
    stock: live("stock_alerts").map(r => shape(r, { alert_id: r.ext_id, image: r.image_url, when: r.occurred_at })),
    flow: live("runs").map(r => shape(r, {
      flow_id: r.run_id, charger_serial: r.serial, when: r.ran_at,
      remove_charger: r.charger_removed, sortly_cu_updated: r.sortly_cu, sortly_cable_updated: r.sortly_cable,
      charger_sorted: r.charger_sorted ? "yes" : "no",
    })),
    tasks: live("tasks").map(r => shape(r, { from: r.raised_by, when: r.created_at })),
    // Troubleshoots: Ohme → renamed to the RMA; Hypervolt / EVEC → renamed with job details, to come back
    troubleshoots: live("troubleshoots").map(r => shape(r, { troubleshoot_id: r.submission_id, when: r.submitted_at, image: r.image_url })),
    // Any Other Info submissions — just flagged
    otherinfo: live("other_info").map(r => ({ _id: r.id, submission_id: r.submission_id, engineer: r.engineer, when: r.submitted_at,
      answers: JSON.parse(r.answers || "[]"), status: r.status, note: r.note, ...(r.status_by ? { "last changed by": r.status_by } : {}) })),
    invoices: live("invoices").map(r => ({
      id: r.ref, source: r.source, wholesaler: r.wholesaler, number: r.number, date: r.dated,
      lines: JSON.parse(r.lines || "[]"), received: !!r.received, audited: !!r.audited,
      resolved: !!r.resolved, flagged: !!r.flagged, note: r.note,
      att: r.file_name ? { name: r.file_name, type: r.file_type } : undefined,
    })),
  };
}

/* ---------------- what the board writes ---------------- */
const TABLE = { job: "jobs", error: "errors", stock: "stock_alerts", flow: "runs", task: "tasks",
                troubleshoot: "troubleshoots", otherinfo: "other_info" };
const FIELDS = {
  jobs: new Set(["status", "note"]),
  errors: new Set(["status", "note"]),
  stock_alerts: new Set(["status", "note", "charger_type"]),
  runs: new Set(["status", "note", "charger_sorted", "ov_removed", "ov_cu", "ov_cable"]),
  tasks: new Set(["status", "priority", "details", "updates", "title", "assignee", "due"]),
  troubleshoots: new Set(["status", "note"]),
  other_info: new Set(["status", "note"]),
};

function applyWrite(who, body) {
  const table = TABLE[String(body.type || "job")];
  if (!table) return { ok: false, error: "unknown type" };
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "id is required" };
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!row) return { ok: false, error: "no such row" };

  const sets = [], vals = [];
  for (const [k, v] of Object.entries(body.fields || {})) {
    if (!FIELDS[table].has(k)) return { ok: false, error: `cannot set ${k}` };
    sets.push(`${k} = ?`);
    vals.push(k === "charger_sorted" ? (yesNo(v) === "yes" ? 1 : 0) : String(v ?? ""));
  }
  if (!sets.length) return { ok: false, error: "nothing to set" };
  if (FIELDS[table].has("status")) { sets.push("status_by = ?", "status_at = ?"); vals.push(who, nowIso()); }
  vals.push(id);
  db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

  // ticking a stock alert or error off marks the matching run's charger as removed
  if (table === "stock_alerts" || table === "errors") syncChargerSorted(id, table);
  return { ok: true, id };
}

function syncChargerSorted(id, table) {
  const row = db.prepare(`SELECT serial_key FROM ${table} WHERE id = ?`).get(id);
  const key = row && row.serial_key;
  if (!key) return;
  const open = db.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT status FROM stock_alerts WHERE serial_key=? AND deleted_at IS NULL
      UNION ALL SELECT status FROM errors WHERE serial_key=? AND deleted_at IS NULL
    ) WHERE status NOT IN ('actioned','urgent')
  `).get(key, key).n;
  db.prepare("UPDATE runs SET charger_sorted = ? WHERE serial_key = ? AND deleted_at IS NULL")
    .run(open ? 0 : 1, key);
}

function softDelete(body) {
  const table = TABLE[String(body.type || "job")];
  if (!table) return { ok: false, error: "unknown type" };
  const id = Number(body.id);
  if (!Number.isInteger(id)) return { ok: false, error: "id is required" };
  db.prepare(`UPDATE ${table} SET deleted_at = datetime('now') WHERE id = ?`).run(id);
  if (table === "stock_alerts" || table === "errors") syncChargerSorted(id, table);
  return { ok: true };
}


/* ---------------- the board's own protocol ----------------
   The board was written against the Apps Script (?action=data / setstatus / delete …, rows matched
   by an id column such as shift_id or alert_id). Rather than rewrite 4,000 lines of board, the app
   answers the same calls — but every row has a real id, so a match always lands on exactly one row. */
const LEGACY_TYPE = { job: "job", error: "error", stock: "stock", flow: "flow", task: "task", ts: "troubleshoot", otherinfo: "otherinfo" };
const ID_FIELD = {   // the id column the board matches on → the column it is stored in
  jobs: ["shift_id", "shift_id"], errors: ["error_id", "ext_id"], stock_alerts: ["alert_id", "ext_id"],
  runs: ["flow_id", "run_id"], tasks: ["task_id", "task_id"], troubleshoots: ["troubleshoot_id", "submission_id"],
  other_info: ["submission_id", "submission_id"],
};
const LEGACY_FIELD = { status: "status", note: "note", ctype: "charger_type", linkdone: "charger_sorted",
  ov_removed: "ov_removed", ov_cu: "ov_cu", ov_cable: "ov_cable", due: "due", details: "details", updates: "updates", priority: "priority" };

function resolveRow(table, match) {
  if (match._id && Number(match._id) > 0) {
    const r = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(Number(match._id));
    return r ? r.id : null;
  }
  const [key, col] = ID_FIELD[table];
  if (match[key] != null && match[key] !== "") {
    const r = db.prepare(`SELECT id FROM ${table} WHERE ${col} = ? AND deleted_at IS NULL ORDER BY id DESC`).get(String(match[key]));
    return r ? r.id : null;
  }
  return null;
}

function legacy(who, p) {
  const action = String(p.action || "data");
  if (action === "data") {
    const d = snapshot();
    return { ...d, stock: d.stock, sortlylog: [], qtylog: [] };
  }
  if (action === "addtask") {
    if (!String(p.title || "").trim()) return { ok: false, error: "title is required" };
    const tid = String(p.task_id || `task_${randomUUID()}`);
    db.prepare(`INSERT INTO tasks (task_id,title,assignee,created_by,status,priority,details,updates,parent_id,parent_title,raised_by,due)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING`)
      .run(tid, String(p.title), String(p.assignee || ""), who, String(p.status || "todo"), String(p.priority || "medium"),
           String(p.details || ""), String(p.updates || "[]"), String(p.parent_id || ""), String(p.parent_title || ""), String(p.from || who), String(p.due || ""));
    return { ok: true, task_id: tid };
  }
  const type = LEGACY_TYPE[String(p.type || "job")];
  if (String(p.type) === "qty" || String(p.type) === "sortly") return { ok: true };       // those sheet tabs no longer exist
  if (!type) return { ok: false, error: `unknown type ${p.type}` };
  const table = TABLE[type];
  if (action === "clearcompleted") {
    const r = db.prepare(`UPDATE ${table} SET deleted_at = datetime('now') WHERE status = 'actioned' AND deleted_at IS NULL`).run();
    return { ok: true, cleared: r.changes };
  }
  let match = p.match || {};
  if (typeof match === "string") { try { match = JSON.parse(match); } catch { return { ok: false, error: "bad match json" }; } }
  const id = resolveRow(table, match);
  if (!id) return { ok: false, error: "no matching row" };
  if (action === "delete") return softDelete({ type, id });
  if (action === "setstatus") {
    const fields = {};
    for (const [k, col] of Object.entries(LEGACY_FIELD)) if (p[k] !== undefined && FIELDS[table].has(col)) fields[col] = p[k];
    if (!Object.keys(fields).length) return { ok: true, id, note: "nothing to set for this tab" };
    return applyWrite(who, { type, id, fields });
  }
  return { ok: false, error: `unknown action: ${action}` };
}

/* ---------------- the board itself ---------------- */
// One page, served from beside this file. An explicit allowlist rather than a directory
// server, so nothing else in the folder can ever be requested.
const PAGES = {
  "/": new URL("./index.html", import.meta.url),
  "/index.html": new URL("./index.html", import.meta.url),
  "/engineers": new URL("./engineers.html", import.meta.url),   // who's on monthly deliveries
};
async function servePage(res, urlPath) {
  const page = PAGES[urlPath];
  if (!page) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  try {
    const body = await readFile(page);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("page file is missing next to server.js");
  }
}

/* ---------------- routing ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    // --- Connecteam, straight in (replaces the deduction Zaps) ---
    if (path === "/hooks/connecteam") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
      const body = await readJson(req);
      const out = receiveWebhook(req.headers, body);
      logIngest("connecteam", out.code < 300, out.body.error || out.body.ignored || "", { eventType: body.eventType, formId: body.data?.formId, formSubmissionId: body.data?.formSubmissionId });
      return json(res, out.code, out.body);
    }

    // --- Zapier forwarding a Connecteam form (no Connecteam API on this account) ---
    if (path.startsWith("/ingest/form/")) {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
      const kind = path.slice("/ingest/form/".length);
      if (!keyOk(req)) { logIngest("form:" + kind, false, "bad key", {}); return json(res, 401, { ok: false, error: "bad or missing X-Api-Key" }); }
      const body = await readJson(req);
      try { const out = receiveFromZapier(kind, body); logIngest("form:" + kind, true, "", body); return json(res, 200, { ok: true, ...out }); }
      catch (e) { logIngest("form:" + kind, false, e.message, body); return json(res, 400, { ok: false, error: e.message }); }
    }

    // --- Zapier ---
    if (path.startsWith("/ingest/")) {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
      const kind = path.slice("/ingest/".length);
      if (!INGEST[kind]) return json(res, 404, { ok: false, error: `unknown endpoint: ${kind}` });
      if (!keyOk(req)) { logIngest(kind, false, "bad key", {}); return json(res, 401, { ok: false, error: "bad or missing X-Api-Key" }); }
      const body = await readJson(req);
      try {
        const out = INGEST[kind](body);
        logIngest(kind, true, "", body);
        return json(res, 200, { ok: true, ...out });
      } catch (e) {
        logIngest(kind, false, e.message, body);
        return json(res, 400, { ok: false, error: e.message });   // Zapier shows this as a failed step
      }
    }

    // --- login ---
    if (path === "/auth/login" && req.method === "POST") {
      const b = await readJson(req);
      const pw = String(b.password || "");
      const ok = pw.length === APP_PASSWORD.length && timingSafeEqual(Buffer.from(pw), Buffer.from(APP_PASSWORD));
      if (!ok) return json(res, 401, { ok: false, error: "Wrong password" });
      const name = PEOPLE.includes(b.name) ? b.name : (b.name ? String(b.name).slice(0, 40) : "");
      res.setHeader("Set-Cookie", `pib=${makeCookie(name)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}${process.env.INSECURE_COOKIE ? "" : "; Secure"}`);
      return json(res, 200, { ok: true, name });
    }
    if (path === "/auth/logout" && req.method === "POST") {
      res.setHeader("Set-Cookie", "pib=; HttpOnly; Path=/; Max-Age=0");
      return json(res, 200, { ok: true });
    }
    if (path === "/auth/me") {
      const name = readCookie(req);
      return json(res, 200, { ok: name !== null, name: name || "", people: PEOPLE });
    }

    // --- the board ---
    if (path.startsWith("/api/")) {
      const who = readCookie(req);
      if (who === null) return json(res, 401, { ok: false, error: "not signed in" });
      if (path === "/api/data") return json(res, 200, snapshot());
      if (path === "/api/legacy") {
        const p = req.method === "POST" ? await readJson(req) : Object.fromEntries(url.searchParams);
        const a = String(p.action || "data");
        if (a === "levels") return json(res, 200, await levels(p.fresh === "1"));
        if (a === "vanlevels") return json(res, 200, await vanLevels(p.fresh === "1"));
        if (a === "sortlyfolders") return json(res, 200, await folders());
        return json(res, 200, legacy(who, p));
      }
      // task notifications — what the board used to post to a Zapier catch hook
      if (path === "/api/notify" && req.method === "POST") {
        const b = await readJson(req);
        return json(res, 200, { ok: await notifySlack(String(b.message || b.text || ""), String(b.event || "task"), String(b.title || "Task")) });
      }
      if (path === "/api/write" && req.method === "POST") return json(res, 200, applyWrite(who, await readJson(req)));
      if (path === "/api/delete" && req.method === "POST") return json(res, 200, softDelete(await readJson(req)));
      if (path === "/api/task" && req.method === "POST") {
        const b = await readJson(req);
        if (!String(b.title || "").trim()) return json(res, 400, { ok: false, error: "title is required" });
        const tid = String(b.task_id || `task_${randomUUID()}`);
        db.prepare(`INSERT INTO tasks (task_id,title,assignee,created_by,status,priority,details,parent_id,parent_title,raised_by,due)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(tid, String(b.title), String(b.assignee || ""), who, "todo", String(b.priority || "medium"),
               String(b.details || ""), String(b.parent_id || ""), String(b.parent_title || ""), who, String(b.due || ""));
        return json(res, 200, { ok: true, task_id: tid });
      }
      if (path === "/api/invoice" && req.method === "POST") {
        const b = await readJson(req);
        const ref = String(b.id || `inv_${randomUUID()}`);
        db.prepare(`INSERT INTO invoices (ref,source,wholesaler,number,dated,lines,received,audited,resolved,flagged,note)
                    VALUES (@ref,@source,@wholesaler,@number,@dated,@lines,@received,@audited,@resolved,@flagged,@note)
                    ON CONFLICT(ref) DO UPDATE SET lines=excluded.lines, received=excluded.received,
                      audited=excluded.audited, resolved=excluded.resolved, flagged=excluded.flagged,
                      note=excluded.note, number=excluded.number, dated=excluded.dated, deleted_at=NULL`)
          .run({ ref, source: String(b.source || "us"), wholesaler: String(b.wholesaler || ""), number: String(b.number || ""),
                 dated: String(b.date || ""), lines: JSON.stringify(b.lines || []), received: b.received ? 1 : 0,
                 audited: b.audited ? 1 : 0, resolved: b.resolved ? 1 : 0, flagged: b.flagged ? 1 : 0, note: String(b.note || "") });
        return json(res, 200, { ok: true, id: ref });
      }
      if (path === "/api/invoice-delete" && req.method === "POST") {
        const b = await readJson(req);
        db.prepare("UPDATE invoices SET deleted_at = datetime('now') WHERE ref = ?").run(String(b.id || ""));
        db.prepare("DELETE FROM invoice_files WHERE invoice_ref = ?").run(String(b.id || ""));
        return json(res, 200, { ok: true });
      }
      // --- Sortly levels (Levels / Van stock tabs) ---
      if (path === "/api/levels") return json(res, 200, await levels(url.searchParams.get("fresh") === "1"));
      if (path === "/api/vanlevels") return json(res, 200, await vanLevels(url.searchParams.get("fresh") === "1"));
      if (path === "/api/sortlyfolders") return json(res, 200, await folders());

      // --- automations: status, re-run, backfill, engineers ---
      if (path === "/api/automation") return json(res, 200, automationStatus());
      if (path === "/api/automation/rerun" && req.method === "POST") {
        const b = await readJson(req);
        return json(res, 200, rerun(b.run_id || b.flow_id, !!b.redo));
      }
      if (path === "/api/automation/backfill" && req.method === "POST") {
        const b = await readJson(req);
        try { return json(res, 200, await backfill({ days: Number(b.days || 7) })); }
        catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      }
      if (path === "/api/engineers" && req.method === "GET") return json(res, 200, { ok: true, engineers: listEngineers() });
      if (path === "/api/engineers" && req.method === "POST") return json(res, 200, saveEngineer(await readJson(req)));
      if (path === "/api/ingest-log") {
        return json(res, 200, { ok: true, rows: db.prepare("SELECT * FROM ingest_log ORDER BY id DESC LIMIT 100").all() });
      }
      return json(res, 404, { ok: false, error: "unknown endpoint" });
    }

    if (path === "/health") return json(res, 200, { ok: true, at: nowIso() });
    return servePage(res, path);
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: "server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Plug In Dashboard listening on :${PORT} — automations in ${String(process.env.AUTOMATION_MODE || "shadow").toLowerCase() === "live" ? "LIVE" : "shadow"} mode`);
  resumeQueue();
  startLevelChecks();
});
