// Sortly stock levels — the Levels and Van stock tabs. Moved here from Code.gs so the board no longer
// needs Apps Script. Same rules, same answers; the engineer list now comes from the Engineers page.
//
//   levels()      warehouse folders vs LEVEL_RULES        (board: Levels tab)
//   vanLevels()   each engineer's van vs VAN_TYPES        (board: Van stock tab)
//   folders()     every Sortly folder path                (board: "Show Sortly folders")
//
// Both checks run every 30 minutes by themselves. Slack (SLACK_HOOK) gets one message when a line
// or a van first drops low — the same as the Apps Script did. Leave SLACK_HOOK blank for board only.

import { db, kvGet, kvSet } from "./db.js";
import { sortly } from "./automations.js";

/* ================= RULES (copied from Code.gs) ================= */
export const LEVEL_RULES = [
  // Ohme — consignment
  { group: "Consignment Ohme", label: "5m", folderId: "113452991", alertAt: 40 },
  { group: "Consignment Ohme", label: "8m", folderId: "113452998", alertAt: 40 },
  { group: "Consignment Ohme", label: "ePod", folderId: "113453002", alertAt: 40 },
  // Ohme — Plug In Stock
  { group: "Plug In Stock · Ohme", label: "5m", folderId: "113453010", alertAt: 40 },
  { group: "Plug In Stock · Ohme", label: "8m", folderId: "113453012", alertAt: 40 },
  { group: "Plug In Stock · Ohme", label: "ePod", folderId: "113453015", alertAt: 40 },
  // Ohme — service units: shown, no alert level yet
  { group: "Service unit · Ohme", label: "5m", folderId: "113453020" },
  { group: "Service unit · Ohme", label: "8m", folderId: "113453025" },
  { group: "Service unit · Ohme", label: "ePod", folderId: "113453027" },
  // Hypervolt — colour + length from each item's name.  SG = Space Grey (2), UB = Ultra Black (2), UW = Ultra White (1)
  { group: "Hypervolt", folderId: "113641304", split: "colourLength", colours: { black: 2, grey: 2, white: 1 } },
  // EVEC — each range is its own item name; alert at the last 3
  { group: "EVEC Untethered", folderId: "113516450", split: "name", alertAt: 3 },
  { group: "EVEC Tethered", folderId: "113516452", split: "name", alertAt: 3 },
];
export const VAN_TYPES = [
  { key: "ohme5", label: "Ohme 5m", min: 1 },
  { key: "ohme8", label: "Ohme 8m", min: 1 },
  { key: "epod", label: "Ohme ePod", min: 1 },
  { key: "hypervolt", label: "Hypervolt", min: 1 },
  { key: "evec", label: "EVEC", min: 1 },
];
const MAX_AGE_MIN = 35;          // the board re-uses the last check if it's newer than this
const EVERY_MIN = 30;

const canon = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const round = n => Math.round(n * 100) / 100;
const qtyOf = it => { const q = (it.quantity === null || it.quantity === undefined || it.quantity === "") ? 1 : Number(it.quantity); return isNaN(q) ? 0 : q; };

/* ================= Sortly reads ================= */
async function list(folderId, calls) {
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const r = await sortly("GET", `/items?per_page=100&page=${page}${folderId ? `&folder_id=${encodeURIComponent(folderId)}` : ""}`);
    calls.n++;
    const d = r?.data || [];
    out.push(...d);
    if (d.length < 100) break;
  }
  return out;
}
async function meta(id, calls) {
  try { calls.n++; const r = await sortly("GET", `/items/${encodeURIComponent(id)}`); return r?.data || r || {}; }
  catch (e) { if (/Sortly 404/.test(e.message)) return null; throw e; }
}
// every item in a folder and its sub-folders, with the sub-folder path it sits in
async function readFolder(id, calls) {
  const items = [], queue = [{ id: String(id), path: "" }];
  while (queue.length) {
    const f = queue.shift();
    for (const it of await list(f.id, calls)) {
      if (String(it.type || "").toLowerCase() === "folder") queue.push({ id: String(it.id), path: (f.path ? f.path + " / " : "") + String(it.name || "") });
      else items.push({ name: String(it.name || ""), qty: qtyOf(it), path: f.path });
    }
  }
  return items;
}

/* ================= Levels tab ================= */
function cleanItemName(name) {
  return String(name || "").replace(/\b(?:s\/?n|serial(?:\s*no)?)\b[:#\s]*\S+/ig, " ")
    .split(/\s+/).filter(t => (t.match(/\d/g) || []).length < 5)
    .join(" ").replace(/[\s\-–—,#]+$/, "").replace(/\s+/g, " ").trim();
}
function splitKey(rule, name) {
  const n = String(name || "");
  if (rule.split === "colourLength") {
    let colour = null;
    const code = n.match(/(?:^|[^a-z])(sg|ub|uw)(?![a-z])/i);
    if (code) colour = { sg: "grey", ub: "black", uw: "white" }[code[1].toLowerCase()];
    else { const w = n.match(/\b(black|grey|gray|white)\b/i); if (w) colour = w[1].toLowerCase() === "gray" ? "grey" : w[1].toLowerCase(); }
    if (!colour) return null;
    const at = rule.colours?.[colour];
    if (at === undefined) return null;
    const lm = n.match(/(\d+(?:[.,]\d+)?)\s*(?:m|mtr|metre|meter|metres|meters)(?![a-z])/i);
    const len = lm ? parseFloat(lm[1].replace(",", ".")) + "m" : "";
    const NAMES = { grey: "Space Grey", black: "Ultra Black", white: "Ultra White" };
    return { key: colour + "|" + len, label: NAMES[colour] + (len ? " " + len : " (no length in name)"), alertAt: at };
  }
  if (rule.split === "name") {
    const clean = cleanItemName(n);
    return clean ? { key: canon(clean), label: clean, alertAt: rule.alertAt } : null;
  }
  return null;
}

async function evalLevels() {
  const calls = { n: 0 }, byId = {}, rows = [];
  const seen = kvGet("LEVEL_SEEN", {});
  for (const rule of LEVEL_RULES) {
    const label = rule.label || rule.group;
    let f = byId[rule.folderId];
    if (!f) {
      const m = await meta(rule.folderId, calls);
      f = byId[rule.folderId] = m ? { name: String(m.name || `Folder ${rule.folderId}`), items: await readFolder(rule.folderId, calls) } : { missing: true };
    }
    if (f.missing) {
      rows.push({ group: rule.group, label, found: false, low: false, alertAt: rule.alertAt ?? null,
                  note: `Sortly has no folder with ID ${rule.folderId} — check the number in Sortly's web address` });
      continue;
    }
    const its = f.items.filter(it => {
      const n = it.name.toLowerCase();
      if (rule.nameHas && !n.includes(String(rule.nameHas).toLowerCase())) return false;
      if (rule.nameLacks && n.includes(String(rule.nameLacks).toLowerCase())) return false;
      return true;
    });
    const hasAlert = typeof rule.alertAt === "number";
    if (!rule.split) {
      const c = round(its.reduce((t, it) => t + it.qty, 0));
      rows.push(hasAlert
        ? { group: rule.group, label, count: c, alertAt: rule.alertAt, low: c <= rule.alertAt, found: true, path: f.name }
        : { group: rule.group, label, count: c, alertAt: null, low: false, found: true, path: f.name, info: true, note: `No alert level set — shown only · ${f.name}` });
      continue;
    }
    const groups = {}, otherNames = {}; let other = 0;
    for (const it of its) {
      const k = splitKey(rule, it.name);
      if (!k) { other += it.qty; otherNames[it.name] = 1; continue; }
      groups[k.key] = groups[k.key] || { label: k.label, alertAt: k.alertAt, count: 0 };
      groups[k.key].count += it.qty;
    }
    const sk = `f:${rule.folderId}:${rule.split}`;
    seen[sk] = seen[sk] || {};
    for (const [k, g] of Object.entries(groups)) seen[sk][k] = { label: g.label, alertAt: g.alertAt };
    const keys = Object.keys(seen[sk]).sort((a, b) => seen[sk][a].label.localeCompare(seen[sk][b].label));
    for (const k of keys) {
      const g = groups[k] || { label: seen[sk][k].label, alertAt: seen[sk][k].alertAt, count: 0 };
      const c = round(g.count);
      rows.push({ group: rule.group, label: g.label, count: c, alertAt: g.alertAt, low: c <= g.alertAt, found: true, path: f.name });
    }
    if (!keys.length && !other) rows.push({ group: rule.group, label: "Folder is empty", count: 0, alertAt: null, low: false, found: true, path: f.name, info: true, note: f.name });
    if (other) rows.push({ group: rule.group, label: "Names not recognised", count: round(other), alertAt: null, low: false, found: true, path: f.name, info: true,
      note: (rule.split === "colourLength" ? "No black / grey / white in the name: " : "No range name: ") + Object.keys(otherNames).slice(0, 4).join(", ") });
  }
  kvSet("LEVEL_SEEN", seen);
  return { ok: true, at: new Date().toISOString(), partial: false, calls: calls.n, rows };
}

/* ================= Van stock tab ================= */
// Which charger an item is, from its name and the sub-folder it sits in (null = not a charger).
export function vanClassify(name, path) {
  const n = String(name || ""), p = String(path || ""), t = p + " " + n;
  // faulty units going back to the warehouse — no minimum
  if (/no\s*answer\s*provided/i.test(n)) return "faulty";
  if (/(?:^|[^a-z0-9])uk\s*-?\d{4,}/i.test(n)) return "faulty";
  // renamed by the Troubleshoot automation: Ohme with no RMA, or a Hypervolt / EVEC coming back
  if (/\bno\s*rma\b|·\s*return\s*·/i.test(n)) return "faulty";
  if (/faulty|returns?\b|returning|\brma\b|defective/i.test(p)) return "faulty";
  if (/hyper\s*volt|(?:^|[^a-z0-9])hv\s*-?\d/i.test(t)) return "hypervolt";
  if (/evec/i.test(t)) return "evec";
  if (/e[\s-]?pod/i.test(t)) return "epod";
  if (/kopex|cable|t\s*&\s*e|trunking|tails|\bswa\b|cat\s*5|conduit|\bclips?\b|\bwire\b|\bflex\b/i.test(t)) return null;
  const len = t.match(/(?:^|[^\d.,])(5|8)\s*(?:m|mtr|metres?|meters?)(?![a-z])/i);
  if (len) return len[1] === "5" ? "ohme5" : "ohme8";
  if (/ohme/i.test(t)) return "ohme";
  return null;
}
const topVariants = map => Object.keys(map).sort((a, b) => map[b] - map[a]).slice(0, 4).map(k => k + (map[k] !== 1 ? " ×" + map[k] : ""));

async function evalVans() {
  const calls = { n: 0 }, cache = {}, out = [];
  const engineers = db.prepare("SELECT name, sortly_folder_id AS id FROM engineers WHERE active = 1 AND sortly_folder_id != '' ORDER BY name").all();
  const namesById = {};
  for (const e of engineers) (namesById[e.id] = namesById[e.id] || []).push(e.name);
  const prev = kvGet("VAN_LAST"), prevByName = {};
  for (const p of prev?.engineers || []) if (p.found && !p.stale) prevByName[p.name] = { e: p, at: prev.at }; else if (p.stale && p.found) prevByName[p.name] = { e: p, at: p.stale };

  for (const e of engineers) {
    const eng = { name: e.name, id: e.id, shared: namesById[e.id].filter(n => n !== e.name) };
    let f = cache[e.id];
    if (!f) {
      try {
        const m = await meta(e.id, calls);
        f = m ? { name: String(m.name || `Folder ${e.id}`), notFolder: m.type && String(m.type).toLowerCase() !== "folder", items: await readFolder(e.id, calls) } : { missing: true };
      } catch (err) {
        if (/refused the API key/.test(err.message)) throw err;
        f = { error: err.message };
      }
      cache[e.id] = f;
    }
    if (f.missing) { eng.found = false; eng.note = `Sortly has no folder with ID ${e.id} — check the number on the Engineers page`; out.push(eng); continue; }
    if (f.error) {
      const last = prevByName[e.name];
      if (last) { const keep = JSON.parse(JSON.stringify(last.e)); keep.stale = last.at; keep.staleWhy = f.error.slice(0, 160); keep.shared = eng.shared; out.push(keep); continue; }
      eng.found = false; eng.note = `Couldn't read this folder: ${f.error.slice(0, 160)} — it will try again on the next check.`; out.push(eng); continue;
    }
    eng.found = true; eng.folder = f.name;
    if (f.notFolder) eng.warn = `ID ${e.id} is an item in Sortly, not a folder`;
    const counts = {}, variants = {}, fNames = [], iNames = []; let fCount = 0, iCount = 0;
    for (const it of f.items) {
      const k = vanClassify(it.name, it.path);
      if (k === "faulty") { fCount += it.qty; if (fNames.length < 6) fNames.push(it.name); continue; }
      if (!k) { iCount += it.qty; if (iNames.length < 3 && !iNames.includes(it.name)) iNames.push(it.name); continue; }
      counts[k] = (counts[k] || 0) + it.qty;
      if (["hypervolt", "evec", "ohme"].includes(k)) {
        const v = cleanItemName(it.name) || it.name;
        variants[k] = variants[k] || {};
        variants[k][v] = (variants[k][v] || 0) + it.qty;
      }
    }
    eng.rows = VAN_TYPES.map(t => {
      const c = round(counts[t.key] || 0), r = { k: t.key, c, m: t.min };
      if (c < t.min) r.low = 1;
      if (variants[t.key]) r.v = topVariants(variants[t.key]);
      return r;
    });
    if (counts.ohme) eng.ohme = { c: round(counts.ohme), v: topVariants(variants.ohme) };
    eng.faulty = { c: round(fCount), n: fNames };
    eng.ignored = { c: round(iCount), n: iNames };
    out.push(eng);
  }
  return { ok: true, at: new Date().toISOString(), partial: false, calls: calls.n,
           types: VAN_TYPES.map(t => ({ key: t.key, label: t.label, min: t.min })), engineers: out };
}

/* ================= Slack for new lows ================= */
export async function slack(text, event, title) {
  const hook = process.env.SLACK_HOOK || "";
  if (!hook) return false;
  try {
    const res = await fetch(hook, /hooks\.slack\.com/i.test(hook)
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }
      : { method: "POST", body: new URLSearchParams({ event, to: process.env.NOTIFY_TO || "Andreas", title, message: text, text }) });
    return res.ok;
  } catch { return false; }
}
async function notifyLevelLows(res) {
  const prev = kvGet("LEVEL_LOWKEYS", {}), now = {}, fresh = [];
  for (const r of res.rows || []) {
    if (!r.found || !r.low || r.info) continue;
    const k = `${r.group}|${r.label}`; now[k] = 1;
    if (!prev[k]) fresh.push(r);
  }
  kvSet("LEVEL_LOWKEYS", now);
  if (fresh.length) await slack("📦 Low stock in Sortly:\n" + fresh.map(r => `• ${r.group} — ${r.label}: ${r.count} left (alert at ${r.alertAt})`).join("\n"), "lowstock", "Low stock");
}
async function notifyVanLows(res) {
  const stored = kvGet("VAN_LOWKEYS"), first = stored === null, prev = stored || {};
  const label = Object.fromEntries((res.types || []).map(t => [t.key, t.label]));
  const now = {}, fresh = {}, order = [];
  for (const e of res.engineers || []) {
    if (!e.found || e.stale) { for (const k of Object.keys(prev)) if (k.startsWith(e.name + "|")) now[k] = 1; continue; }
    for (const r of e.rows || []) {
      if (!r.low) continue;
      const k = `${e.name}|${r.k}`; now[k] = 1;
      if (prev[k]) continue;
      if (!fresh[e.name]) { fresh[e.name] = []; order.push(e.name); }
      fresh[e.name].push(`${label[r.k]} ${r.c} (min ${r.m})`);
    }
  }
  kvSet("VAN_LOWKEYS", now);
  if (!order.length || /^(0|no|false)$/i.test(process.env.VAN_SLACK || "")) return;
  await slack(first
    ? `🚐 Van stock checks are live — ${order.length} engineer${order.length > 1 ? "s are" : " is"} below minimum on chargers right now. See the Van stock tab. From now on Slack only hears when a van newly drops below a minimum.`
    : "🚐 Van stock below minimum:\n" + order.map(n => `• ${n} — ${fresh[n].join(", ")}`).join("\n"), "vanstock", "Van stock");
}

/* ================= what the server calls ================= */
let running = Promise.resolve();        // one Sortly check at a time, like the Apps Script lock
function serial(fn) { const p = running.then(fn, fn); running = p.catch(() => {}); return p; }
const noKey = { ok: false, error: "SORTLY_KEY is not set on the app" };

export function levels(fresh = false) {
  const last = kvGet("LEVELS_LAST");
  if (!fresh && last && Date.now() - Date.parse(last.at) < MAX_AGE_MIN * 60000) return Promise.resolve(last);
  if (!process.env.SORTLY_KEY) return Promise.resolve(last || noKey);
  return serial(async () => {
    const res = await evalLevels();
    kvSet("LEVELS_LAST", res);
    await notifyLevelLows(res);
    return res;
  }).catch(e => (last ? { ...last, error: e.message } : { ok: false, error: e.message }));
}
export function vanLevels(fresh = false) {
  const last = kvGet("VAN_LAST");
  if (!fresh && last && Date.now() - Date.parse(last.at) < MAX_AGE_MIN * 60000) return Promise.resolve(last);
  if (!process.env.SORTLY_KEY) return Promise.resolve(last || noKey);
  return serial(async () => {
    const res = await evalVans();
    kvSet("VAN_LAST", res);
    await notifyVanLows(res);
    return res;
  }).catch(e => (last ? { ...last, error: e.message } : { ok: false, error: e.message }));
}
export async function folders() {
  if (!process.env.SORTLY_KEY) return noKey;
  return serial(async () => {
    const calls = { n: 0 }, out = [], queue = [{ id: null, path: "" }];
    while (queue.length && out.length < 800) {
      const f = queue.shift();
      for (const it of await list(f.id, calls)) {
        if (String(it.type || "").toLowerCase() !== "folder") continue;
        const path = f.path ? `${f.path} / ${it.name}` : String(it.name || "");
        out.push(path); queue.push({ id: String(it.id), path });
      }
    }
    return { ok: true, partial: queue.length > 0, folders: out.sort() };
  }).catch(e => ({ ok: false, error: e.message }));
}

// every 30 minutes, like the Apps Script triggers
export function startLevelChecks() {
  if (!process.env.SORTLY_KEY) return;
  const tick = () => levels(true).then(() => vanLevels(true)).catch(() => {});
  setTimeout(tick, 20_000);
  setInterval(tick, EVERY_MIN * 60000);
}
