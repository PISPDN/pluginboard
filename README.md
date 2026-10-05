# Plug In Dashboard — the app

Zapier posts straight in here and the app stores the data itself. No Google Sheet, no Apps Script.
Zapier keeps doing everything it does today; only the last step of each Zap changes.

```
Before   Connecteam → Zapier → Google Sheet → Apps Script → index.html on GitHub Pages
Now      Connecteam → Zapier → this app (endpoint + storage + screens)
```

## What's in here

| File | What it is |
|---|---|
| `server.js` | The whole app — the endpoints Zapier posts to, the API the board uses, the login, and it serves the board |
| `db.js` | The database: tables, and the tidying that happens to data on the way in |
| `automations.js` | The Connecteam workflows: End of Job Report deductions, Troubleshoot renames, Any Other Info flags |
| `engineers.html` | The Engineers page (`/engineers`) — tick who's on monthly deliveries |
| `levels.js` | The Levels and Van stock checks (Sortly every 30 minutes, Slack on a new low) — moved here from Code.gs |
| `connecteam-setup.js` | Only useful if you ever get Connecteam API access — not needed now |
| `index.html` | The board — build `2026-10-05a`, the current board (Orders, Levels, Van stock, Troubleshoots) plus an **Other info** tab and an **Engineers** link. Talks only to this app |
| `render.yaml` | Render blueprint — instance size, disk, and which settings are secrets |
| `.env.example` | The settings you need to fill in |

No npm packages. Node 22.5 or newer (it uses Node's built-in SQLite). The database is one file — `data/board.db` — so a backup is a file copy. `server.js` serves only `index.html`; nothing else in the folder is reachable over the web.

## Running it

```bash
cp .env.example .env        # then fill in the three secrets
node --env-file=.env server.js
```

Open http://localhost:8080 and sign in. For local testing set `INSECURE_COOKIE=1`, or the browser
will refuse the login cookie over plain http.

Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

| Setting | What it's for |
|---|---|
| `INGEST_KEY` | The secret your Zaps send in the `X-Api-Key` header. Long and random. |
| `APP_PASSWORD` | What the three of you type to sign in. |
| `APP_SECRET` | Signs the login cookie. Changing it signs everyone out. |
| `PEOPLE` | Who appears in the sign-in list and the "assign to" lists. |
| `DB_FILE` | Where the database file lives. Default `./data/board.db`. |

## Putting it online

It's a plain Node app, so anywhere that runs Node will do — Fly.io, Railway and Render all work
and all have a free or near-free tier at this size. Two things to get right:

1. **Give it a disk.** The database is a file. Render's free plan has no disks and wipes the
   filesystem on every restart, so use the Starter plan with a 1 GB disk and point `DB_FILE`
   at it. `render.yaml` already does this.
2. **Set the three secrets** (`INGEST_KEY`, `APP_PASSWORD`, `APP_SECRET`) in the Render
   dashboard. They are deliberately not in `render.yaml`.

Once it has a URL, that URL is what goes in your Zaps and what you open on your laptops.

## Changing the Zaps

For each Zap, the last step changes from **Google Sheets → Create Spreadsheet Row** to
**Webhooks by Zapier → POST**. Everything before that step stays exactly as it is.

Set up the POST step like this:

- **URL** — `https://your-app-url/ingest/job` (see the table below for which)
- **Payload Type** — `json`
- **Data** — the fields below, mapped from the same Zap steps you're already mapping from
- **Headers** — `X-Api-Key` : your `INGEST_KEY`

| Which Zap | URL | Required |
|---|---|---|
| Connecteam shift created **and** shift updated — both point here | `/ingest/job` | `shift_id` |
| A Zap failed | `/ingest/error` | — |
| Possible use of our stock | `/ingest/stock-alert` | — |
| End-of-day deduction run | `/ingest/run` | — |

### `/ingest/job`
`shift_id` (required — Connecteam's own id), `engineer`, `job_title`, `start`, `end`, `location`, `notes`.

Both the "new shift" and "updated shift" Zaps point at this one URL. The app matches on `shift_id`
and updates, so an edited shift changes the existing card instead of adding a second one.

### `/ingest/error`
`zap`, `step`, `message`, `serial`, `job`, `customer`, `address`, `engineer`, `image_url`, `when`.
Keep the WhatsApp step in that Zap as it is.

### `/ingest/stock-alert`
`engineer`, `serial`, `item`, `qty`, `job`, `message`, `image_url`, `when`.

### `/ingest/run`
`run_id`, `engineer`, `serial`, `cu`, `cable_m`, `job`, `charger_found`, `charger_removed`,
`cu_adjust`, `cable_adjust`, `sortly_removed`, `sortly_cu_updated`, `sortly_cable_updated`,
`error`, `when`.

One row per run, replacing the Automation Log, Sortly Log and Quantities Log. The Zap can post
once at the end with everything, or post twice with the same `run_id` — the second call fills in
what it learned rather than creating a second row.

**Anything extra you send is kept**, so if a Zap maps a field this list doesn't mention, it still
turns up on the card. Nothing is silently dropped.

### What you get back

Zapier shows the step as failed if the app rejects it, with the reason — e.g.
`{"ok":false,"error":"shift_id is required"}`. That's the point: a bad send is visible in Zapier's
own history instead of quietly producing a row nobody notices.

## Connecteam workflows — Zapier only forwards

There is no Connecteam API on this account, so Connecteam's Zapier trigger is the only way a submission
gets out. Each workflow keeps **one two-step Zap** that does nothing but forward it; the app does all the
work (Sortly, renames, flags). No Paths, no lookup sheet, no code steps, no Sortly calls in Zapier.

| Zap | Step 1 | Step 2 |
|---|---|---|
| End of Job | Connecteam → New Form Submission → *End of Job Report v2.0* | Webhooks by Zapier → POST `https://<app>/ingest/form/eoj` |
| Troubleshoot | Connecteam → New Form Submission → *Troubleshoot* | Webhooks by Zapier → POST `https://<app>/ingest/form/troubleshoot` |
| Any Other Info | Connecteam → New Form Submission → *Any Other Info* | Webhooks by Zapier → POST `https://<app>/ingest/form/other-info` |

In each POST step: **Payload Type** `json`, **Data Pass-Through** *True* (sends every answer, named by
its question), **Headers** `X-Api-Key` = your `INGEST_KEY`. Nothing to map by hand. The app answers with
the engineer it found, so the Zap's test shows straight away whether it worked. The same submission sent
twice is only done once.

### End of Job Report v2.0 → charger, EV Ultra, CU

| Step | What happens |
|---|---|
| Engineer | Connecteam user → engineer on the **Engineers** page → their Sortly folder. Not there → stock alert, nothing changed |
| Read the van | Every item in the folder and its sub-folders, every page |
| **Charger** | Serial on the form matched to the serial on a charger in the folder (case, spaces, dashes ignored). One match → removed from Sortly. No match → stock alert *"POSSIBLE USAGE OF OUR STOCK…"* for you to remove by hand. Two matches → nothing removed, flagged. Name contains "Plug In Stock" → removed **and** a stock alert |
| Monthly? | CU and EV Ultra only for engineers ticked **Monthly deliveries** on the Engineers page. Everyone else: skipped |
| **EV Ultra** | Item named "EV Ultra" in the van, minus the metres used. Fresh count read first, never below 0, warning over 60 m |
| **CU** | Answer says "IP Rated" → 1 off the IP65 CU in that van. Says "Metal" → 1 off the metal CU. Neither (main / garage consumer unit) → skipped |
| Record | One row on the **Flow** tab |

### Troubleshoot → rename the new charger

| Step | What happens |
|---|---|
| Read | **New** Charger Serial Number, RMA Number From Ohme, Key Account, customer name and address, fault, photo. The old serial is ignored |
| Find | The new serial in that engineer's Sortly folder. No match → flagged on the board, nothing renamed |
| **Ohme** with RMA | Renamed to the RMA, e.g. `UK2875387`. "2875387" or "uk 2875387" both become `UK2875387` |
| **Ohme**, no RMA | Renamed `NO RMA · <charger> · <customer address> · <engineer> · <date>` and flagged |
| **Hypervolt / EVEC** | Renamed `<charger> · RETURN · <customer address> · <engineer> · <date>` — to come back to the warehouse for the manufacturer |
| Record | One card per troubleshoot (`troubleshoots` in `/api/data`) |

Ohme vs not is decided by Key Account; if that's blank, by the charger's Sortly name.

### Any Other Info → flag

Who sent it, when, and every answer with its photos, as a card on the board (`otherinfo` in
`/api/data`). Nothing else happens.

### Shared rules

- **Nothing is done twice.** Each submission is queued once, however many times Connecteam sends it,
  and each step remembers it's done — a re-run only redoes what failed. A step interrupted halfway
  through changing Sortly is marked *check* instead of repeated.
- **Shadow mode** (`AUTOMATION_MODE=shadow`, the default) works everything out and shows what it
  *would* have done (`would_do`), without changing Sortly. `live` does it for real.
- The names, the CU rule, the Ohme rule and the RMA format are in `RULES` at the top of `automations.js`.

### Settings

| Setting | |
|---|---|
| `SLACK_HOOK` | A **Slack Incoming Webhook** (hooks.slack.com/…). Used only for low stock, vans below minimum and task notifications — never for the workflows. Make a new one in Slack rather than reusing the Zapier catch hook, or Zapier is still in the loop |
| `AUTOMATION_MODE` | `shadow` (default) or `live` |
| `INGEST_KEY` | Long random string — the forwarding Zaps send it as `X-Api-Key` |
| `CONNECTEAM_API_KEY`, `CONNECTEAM_WEBHOOK_SECRET` | Leave blank — only for Connecteam API access, which this account doesn't have |
| `SORTLY_KEY` | **Rotate it first** — the current one has been sitting in plain text in the Zap headers |
| `EOJ_FORM_ID`, `TROUBLESHOOT_FORM_ID`, `OTHER_INFO_FORM_ID` | Optional. Blank = found by form name |

### Going live — in this order

1. Deploy with `AUTOMATION_MODE=shadow`.
2. Make the three forwarding Zaps above (keep the old Zaps on for now).
4. Open **/engineers** — tick everyone on monthly deliveries, check every engineer has a Sortly folder.
5. Compare with the old Zaps for a week — every job shows on the Flow tab twice, Zapier's and the app's.
7. Turn the **deduction Zaps and the Troubleshoot Zap off**, then set `AUTOMATION_MODE=live` and restart.
8. Re-run anything that arrived in between (`POST /api/automation/rerun {"run_id":"ct_…"}`).

Rollback: `AUTOMATION_MODE=shadow`, Zaps back on.

### Endpoints

| | |
|---|---|
| `POST /ingest/form/eoj` · `/troubleshoot` · `/other-info` | The forwarding Zaps (X-Api-Key) |
| `POST /hooks/connecteam` | Connecteam's own webhook — only if you ever get API access |
| `GET /api/automation` | Mode, settings, queue, last 30 submissions |
| `POST /api/automation/rerun` | `{"run_id":"ct_…"}` or a troubleshoot's submission id. `"redo":true` redoes a step marked *check* |
| `GET/POST /api/engineers` | The engineer list; `/engineers` is the page for it |

## Switching over safely (the board itself)

1. Deploy the app. Nothing is pointed at it yet.
2. In **one** Zap, add the POST step **alongside** the existing Google Sheets step. Both run.
3. Compare for a few days — the sheet and the app should agree.
4. Open the app's URL and work from it instead of GitHub Pages.
5. Move the remaining Zaps the same way, one at a time.
6. Delete the Sheets step from each Zap once it's matched for a week.
7. Keep the sheet read-only as an archive.

There is no point where both the old and new paths are off.

## The board

The same board as GitHub Pages (build `2026-10-02c`), now served by the app. It still makes the calls it
made to Apps Script — the app answers them at `/api/legacy` — so every screen works as before. Underneath:

- **Sign in** with your name and the shared password (30 days). No passcode, no config.js, no `/exec` URL.
- **Levels and Van stock** are read by the app (`levels.js`) every 30 minutes. Van stock uses the
  Engineers page for each engineer's folder. Chargers renamed `NO RMA · …` or `… · RETURN · …` count as faulty.
- **Troubleshoots** shows every Troubleshoot, Ohme included: the RMA, what the charger was renamed to,
  and anything to check in red.
- **Other info** — every Any Other Info submission until you mark it Seen; also on the bell.
- **Flow** — app runs say *App* (or *App (shadow)*), show what they would do, and have **Re-run**.
- **Task notifications** go to the app's `SLACK_HOOK`, not a Zapier catch hook.

## What changed in the board (16 Sep)

Same screens, same cards, same filters. Underneath:

- **Every row has a real id.** Statuses, notes and deletes are applied by id, so a second laptop
  acting at the same moment can't land on the wrong row.
- **Writes report failure.** If a save doesn't work you're told, instead of it looking fine and
  reverting a minute later.
- **A real login**, and the API refuses everything without it. The old passcode only hid the
  screen — the data behind it was readable by anyone with the URL.
- **Serials are cleaned on the way in.** A serial with an image URL stuck on the end matches its
  run properly instead of silently failing to.
- **Ticking a stock alert off marks the run's charger removed** — worked out by the app, so every
  laptop agrees rather than each deciding for itself.
- **Invoices and tasks are shared**, not stuck in each laptop's browser storage where they
  silently stop saving once it fills up.
- **"You are" comes from the login**, so updates are attributed automatically.

## Not done yet

- **Orders are still per laptop.** The Orders tab keeps its order book in the browser, exactly as on the
  old board — use Export / Import to move it. Moving it into the app's database is the next piece.
- **Edited submissions are ignored.** If an engineer edits an End of Job Report after sending it,
  nothing is re-deducted — fix Sortly by hand.

- **Invoice attachments** still go in the browser. The table for them exists; the upload endpoint
  doesn't. Until that's finished, a PDF attached on one laptop isn't visible on another.
- **Google Workspace sign-in.** Today it's one shared password plus your name. Swapping in SSO is
  a contained change to `/auth/*`.
- **Live updates.** Still polling on the same timer as before. The app could push instead.
