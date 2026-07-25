# QC Management System — Deployment Guide

A Google Apps Script project bound to your `QC_Audit_Tracker` Google Sheet.
10 files: `appsscript.json`, `Code.gs`, `Utils.gs`, `Entry.gs`, `Analytics.gs`,
`Style.html`, `JavaScript.html`, `Sidebar.html`, `Form.html`, `Dashboard.html`.

> **Naming note:** Apps Script requires every file name in a project to be
> unique *regardless of type* — a script file and an HTML file can't both
> be called `Form`, for example. So the server-side logic for the entry
> form and the dashboard live in `Entry.gs` and `Analytics.gs` (the actual
> `Form.html` / `Dashboard.html` pages they serve keep their natural
> names). This doesn't change any behavior — Apps Script functions are
> global across the whole project no matter which `.gs` file they're
> defined in.

## What this build assumes

- **One row = one inspection** (one Style, checked by one QI, during one
  hour). If an inspection turns up several defect types, `Defect Name` /
  `Defect Qty` capture one representative defect per row — this was your
  choice over the alternative (one row per defect type).
- Your existing sheet already had `Hour`, `Difference(QC-Prod)`,
  `Pass+Defective`, `Balance Qty`, `DHU %`, `Status` — the **Setup** step
  below re-maps your current headers (however named/ordered) onto the
  canonical 22-column layout automatically, adding the missing `Defect
  Qty` column (defaulted to `Defective Qty` for old rows) and moving
  `Remarks` to its correct position. No data is deleted.
- False-reporting thresholds (max realistic checked qty/hour per QI = 400,
  high-DHU alert = 10%) live at the top of `Utils.gs` — change them there.

## 1. Open the Apps Script editor

1. Open your `QC_Audit_Tracker` Google Sheet in a browser.
2. **Extensions → Apps Script**. This opens a new project bound to that sheet.
3. Delete the default empty `Code.gs` content — you'll paste the real one below.

## 2. Create the files

In the Apps Script editor's left sidebar, click **+ → Script** for each `.gs`
file and **+ → HTML** for each `.html` file, name it exactly as below
(no extension needed when naming — Apps Script adds it), then paste the
matching content from this package:

| File to create | Type |
|---|---|
| `Code` | Script |
| `Utils` | Script |
| `Entry` | Script |
| `Analytics` | Script |
| `Style` | HTML |
| `JavaScript` | HTML |
| `Sidebar` | HTML |
| `Form` | HTML |
| `Dashboard` | HTML |

Also open **Project Settings (⚙️) → "Show appsscript.json manifest file in
editor"**, then replace its content with `appsscript.json` from this package.

Save all files (Ctrl/Cmd+S).

## 3. Run Setup once

1. Close and reopen the Google Sheet (so the custom menu appears), or in the
   Apps Script editor toolbar pick the `runInitialSetup` function and click
   **Run**.
2. The first run will ask for authorization — click through **Review
   permissions → (your account) → Advanced → Go to project (unsafe) →
   Allow**. This warning is normal for your own private scripts.
3. You should see "Setup complete" — this has:
   - Re-mapped `Raw Data` into the canonical 22-column layout.
   - Created a `Master Lists` sheet (Lines, Buyers, QI Names, Defect Names,
     Hour Slots) seeded from whatever is already in `Raw Data`, plus a
     default set of hourly slots (08:00–09:00 … 20:00–21:00) — edit that
     sheet any time to add/remove dropdown options.
   - Recalculated every row's Difference, Pass+Defective, Balance, DHU%,
     and Status, and highlighted flagged rows in red.

## 4. Daily use

Reload the sheet — a **QC Management System** menu appears next to Help:

- **📝 Open Data Entry Form** — the entry form, opens as a dialog inside
  Sheets. Dropdowns for Line/QI/Buyer/Defect/Hour; Style is type-ahead
  (filtered to the selected Buyer's known styles, but accepts new styles
  freely). Saves straight to `Raw Data` — no manual editing needed.
- **📊 Open Dashboard** — KPIs, Style/Buyer/QI/Hourly/Line summaries,
  charts, filters, and the False Reporting tab.
- **🧭 Open Launcher Sidebar** — a compact panel with the same actions,
  useful if you want the form/dashboard buttons always visible on the side.
- **🧮 Recalculate All Records** — full re-run of the status engine. Use
  after any bulk paste/import, or periodically on a very large sheet (see
  note below).
- **🔄 Rebuild Master Lists from Raw Data** — wipes and rebuilds the
  dropdown lists purely from what's currently in `Raw Data`.

New entries also auto-recalculate: a single-cell edit made directly in
`Raw Data` re-triggers the status engine automatically too.

## 5. (Optional) Deploy as a Web App

If you want a shareable link instead of / in addition to the in-Sheets
dialogs:

1. **Deploy → New deployment → type: Web app**.
2. Execute as **Me**, Access **Anyone with a Google account** (edit
   `appsscript.json`'s `access` field first if you want a different
   audience — `MYSELF`, `DOMAIN`, or `ANYONE`).
3. Deploy, copy the `.../exec` URL.
   - `.../exec` opens the **Dashboard**.
   - `.../exec?page=form` opens the **entry Form**.

## Performance note for very large sheets (50,000+ rows)

Every submission re-validates the new row against your **entire** dataset
(duplicates, time conflicts, hourly limits) — that read is always full and
accurate. Below 5,000 rows, the write-back is also full-sheet, so every
sibling row's flag updates instantly. Above 5,000 rows, only the new row
itself is written immediately (for speed); older rows that might be
indirectly affected (e.g. a new entry pushes a QI's hourly total over the
limit) get reconciled the next time **Recalculate All Records** runs — run
it at the end of each shift on very large sheets. This threshold is
`CONFIG.AUTO_FULL_RECALC_ROW_LIMIT` in `Utils.gs`.

## Where each requirement lives

- **False reporting rules** → `evaluateAllRows_()` in `Utils.gs`, fully
  commented with the rule → status mapping and priority order.
- **Top 10 Defects / Top Styles·Buyers·QIs by DHU / False Reporting** →
  `Analytics.gs` (`getTopDefects`, `getTopStylesByDhu`, `getTopBuyersByDhu`,
  `getTopQIsByChecked`, `getTopQIsByDhu`, `getTopQIsByFalseReporting`).
  The Style/Buyer/QI Performance tables in the dashboard are also
  click-to-sort on every column, so you can get any "top N by X" view
  interactively without a dedicated chart for each one.
- **Charts** (Line, Column, Pie, Stacked Bar, Area) → `Dashboard.html`,
  via Google Charts, redrawn on every filter change.
