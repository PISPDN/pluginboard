// The Connecteam workflows the app now handles itself — no Zapier.
//
//   End of Job Report v2.0  →  chargerStep()  remove the installed charger from the engineer's Sortly folder
//                              cableStep()    monthly-delivery engineers only: EV Ultra metres off
//                              cuStep()       monthly-delivery engineers only: one IP65 or metal CU off
//   Troubleshoot            →  renameStep()   find the NEW charger in the engineer's folder and rename it:
//                                             Ohme → the RMA number; Hypervolt / EVEC → name + job details
//   Any Other Info          →  a flag on the board, nothing else
//
// Connecteam sends every form submission to POST /hooks/connecteam. The app replies "got it"
// straight away (Connecteam wants a reply inside 10 seconds or it sends it again), queues it, and
// works through the queue one submission at a time so two jobs never change the same Sortly item.
//
// AUTOMATION_MODE=shadow (the default) works everything out and records it on the board, but never
// writes to Sortly — so it can run next to the Zaps without anything being done twice.
// AUTOMATION_MODE=live does it for real. Nothing here posts to Slack: everything is kept on the board.

import { db, serialKey, cleanSerial } from "./db.js";
import { createHash } from "node:crypto";

const env = () => ({
  mode: String(process.env.AUTOMATION_MODE || "shadow").toLowerCase() === "live" ? "live" : "shadow",
  ctKey: process.env.CONNECTEAM_API_KEY || "",
  ctSecret: process.env.CONNECTEAM_WEBHOOK_SECRET || "",
  eojFormId: String(process.env.EOJ_FORM_ID || ""),
  tsFormId: String(process.env.TROUBLESHOOT_FORM_ID || ""),
  infoFormId: String(process.env.OTHER_INFO_FORM_ID || ""),
  sortlyKey: process.env.SORTLY_KEY || "",
  sortlyApi: (process.env.SORTLY_API || "https://api.sortly.co/api/v1").replace(/\/$/, ""),
  ctApi: (process.env.CONNECTEAM_API || "https://api.connecteam.com").replace(/\/$/, ""),
  sortlyGapMs: Number(process.env.SORTLY_GAP_MS || 300),
});

/* =====================================================================
   RULES — the bits you might want to change. Everything else is plumbing.
   ===================================================================== */
export const RULES = {
  // which Connecteam form is which (used when the *_FORM_ID settings aren't filled in)
  forms: {
    eoj: /end of job report/i,
    troubleshoot: /trou+ble\s*shoot/i,        // the Zap is spelt "Trouubleshoot", so allow either
    otherInfo: /any other info/i,
  },

  // End of Job Report — how each answer is found, by its question title
  eojQuestions: {
    serial:       { title: /charger serial number/i, notTitle: /picture|image|photo|upload/i },
    serialImage:  { title: /(picture|image|photo).*charger serial number/i, image: true },
    cable:        { title: /how much cable/i },
    suppliedFrom: { title: /where have you supplied/i },
    client:       { title: /^client name/i },
    postcode:     { title: /installation postcode/i },
    charger:      { title: /which charger was installed/i },
  },

  // Troubleshoot — the NEW charger's serial only; the old serial question is ignored
  troubleshootQuestions: {
    serial:     { title: /new.*serial/i, notTitle: /old|picture|image|photo|upload/i },
    rma:        { title: /\brma\b/i },
    keyAccount: { title: /key account/i },
    customer:   { title: /customer.*name|client.*name|^name/i },
    address:    { title: /address|postcode/i },
    issue:      { title: /fault|issue|problem|notes|describe/i },
    image:      { title: /photo|picture|image/i, image: true },
  },

  // items in each engineer's Sortly folder (used unless a fixed item id is set for them)
  cableItem: /ev\s*-?\s*ultra/i,
  ip65CuItem: /ip\s*-?\s*65|ip\s*rated/i,
  metalCuItem: /metal/i,
  looksLikeCu: /\bcu\b|consumer|unit|board/i,

  // Which CU comes off, from "Where have you supplied the EV installation from?"
  //   says "IP Rated" → IP65 CU      says "Metal" → metal CU      neither → no CU, skipped
  cuFor(answer) {
    const a = String(answer || "");
    if (/ip\s*rated|ip\s*65/i.test(a)) return "ip65";
    if (/metal/i.test(a)) return "metal";
    return null;
  },

  // a charger whose Sortly name says it is our own stock, not consignment
  plugInStock: /plug\s*in\s*stock/i,

  // warn (but still deduct) above this many metres — catches 250 typed for 25
  cableWarnOverM: 60,

  // Is this troubleshoot an Ohme one (gets an RMA)? Key Account first, then the charger's Sortly name.
  isOhme(keyAccount, chargerName) {
    if (keyAccount) return /ohme/i.test(keyAccount);
    return /ohme|epod|home\s*pro/i.test(chargerName || "");
  },

  // RMA numbers look like UK2875387. Engineers sometimes leave off the "UK".
  cleanRma(raw) {
    const t = String(raw || "").toUpperCase().replace(/[\s\-_.#:]/g, "");
    if (!t) return "";
    if (/^\d{5,}$/.test(t)) return "UK" + t;
    return t;
  },
  looksLikeRma: /^UK\d{5,}$/,
};

/* =====================================================================
   Connecteam
   ===================================================================== */
async function ct(path) {
  const { ctApi, ctKey } = env();
  if (!ctKey) throw new Error("CONNECTEAM_API_KEY is not set");
  const res = await fetch(ctApi + path, { headers: { "X-API-KEY": ctKey, Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Connecteam ${res.status} on ${path.split("?")[0]}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Form definitions — the webhook only carries question ids, so the question wording comes from here.
const formCache = new Map();   // formId -> { name, questions: Map(questionId -> {title, type}), order: [ids], at }
async function getForm(formId, { refresh = false } = {}) {
  const hit = formCache.get(String(formId));
  if (hit && !refresh && Date.now() - hit.at < 6 * 3600e3) return hit;
  const r = await ct(`/forms/v1/forms/${encodeURIComponent(formId)}`);
  const f = r.data?.form || r.data || r;
  const questions = new Map(), order = [];
  const walk = list => {
    for (const q of list || []) {
      if (q.questionId) { questions.set(String(q.questionId), { title: String(q.title || ""), type: String(q.questionType || "") }); order.push(String(q.questionId)); }
      if (Array.isArray(q.questions)) walk(q.questions);          // group questions
      if (Array.isArray(q.subQuestions)) walk(q.subQuestions);
    }
  };
  walk(f.questions);
  const out = { name: String(f.formName || f.name || ""), questions, order, at: Date.now() };
  formCache.set(String(formId), out);
  return out;
}

async function connecteamUserName(userId) {
  if (!userId) return "";
  const known = db.prepare("SELECT name FROM engineers WHERE connecteam_user_id = ?").get(String(userId));
  if (known) return known.name;
  const r = await ct(`/users/v1/users?userIds=${encodeURIComponent(userId)}&userStatus=all`);
  const u = (r.data?.users || r.users || [])[0];
  return u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() : "";
}

function answerValue(a) {
  if (!a || a.wasHidden || a.wasSubmittedEmpty) return { text: "", images: [] };
  const images = (a.images || a.files || []).map(i => i.url || i.fileUrl).filter(Boolean);
  let text = "";
  if (Array.isArray(a.selectedAnswers)) text = a.selectedAnswers.map(x => x.text).filter(Boolean).join(", ");
  else if (a.value != null && typeof a.value !== "object") text = String(a.value);
  else if (a.inputValue != null) text = String(a.inputValue);
  else if (a.selectedIndex != null) text = a.selectedIndex === 0 ? "Yes" : a.selectedIndex === 1 ? "No" : String(a.selectedIndex);
  else if (a.value && typeof a.value === "object") text = String(a.value.address || a.value.text || "");
  return { text: text.trim(), images };
}

// Picks out the answers a process needs, by question wording.
function readAnswers(data, form, rules) {
  const out = { _missing: [] };
  const answers = (data.answers || []).map(a => ({ a, q: form.questions.get(String(a.questionId)) || { title: "", type: a.questionType } }));
  for (const [key, rule] of Object.entries(rules)) {
    const hit = answers.find(({ q, a }) => rule.title.test(q.title) && !(rule.notTitle && rule.notTitle.test(q.title))
      && (rule.image ? (a.images || a.files || []).length : !/image|photo|signature|file/i.test(q.type || "")));
    if (!hit) { out[key] = ""; out._missing.push(key); continue; }
    const v = answerValue(hit.a);
    out[key] = rule.image ? (v.images[0] || "") : v.text;
  }
  return out;
}

// Every answer, in form order, for the Any Other Info card.
function allAnswers(data, form) {
  const byId = new Map((data.answers || []).map(a => [String(a.questionId), a]));
  const ids = [...form.order.filter(id => byId.has(id)), ...[...byId.keys()].filter(id => !form.order.includes(id))];
  return ids.map(id => {
    const a = byId.get(id), v = answerValue(a);
    return { question: form.questions.get(id)?.title || id, answer: v.text, images: v.images };
  }).filter(x => x.answer || x.images.length);
}

/* =====================================================================
   Sortly
   ===================================================================== */
let lastSortlyCall = 0;
export async function sortly(method, path, body) {
  const { sortlyApi, sortlyKey, sortlyGapMs } = env();
  if (!sortlyKey) throw new Error("SORTLY_KEY is not set");
  const waits = [2000, 5000, 15000, 30000];
  for (let attempt = 0; ; attempt++) {
    const gap = lastSortlyCall + sortlyGapMs - Date.now();
    if (gap > 0) await sleep(gap);
    lastSortlyCall = Date.now();
    let res;
    try {
      res = await fetch(sortlyApi + path, {
        method,
        headers: { Authorization: `Bearer ${sortlyKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt < waits.length) { await sleep(waits[attempt]); continue; }
      throw new Error(`Sortly unreachable: ${e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < waits.length) { await sleep(waits[attempt]); continue; }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error(`Sortly refused the API key (${res.status}) — check SORTLY_KEY`);
    if (!res.ok) throw new Error(`Sortly ${res.status} on ${method} ${path.split("?")[0]}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Everything in an engineer's folder, sub-folders included, every page.
// (The Zap read one page of 100 and reported "charger not found" when the van held more.)
async function folderItems(folderId) {
  const items = [];
  const queue = [{ id: String(folderId), path: "", depth: 0 }];
  while (queue.length) {
    const f = queue.shift();
    for (let page = 1; page <= 50; page++) {
      const r = await sortly("GET", `/items?folder_id=${encodeURIComponent(f.id)}&per_page=100&page=${page}`);
      const list = r.data || [];
      for (const it of list) {
        if (String(it.type || "").toLowerCase() === "folder") {
          if (f.depth < 3) queue.push({ id: String(it.id), path: f.path ? `${f.path} / ${it.name}` : String(it.name || ""), depth: f.depth + 1 });
        } else {
          items.push({ id: String(it.id), name: String(it.name || ""), quantity: Number(it.quantity ?? 0),
                       serial: String(it.label_url_extra || ""), folder: f.path });
        }
      }
      if (list.length < 100) break;
    }
  }
  return items;
}

// The one charger in the van carrying this serial (ignoring case, spaces, dashes).
function findCharger(items, serial) {
  const key = serialKey(serial);
  if (!key) return { error: "no serial", none: true };
  let hits = items.filter(i => i.serial && serialKey(i.serial) === key);
  let how = "serial";
  if (!hits.length && key.length >= 6) { hits = items.filter(i => serialKey(i.name).includes(key)); how = "name"; }
  if (!hits.length) return { none: true };
  if (hits.length > 1) return { many: hits };
  return { item: hits[0], how };
}

/* =====================================================================
   Engineers
   ===================================================================== */
const canon = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
function findEngineer(name, userId) {
  if (userId) {
    const byId = db.prepare("SELECT * FROM engineers WHERE connecteam_user_id = ? AND active = 1").get(String(userId));
    if (byId) return byId;
  }
  const all = db.prepare("SELECT * FROM engineers WHERE active = 1").all();
  const c = canon(name);
  let hit = all.find(e => canon(e.name) === c);
  if (!hit && c) {
    // "Jack Place" vs "Jack  Place (Van 4)" — first and last name both present, and only one such engineer
    const parts = String(name).toLowerCase().split(/\s+/).map(canon).filter(Boolean);
    const loose = all.filter(e => parts.length >= 2 && parts.every(p => canon(e.name).includes(p)));
    if (loose.length === 1) hit = loose[0];
  }
  if (hit && userId && !hit.connecteam_user_id) {
    db.prepare("UPDATE engineers SET connecteam_user_id = ?, updated_at = datetime('now') WHERE id = ?").run(String(userId), hit.id);
  }
  return hit || null;
}

export function listEngineers() {
  return db.prepare("SELECT * FROM engineers ORDER BY active DESC, name").all();
}
const ENG_FIELDS = ["name", "connecteam_user_id", "sortly_folder_id", "cable_item_id", "metal_cu_item_id", "ip65_cu_item_id", "active", "monthly"];
const ALL = [...ENG_FIELDS, "monthly_since"];
export function saveEngineer(b) {
  const before = b.id ? db.prepare("SELECT * FROM engineers WHERE id = ?").get(Number(b.id))
                      : db.prepare("SELECT * FROM engineers WHERE name = ?").get(String(b.name || "").trim());
  const name = String(b.name ?? before?.name ?? "").trim();
  if (!name) return { ok: false, error: "name is required" };
  // only the fields sent are changed — ticking "monthly" doesn't blank the folder id
  const flag = v => (v === true || v === 1 || v === "1" || v === "yes" || v === "on" ? 1 : 0);
  const row = { name };
  for (const k of ENG_FIELDS) {
    if (k === "name") continue;
    if (b[k] === undefined) row[k] = before ? before[k] : (k === "active" ? 1 : k === "monthly" ? 0 : "");
    else row[k] = k === "active" || k === "monthly" ? flag(b[k]) : String(b[k] ?? "").trim();
  }
  // remember when someone went onto monthly deliveries
  row.monthly_since = row.monthly ? (before?.monthly ? before.monthly_since : new Date().toISOString().slice(0, 10)) : "";
  if (before) {
    db.prepare(`UPDATE engineers SET ${ALL.map(k => `${k}=@${k}`).join(",")}, updated_at=datetime('now') WHERE id=@id`).run({ ...row, id: before.id });
  } else {
    db.prepare(`INSERT INTO engineers (${ALL.join(",")}) VALUES (${ALL.map(k => "@" + k).join(",")})`).run(row);
  }
  return { ok: true };
}

// Works out the engineer and reads their van. Returns { engineer, items } or { fatal }.
async function engineerAndVan(engineerName, userId) {
  const engineer = findEngineer(engineerName, userId);
  if (!engineer) return { fatal: `${engineerName || `Connecteam user ${userId}`} isn't in the app's engineer list — add them on the Engineers page` };
  if (!engineer.sortly_folder_id) return { engineer, fatal: `${engineer.name} has no Sortly folder id set on the Engineers page` };
  try { return { engineer, items: await folderItems(engineer.sortly_folder_id) }; }
  catch (e) { return { engineer, fatal: `Couldn't read ${engineer.name}'s Sortly folder: ${e.message}` }; }
}

/* =====================================================================
   Step bookkeeping — a step done for real is never repeated by a re-run
   ===================================================================== */
async function runStep(name, fn, ctx, prev, save, force) {
  const p = prev[name];
  if (p && p.state === "done") return p;
  if (p && (p.state === "started" || p.state === "check") && !force) {
    return { ...p, state: "check", error: "This step was interrupted part-way last time — check Sortly by hand, then re-run with “redo interrupted steps”" };
  }
  if (ctx.live) { prev[name] = { state: "started", at: new Date().toISOString() }; save(prev); }
  try { return await fn(ctx); }
  catch (e) { return { state: "error", error: e.message }; }
}
const ukDate = iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { timeZone: "Europe/London" }) : "");

/* =====================================================================
   1. END OF JOB REPORT — charger, EV Ultra, CU
   ===================================================================== */
function pickItem(items, overrideId, test, label) {
  if (overrideId) {
    const it = items.find(i => i.id === String(overrideId));
    return it ? { item: it, how: "fixed id" } : { error: `${label}: fixed item id ${overrideId} isn't in this engineer's Sortly folder` };
  }
  const hits = items.filter(test);
  if (hits.length === 1) return { item: hits[0], how: "by name" };
  if (!hits.length) return { error: `${label}: no item in the van's Sortly folder matches` };
  return { error: `${label}: ${hits.length} items match (${hits.slice(0, 4).map(h => h.name).join(" · ")}) — set a fixed item id on the Engineers page` };
}

async function chargerStep(ctx) {
  const { answers, items, live, engineer } = ctx;
  const serial = cleanSerial(answers.serial);
  if (!serialKey(serial)) return { state: "error", found: "no", error: "No charger serial number on the form", alert: "NO CHARGER SERIAL NUMBER ENTERED ON THE END OF JOB REPORT" };
  const f = findCharger(items, serial);
  if (f.none) return { state: "error", found: "no", error: `Charger ${serial} isn't in ${engineer.name}'s Sortly folder — remove it by hand`,
                       alert: "POSSIBLE USAGE OF OUR STOCK, ENGINEER TYPED THE SERIAL NUMBER WRONG" };
  if (f.many) return { state: "error", found: "yes", error: `${f.many.length} Sortly items carry serial ${serial} — nothing removed, sort it by hand`,
                       alert: "MORE THAN ONE CHARGER IN SORTLY WITH THIS SERIAL — NOTHING REMOVED" };
  const it = f.item;
  const ours = RULES.plugInStock.test(it.name);
  const base = { found: "yes", item_id: it.id, item_name: it.name, matched_by: f.how, plug_in_stock: ours ? "yes" : "no",
                 alert: ours ? "PLUG IN STOCK CHARGER USED ON THIS JOB" : "" };
  if (!live) return { ...base, state: "shadow", would: `remove "${it.name}" (item ${it.id}) from Sortly` };
  await sortly("DELETE", `/items/${encodeURIComponent(it.id)}`);
  return { ...base, state: "done", removed: "yes" };
}

function cableMetres(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return { error: "Cable used was left blank" };
  if (/^(none|nil|n\/?a|no|zero|pre[- ]?(ran|run|installed).*)$/.test(t)) return { m: 0 };
  const m = t.replace(",", ".").match(/(\d+(?:\.\d+)?)/);
  if (!m) return { error: `Couldn't read a number of metres from "${text}"` };
  return { m: Number(m[1]) };
}

// CU and EV Ultra are only measured for engineers on monthly deliveries.
const notMonthly = e => ({ state: "skipped", note: `${e.name} isn't on monthly deliveries — not measured` });

async function cableStep(ctx) {
  const { answers, items, engineer, live } = ctx;
  if (!engineer.monthly) return notMonthly(engineer);
  const used = cableMetres(answers.cable);
  if (used.error) return { state: "error", error: used.error, typed: answers.cable };
  if (!used.m) return { state: "skipped", used: 0, note: "No cable used" };
  const pick = pickItem(items, engineer.cable_item_id, i => RULES.cableItem.test(i.name), "EV Ultra cable");
  if (pick.error) return { state: "error", used: used.m, error: pick.error };
  const it = pick.item;
  const warn = used.m > RULES.cableWarnOverM ? `${used.m} m is unusually long — check the form` : "";
  if (!live) {
    const after = it.quantity - used.m;
    return { state: "shadow", used: used.m, item_id: it.id, item_name: it.name, before: it.quantity, after, warn,
             would: `${it.name}: ${it.quantity} → ${after}` };
  }
  const fresh = await sortly("GET", `/items/${encodeURIComponent(it.id)}`);
  const before = Number(fresh.data?.quantity ?? it.quantity);
  let after = Math.round((before - used.m) * 100) / 100;
  const below = after < 0;
  if (below) after = 0;
  await sortly("PUT", `/items/${encodeURIComponent(it.id)}`, { quantity: after });
  return { state: "done", used: used.m, item_id: it.id, item_name: it.name, before, after,
           warn: [warn, below ? `van only had ${before} m — set to 0` : ""].filter(Boolean).join("; ") };
}

async function cuStep(ctx) {
  const { answers, items, engineer, live } = ctx;
  if (!engineer.monthly) return notMonthly(engineer);
  const type = RULES.cuFor(answers.suppliedFrom);
  if (!type) return { state: "skipped", supplied_from: answers.suppliedFrom,
                      note: answers.suppliedFrom ? `Not IP rated / metal — none taken` : "Supply point left blank — none taken" };
  const pick = type === "ip65"
    ? pickItem(items, engineer.ip65_cu_item_id, i => RULES.ip65CuItem.test(i.name), "IP65 CU")
    : pickItem(items, engineer.metal_cu_item_id, i => RULES.metalCuItem.test(i.name) && RULES.looksLikeCu.test(i.name) && !RULES.ip65CuItem.test(i.name), "Metal CU");
  if (pick.error) return { state: "error", type, supplied_from: answers.suppliedFrom, error: pick.error };
  const it = pick.item;
  if (!live) return { state: "shadow", type, item_id: it.id, item_name: it.name, before: it.quantity, after: it.quantity - 1,
                      would: `${it.name}: ${it.quantity} → ${it.quantity - 1}` };
  const fresh = await sortly("GET", `/items/${encodeURIComponent(it.id)}`);
  const before = Number(fresh.data?.quantity ?? it.quantity);
  if (before <= 0) return { state: "error", type, item_id: it.id, item_name: it.name, before, error: `${it.name} is already at 0 in Sortly — nothing taken off` };
  await sortly("PUT", `/items/${encodeURIComponent(it.id)}`, { quantity: before - 1 });
  return { state: "done", type, item_id: it.id, item_name: it.name, before, after: before - 1 };
}

async function processEndOfJob(sub, data, form, cfg) {
  const live = cfg.mode === "live";
  const answers = readAnswers(data, form, RULES.eojQuestions);
  const engineerName = data._engineer ?? await connecteamUserName(data.submittingUserId);
  const when = submittedAt(data);
  const runId = `ct_${sub.submission_id}`;
  const job = [answers.postcode, answers.client, ukDate(when)].filter(Boolean).join(" · ");

  // the run row exists from the start, so a crash part-way still leaves a trace on the Flow tab
  db.prepare(`INSERT INTO runs (run_id, source, submission_id, engineer, serial, serial_key, job, ran_at, mode)
              VALUES (?, 'app', ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id) DO UPDATE SET mode = excluded.mode, deleted_at = NULL`)
    .run(runId, sub.submission_id, engineerName, cleanSerial(answers.serial), serialKey(answers.serial), job, when, cfg.mode);
  const old = db.prepare("SELECT steps FROM runs WHERE run_id = ?").get(runId);
  const prev = JSON.parse(old?.steps || "{}");
  const save = s => db.prepare("UPDATE runs SET steps = ? WHERE run_id = ?").run(JSON.stringify(s), runId);

  const van = await engineerAndVan(engineerName, data.submittingUserId);
  const engineer = van.engineer;
  const result = {};
  if (van.fatal) {
    for (const k of ["charger", "cable", "cu"]) result[k] = prev[k]?.state === "done" ? prev[k] : { state: "error", error: van.fatal };
  } else {
    const ctx = { answers, items: van.items, engineer, live };
    for (const [k, fn] of [["charger", chargerStep], ["cable", cableStep], ["cu", cuStep]]) {
      result[k] = await runStep(k, fn, ctx, prev, save, !!sub.force);
      prev[k] = result[k];
      if (live) save(prev);
    }
  }

  const c = result.charger, k = result.cable, u = result.cu;
  const errors = [...new Set([c, k, u].filter(s => s && ["error", "check"].includes(s.state)).map(s => s.error))];
  const warns = [k?.warn].filter(Boolean);
  const yes = s => (s === "done" ? "yes" : s === "shadow" ? "shadow" : s === "skipped" ? "skipped" : s ? "no" : "");

  db.prepare(`UPDATE runs SET engineer=@engineer, cu=@cu, cable=@cable, job=@job,
                charger_found=@found, charger_removed=@removed, cu_adjust=@cu_adjust, cable_adjust=@cable_adjust,
                sortly_removed=@removed, sortly_cu=@sortly_cu, sortly_cable=@sortly_cable,
                zap_error=@error, sortly_error='', qty_error=@warn, steps=@steps, extra=@extra, mode=@mode
              WHERE run_id=@run_id`).run({
    run_id: runId, mode: cfg.mode,
    engineer: engineer?.name || engineerName,
    cu: u?.type ? (u.type === "ip65" ? "IP65" : "Metal") + (u.item_name ? ` — ${u.item_name}` : "") : (u?.state === "skipped" ? "None" : ""),
    cable: k?.used != null ? `${k.used} m` : String(answers.cable || ""),
    job,
    found: c?.found || "",
    removed: yes(c?.state),
    cu_adjust: u?.item_id && ["done", "shadow"].includes(u.state) ? "-1" : "",
    cable_adjust: k?.used ? `-${k.used}` : "",
    sortly_cu: yes(u?.state), sortly_cable: yes(k?.state),
    error: errors.join(" | "), warn: warns.join(" | "),
    steps: JSON.stringify(prev),
    extra: JSON.stringify({
      client: answers.client, postcode: answers.postcode, charger_model: answers.charger,
      supplied_from: answers.suppliedFrom, serial_image: answers.serialImage,
      ...(u?.note ? { cu_note: u.note } : {}), ...(k?.note ? { cable_note: k.note } : {}),
      monthly_deliveries: engineer ? (engineer.monthly ? "yes" : "no") : "",
      ...(cfg.mode === "shadow" ? { would_do: [c?.would, k?.would, u?.would].filter(Boolean).join(" | ") } : {}),
      ...(answers._missing.length ? { form_fields_not_found: answers._missing.join(", ") } : {}),
    }),
  });

  // Stock tab: charger not found / doubled / Plug In stock used / engineer missing — for you to sort by hand.
  // Live only: in shadow the Zaps are still raising these.
  if (live) {
    const alerts = [];
    if (van.fatal && prev.charger?.state !== "done") alerts.push(van.fatal);
    if (c?.alert) alerts.push(c.alert);
    alerts.forEach((msg, i) => {
      db.prepare(`INSERT INTO stock_alerts (ext_id, run_id, engineer, item, serial, serial_key, job, message, image_url, occurred_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ext_id) DO UPDATE SET message=excluded.message, deleted_at=NULL`)
        .run(`stk_${runId}_${i}`, runId, engineer?.name || engineerName, c?.item_name || answers.charger || "",
             cleanSerial(answers.serial), serialKey(answers.serial), job, msg, answers.serialImage || "", when);
    });
  }
  return { state: errors.length ? "failed" : "done", detail: errors.join(" | ") || (live ? "ok" : "shadow — nothing written") };
}

/* =====================================================================
   2. TROUBLESHOOT — rename the charger that replaced the faulty one
   ===================================================================== */
// What the charger is renamed to.
function newName(t) {
  const details = [[t.customer, t.address].filter(Boolean).join(" "), t.engineer, ukDate(t.submitted_at)].filter(Boolean).join(" · ");
  if (t.kind === "rma") return t.rma ? t.rma : `NO RMA · ${t.previous_name} · ${details}`;
  return `${t.previous_name} · RETURN · ${details}`;         // Hypervolt / EVEC: keep the name, add who and where
}

async function renameStep(ctx) {
  const { t, items, live } = ctx;
  if (!serialKey(t.serial)) return { state: "error", found: "no", error: "No new charger serial number on the troubleshoot" };
  const f = findCharger(items, t.serial);
  if (f.none) return { state: "error", found: "no", error: `New charger ${t.serial} isn't in ${t.engineer}'s Sortly folder — nothing renamed` };
  if (f.many) return { state: "error", found: "yes", error: `${f.many.length} Sortly items carry serial ${t.serial} — nothing renamed` };
  const it = f.item;
  t.previous_name = it.name;
  t.kind = RULES.isOhme(t.key_account, it.name) ? "rma" : "return";
  const to = newName(t).slice(0, 190);
  const base = { found: "yes", item_id: it.id, previous_name: it.name, renamed_to: to, kind: t.kind };
  if (it.name === to) return { ...base, state: "done", note: "already has that name" };
  if (!live) return { ...base, state: "shadow", would: `rename "${it.name}" → "${to}"` };
  await sortly("PUT", `/items/${encodeURIComponent(it.id)}`, { name: to });
  return { ...base, state: "done" };
}

async function processTroubleshoot(sub, data, form, cfg) {
  const live = cfg.mode === "live";
  const a = readAnswers(data, form, RULES.troubleshootQuestions);
  const engineerName = data._engineer ?? await connecteamUserName(data.submittingUserId);
  const when = submittedAt(data);
  const rmaTyped = a.rma;
  const rma = RULES.cleanRma(rmaTyped);
  const t = { serial: cleanSerial(a.serial), rma, key_account: a.keyAccount, customer: a.customer, address: a.address,
              engineer: engineerName, submitted_at: when, previous_name: "", kind: a.keyAccount ? (/ohme/i.test(a.keyAccount) ? "rma" : "return") : "" };

  db.prepare(`INSERT INTO troubleshoots (submission_id, engineer, key_account, kind, serial, serial_key, rma, customer, address, issue, image_url, submitted_at, mode)
              VALUES (@sid,@engineer,@key_account,@kind,@serial,@serial_key,@rma,@customer,@address,@issue,@image,@when,@mode)
              ON CONFLICT(submission_id) DO UPDATE SET mode = excluded.mode, deleted_at = NULL`)
    .run({ sid: sub.submission_id, engineer: engineerName, key_account: a.keyAccount, kind: t.kind, serial: t.serial, serial_key: serialKey(t.serial),
           rma, customer: a.customer, address: a.address, issue: a.issue, image: a.image, when, mode: cfg.mode });
  const row = db.prepare("SELECT * FROM troubleshoots WHERE submission_id = ?").get(sub.submission_id);
  const prev = JSON.parse(row.steps || "{}");
  const save = s => db.prepare("UPDATE troubleshoots SET steps = ? WHERE id = ?").run(JSON.stringify(s), row.id);

  const van = await engineerAndVan(engineerName, data.submittingUserId);
  if (van.engineer) t.engineer = van.engineer.name;
  let r;
  if (van.fatal) r = prev.rename?.state === "done" ? prev.rename : { state: "error", error: van.fatal };
  else {
    r = await runStep("rename", renameStep, { t, items: van.items, live }, prev, save, !!sub.force);
    prev.rename = r;
  }

  // what to flag on the board
  const problems = [];
  if (["error", "check"].includes(r.state)) problems.push(r.error);
  const kind = r.kind || t.kind;
  if (kind === "rma" && !rma) problems.push("No RMA number on the troubleshoot");
  else if (kind === "rma" && !RULES.looksLikeRma.test(rma)) problems.push(`RMA "${rmaTyped}" doesn't look like UK1234567 — used as typed`);

  db.prepare(`UPDATE troubleshoots SET engineer=@engineer, kind=@kind, found=@found, item_id=@item_id, previous_name=@prev,
                renamed_to=@to, renamed=@renamed, problem=@problem, steps=@steps, extra=@extra WHERE id=@id`).run({
    id: row.id, engineer: t.engineer, kind, found: r.found || "", item_id: r.item_id || "",
    prev: r.previous_name || "", to: r.renamed_to || "",
    renamed: r.state === "done" ? "yes" : r.state === "shadow" ? "shadow" : "no",
    problem: problems.join(" | "), steps: JSON.stringify(prev),
    extra: JSON.stringify({ rma_as_typed: rmaTyped, ...(r.would ? { would_do: r.would } : {}),
                            ...(a._missing.length ? { form_fields_not_found: a._missing.join(", ") } : {}) }),
  });
  const failed = ["error", "check"].includes(r.state);
  return { state: failed ? "failed" : "done", detail: problems.join(" | ") || (live ? "ok" : "shadow — nothing written") };
}

/* =====================================================================
   3. ANY OTHER INFO — flag it, nothing else
   ===================================================================== */
async function processOtherInfo(sub, data, form) {
  const engineerName = data._engineer ?? await connecteamUserName(data.submittingUserId).catch(() => "");
  const when = submittedAt(data);
  db.prepare(`INSERT INTO other_info (submission_id, engineer, answers, submitted_at) VALUES (?,?,?,?)
              ON CONFLICT(submission_id) DO UPDATE SET answers = excluded.answers, deleted_at = NULL`)
    .run(sub.submission_id, engineerName, JSON.stringify(allAnswers(data, form)), when);
  return { state: "done", detail: "flagged on the board" };
}

/* =====================================================================
   Router — which workflow is this?
   ===================================================================== */
function whichForm(formId, form, cfg) {
  if (cfg.eojFormId && formId === cfg.eojFormId) return "eoj";
  if (cfg.tsFormId && formId === cfg.tsFormId) return "troubleshoot";
  if (cfg.infoFormId && formId === cfg.infoFormId) return "otherInfo";
  if (!cfg.eojFormId && RULES.forms.eoj.test(form.name)) return "eoj";
  if (!cfg.tsFormId && RULES.forms.troubleshoot.test(form.name)) return "troubleshoot";
  if (!cfg.infoFormId && RULES.forms.otherInfo.test(form.name)) return "otherInfo";
  return null;
}

function submittedAt(data) {
  if (data._when) { const d = new Date(data._when); if (!isNaN(d)) return d.toISOString(); }
  return data.submissionTimestamp ? new Date(Number(data.submissionTimestamp) * 1000).toISOString() : new Date().toISOString();
}

/* =====================================================================
   Forwarded by Zapier — there is no Connecteam API on this account, so each workflow has a
   two-step Zap: Connecteam "New Form Submission" → Webhooks POST to /ingest/form/<kind>, sending
   everything (Data Pass-Through). The field names Zapier uses are the question wording, so the
   same rules above find the answers.
   ===================================================================== */
const ZAP_KIND = { eoj: "eoj", "end-of-job": "eoj", troubleshoot: "troubleshoot", "other-info": "otherInfo", otherinfo: "otherInfo" };
const tidyKey = k => String(k).replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
const firstKey = (body, re) => Object.keys(body).find(k => re.test(tidyKey(k)));
const looksLikeUrl = v => /^https?:\/\/\S+$/i.test(String(v).trim().split(/[\s,]+/)[0] || "");

function flatToSubmission(kind, body) {
  const kEng = firstKey(body, /^(engineer|submitting user (full )?name|submitter( full)? name|user full name)$/i)
            || firstKey(body, /submitting user.*name|full name/i);
  const kId = firstKey(body, /^(submission id|form submission id|entry id|id)$/i) || firstKey(body, /submission id/i);
  const kWhen = firstKey(body, /^(when|submission date|submitted at|submission timestamp|date)$/i) || firstKey(body, /submission (date|time)/i);
  const skip = new Set([kEng, kId, kWhen].filter(Boolean));
  const questions = new Map(), order = [], answers = [];
  for (const [k, v] of Object.entries(body)) {
    if (skip.has(k) || v == null || typeof v === "object") continue;
    const text = String(v).trim();
    const isImg = looksLikeUrl(text);
    questions.set(k, { title: tidyKey(k), type: isImg ? "image" : "openEnded" }); order.push(k);
    answers.push(isImg ? { questionId: k, questionType: "image", images: text.split(/[\s,]+/).filter(looksLikeUrl).map(url => ({ url })) }
                       : { questionId: k, questionType: "openEnded", value: text });
  }
  const sid = kId && String(body[kId]).trim();
  return {
    id: sid || "zap_" + createHash("sha1").update(kind + JSON.stringify(body)).digest("hex").slice(0, 20),
    data: { _zapier: true, _kind: kind, _engineer: kEng ? String(body[kEng]).trim() : "", _when: kWhen ? String(body[kWhen]) : "", answers },
    form: { name: kind, questions, order },
  };
}

// POST /ingest/form/<kind> — called by the forwarding Zap (X-Api-Key checked by the server)
export function receiveFromZapier(kindRaw, body) {
  const kind = ZAP_KIND[String(kindRaw || "").toLowerCase()];
  if (!kind) throw new Error(`unknown form "${kindRaw}" — use eoj, troubleshoot or other-info`);
  if (!body || !Object.keys(body).length) throw new Error("empty body — turn on Data Pass-Through in the Webhooks step");
  const f = flatToSubmission(kind, body);
  const r = db.prepare(`INSERT INTO submissions (submission_id, form_id, event_type, payload, kind) VALUES (?,?,?,?,?)
                        ON CONFLICT(submission_id) DO NOTHING`).run(f.id, kind, "zapier", JSON.stringify({ source: "zapier", kind, body }), kind);
  kick();
  return { submission_id: f.id, queued: r.changes > 0, duplicate: r.changes === 0, engineer: f.data._engineer || "(not found — check the field names)" };
}

export async function processSubmission(sub) {
  const cfg = env();
  const payload = JSON.parse(sub.payload || "{}");
  if (payload.source === "zapier") {
    const f = flatToSubmission(payload.kind, payload.body || {});
    if (payload.kind === "eoj") return processEndOfJob(sub, f.data, f.form, cfg);
    if (payload.kind === "troubleshoot") return processTroubleshoot(sub, f.data, f.form, cfg);
    return processOtherInfo(sub, f.data, f.form);
  }
  const data = payload.data || {};
  const formId = String(data.formId ?? sub.form_id ?? "");
  let form = await getForm(formId);
  if ((data.answers || []).some(a => !form.questions.has(String(a.questionId)))) form = await getForm(formId, { refresh: true });
  const kind = whichForm(formId, form, cfg);
  db.prepare("UPDATE submissions SET kind = ? WHERE id = ?").run(kind || "", sub.id);
  if (kind === "eoj") return processEndOfJob(sub, data, form, cfg);
  if (kind === "troubleshoot") return processTroubleshoot(sub, data, form, cfg);
  if (kind === "otherInfo") return processOtherInfo(sub, data, form);
  return { state: "ignored", detail: `form ${formId} (${form.name || "?"}) isn't one the app handles` };
}

/* =====================================================================
   Queue
   ===================================================================== */
let working = false;
export function kick() {
  if (working) return;
  working = true;
  setImmediate(async () => {
    try {
      for (;;) {
        const sub = db.prepare("SELECT * FROM submissions WHERE state = 'queued' ORDER BY id LIMIT 1").get();
        if (!sub) break;
        db.prepare("UPDATE submissions SET state='processing', attempts=attempts+1 WHERE id=?").run(sub.id);
        let out;
        try { out = await processSubmission(sub); }
        catch (e) { out = { state: "failed", detail: e.message }; }
        db.prepare("UPDATE submissions SET state=?, detail=?, force=0, processed_at=datetime('now') WHERE id=?")
          .run(out.state, String(out.detail || "").slice(0, 2000), sub.id);
      }
    } finally {
      working = false;
    }
  });
}

// After a restart: anything caught mid-way goes back on the queue. Steps that had started
// writing are flagged "check" rather than repeated — see runStep().
export function resumeQueue() {
  db.prepare("UPDATE submissions SET state='queued' WHERE state='processing'").run();
  kick();
}

/* =====================================================================
   What the server calls
   ===================================================================== */
// POST /hooks/connecteam — one webhook covers every form; the router above decides what each one is.
export function receiveWebhook(headers, body) {
  const { ctSecret } = env();
  if (!ctSecret) return { code: 503, body: { ok: false, error: "CONNECTEAM_WEBHOOK_SECRET is not set on the app" } };
  if (String(headers["x-webhook-secret"] || "") !== ctSecret) return { code: 401, body: { ok: false, error: "bad x-webhook-secret" } };
  if (body.eventType !== "form_submission") return { code: 200, body: { ok: true, ignored: body.eventType || "no eventType" } };
  const data = body.data || {};
  const sid = String(data.formSubmissionId || "");
  if (!sid) return { code: 400, body: { ok: false, error: "no formSubmissionId" } };
  // Connecteam sends again if it doesn't hear back — the UNIQUE id means each one is only queued once
  const r = db.prepare(`INSERT INTO submissions (submission_id, form_id, event_type, payload) VALUES (?,?,?,?)
                        ON CONFLICT(submission_id) DO NOTHING`).run(sid, String(data.formId ?? ""), body.eventType, JSON.stringify(body));
  kick();
  return { code: 200, body: { ok: true, queued: r.changes > 0, duplicate: r.changes === 0 } };
}

// Re-run from the board. Takes a Flow run_id ("ct_…") or a troubleshoot's submission id.
// redo=true also redoes steps that were interrupted part-way.
export function rerun(id, redo = false) {
  const s = String(id || "");
  const run = db.prepare("SELECT submission_id FROM runs WHERE run_id = ?").get(s);
  const sid = run?.submission_id || (db.prepare("SELECT submission_id FROM submissions WHERE submission_id = ?").get(s)?.submission_id);
  if (!sid) return { ok: false, error: "That run didn't come from the app (it's a Zapier run) — nothing to re-run" };
  const r = db.prepare("UPDATE submissions SET state='queued', force=? WHERE submission_id=? AND state != 'processing'").run(redo ? 1 : 0, sid);
  if (!r.changes) return { ok: false, error: "It's already running" };
  kick();
  return { ok: true };
}

// Pull past End of Job Reports and Troubleshoots straight from Connecteam — shadow mode only, so jobs
// the Zaps already did can be compared without being done a second time.
export async function backfill({ days = 7, limit = 300 } = {}) {
  const cfg = env();
  if (cfg.mode !== "shadow") return { ok: false, error: "Backfill only runs in shadow mode — in live mode it would redo jobs the Zaps already did" };
  const ids = [cfg.eojFormId, cfg.tsFormId].filter(Boolean);
  if (!ids.length) return { ok: false, error: "Set EOJ_FORM_ID (and TROUBLESHOOT_FORM_ID) first" };
  const since = Date.now() / 1000 - Number(days) * 86400;
  let added = 0, seen = 0;
  for (const formId of ids) {
    for (let offset = 0; offset < limit; offset += 100) {
      const r = await ct(`/forms/v1/forms/${formId}/form_submissions?limit=100&offset=${offset}`);
      const list = r.data?.formSubmissions || r.data?.submissions || (Array.isArray(r.data) ? r.data : []);
      for (const s of list) {
        seen++;
        if (Number(s.submissionTimestamp || 0) < since) continue;
        const body = { eventType: "form_submission", data: { ...s, formId: s.formId ?? Number(formId) } };
        added += db.prepare(`INSERT INTO submissions (submission_id, form_id, event_type, payload) VALUES (?,?,?,?)
                             ON CONFLICT(submission_id) DO NOTHING`).run(String(s.formSubmissionId), formId, "backfill", JSON.stringify(body)).changes;
      }
      if (list.length < 100) break;
    }
  }
  kick();
  return { ok: true, seen, queued: added };
}

export function automationStatus() {
  const cfg = env();
  const counts = Object.fromEntries(db.prepare("SELECT state, COUNT(*) n FROM submissions GROUP BY state").all().map(r => [r.state, r.n]));
  return {
    ok: true,
    mode: cfg.mode,
    configured: {
      CONNECTEAM_API_KEY: !!cfg.ctKey, CONNECTEAM_WEBHOOK_SECRET: !!cfg.ctSecret, SORTLY_KEY: !!cfg.sortlyKey,
      EOJ_FORM_ID: cfg.eojFormId || "(found by name)", TROUBLESHOOT_FORM_ID: cfg.tsFormId || "(found by name)",
      OTHER_INFO_FORM_ID: cfg.infoFormId || "(found by name)",
    },
    queue: counts,
    recent: db.prepare("SELECT submission_id, kind, state, detail, attempts, received_at, processed_at FROM submissions ORDER BY id DESC LIMIT 30").all(),
  };
}
