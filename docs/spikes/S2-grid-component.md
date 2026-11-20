# Spike S2: Grid component

Status: **done** (2026-11-19). Code: [`spikes/s2-grid`](../../spikes/s2-grid).

## Decision

**Glide Data Grid** (MIT). Univer can be made to work, but only by fighting it.

- Glide never owns data. It asks for each visible cell through a callback and reports edits as events. That is exactly the shape DESIGN §8 needs: our ops are the truth and the grid is a view.
- Univer is a whole spreadsheet application with its own workbook model, command system, undo stack, clipboard and formula engine. To keep our model in charge, the spike had to:
  - copy every cell into Univer's model (1.4 s for 100k rows),
  - cancel every edit, then close Univer's editor by hand,
  - capture copy, paste and undo before Univer sees them,
  - block Univer's own formula engine through internal mutation IDs, because it recalculated our formulas and overwrote our values with `#NAME?`.

  Several of those hooks are not public API. Univer 1.5.0, 1.5.1 and 1.5.2 shipped within two days of each other, so they would break often.
- Glide is 20 times smaller: 305 kB against 6.4 MB minified, before Univer's hyphenation dictionaries.

What Glide costs us is spreadsheet behaviour that Univer gives for free. That is mostly Phase 4 work, listed under [Risks and gaps](#risks-and-gaps).

## What was built

One page per grid, both driven by the same grid-independent layer:

- **`sheet-model.ts`.** The S1 engine plus a demo sheet: 100k rows of interleaved `Weapon` and `Projectile` rows, about 160k formulas, a computed ID, `ENTITY()` and `ENTITIES()`, and planted errors. On top of it:
  - an **op log**: every write names cells by stable row and column IDs, and undo and redo are ours;
  - stand-in validation: unknown type, missing or duplicate ID, `ROW()` in an ID (a warning), field type, and ref target.
- **`clipboard.ts`.** Our clipboard format, independent of either grid (DESIGN §6.6):
  - Copy writes TSV of the shown values, plus an HTML table whose formula cells carry relative R1C1 formulas in `data-sheets-formula`. Google Sheets reads that attribute, and so do we.
  - Paste reads HTML first, then TSV. It handles Sheets formulas, Excel's `x:num`, `colspan`/`rowspan` and `<br>`.
- **`overlay.ts`.** The reserved validation channel (DESIGN §6.7): an inset dashed outline, a corner flag, a one-time pulse, and the type gutter. It is a plain canvas function, so both grids draw it the same way.
- **`glide.html`** and **`univer.html`.** Each has a formula bar or uses its own, a sticky per-type header with a "pin to type" option, hover messages, undo and redo, and a scroll benchmark.

## Pass criteria

| Criterion | Glide | Univer |
|---|---|---|
| 100k rows scroll smoothly | **Yes.** 144 fps, p95 7.1 ms, worst frame 7.3 ms, scrolling top to bottom in 6 s | **Yes.** 140 fps, p95 7.1 ms, worst frame 62.5 ms |
| Custom overlay for validation (§6.7) | **Yes.** `drawCell` draws after the content | **Yes, with workarounds.** A `SheetExtension` works, but cell bounds must come from the skeleton's accumulators: `getCellWithMergeInfoByIndex` no longer returns pixel bounds, though its types say it does |
| Sticky header that changes per row type | **Yes.** Column titles are derived from the row under the cursor, and the header is tinted with the type color | **Yes.** `customizeColumnHeader` on selection change |
| Copy/paste with Sheets and Excel (HTML + TSV) | **Yes.** Checked with synthetic clipboard events (below), then by hand with the real apps | Same. Our clipboard layer is shared |
| Our ops are the truth | **Yes, natively** | **Only by blocking its formula engine, editor and clipboard** (see Decision) |

What the clipboard was checked against, through the real `copy` and `paste` DOM events in the browser:

- Copying F5:G6 gives TSV of the values and HTML with `=R[0]C[-3]/R[0]C[-2]`.
- Pasting that at H15 gives `=E15/F15`, applied as one op.
- A Sheets-shaped HTML payload maps `=R[0]C[-1]*2` to `=C5*2` and `SUM(R1C1:R[-1]C[-2])` to `SUM($A$1:C5)`, and handles a merged cell.
- An Excel-shaped payload maps `x:num="1234.5"` (shown as "1,234.50") to `1234.5`. Text that starts with `=` stays text, and `<br>` becomes a line break.

**Manual check: passed** (2026-11-19). Copying between `glide.html` and the real Sheets and Excel apps works in both directions. The payload wraps its table in Sheets' `<google-sheets-html-origin>` tag so that Sheets reads `data-sheets-formula`. Excel pastes values, which is all DESIGN §6.6 promises.

## Measurements

100k rows, 12 columns, in Chrome on the desktop app's built-in browser.

| | Glide | Univer |
|---|---:|---:|
| Engine load (ours, shared) | 3.4–4.2 s | 3.6–3.8 s |
| Copying cells into the grid's own model | none | 1.4 s |
| Grid load, then first paint | immediate | 15 ms, then 450–510 ms |
| Scroll benchmark (fps, p95, worst) | 144, 7.1 ms, 7.3 ms | 140, 7.1 ms, 62.5 ms |
| Our `cell()` reads while scrolling | 0.9 ms per frame | (same layer) |
| Production bundle (minified, gzipped) | 305 kB, 99 kB, plus React | 6.4 MB, 1.55 MB, plus hyphenation dictionaries |
| `node_modules` | 5.5 MB | 140 MB |

Take these frame timings only from a visible pane. Measured with the pane hidden, the same Glide page scored 6 fps because the browser throttles background pages. I nearly read that as a Glide problem.

## Findings for the engine (fixed here, in `spikes/s1-formula`)

S2 was the first time the engine ran on 100k realistic rows, and it found two engine problems and one gap.

1. **Wide readers loaded in quadratic time.** A formula like `SUM(ENTITIES("Weapon","dps"))`, written above its inputs, used to abort and retry once for every stale precedent. Loading took 1.3 s at 2k rows and 30 s at 8k.
   - **Fix:** evaluation now carries on past stale reads using placeholders, collects all of them, and retries once.
   - **Result:** 100k rows load in about 4 s.
   - A regression test counts evaluations. Cycle detection is unchanged.
2. **`ROW()` and `COLUMN()` were missing.** Both are added. Formulas that use them re-run after any row or column change on their sheet.
3. **`takeChanged()`** reports the cells written or recalculated since the last call, so a grid can repaint only those. The Univer page uses it.

Two are left for Phase 1:

- **Edits under a wide entity reader cost 150–420 ms.** An edit that no such reader depends on takes 0.1 ms. `SUM(ENTITIES("Weapon","dps"))` over 80k entities takes about 150 ms per evaluation, because it records 80k per-cell dependencies. It is also evaluated twice when breadth-first ordering visits it before a precedent. Phase 1 needs column-level dependencies for `ENTITIES(type, field)`, and a topological order instead of the retry.
- **Loading 100k rows from scratch takes about 4 s.** Phase 1 should load stored computed values and recalculate lazily, rather than evaluating everything when a sheet opens.

## Risks and gaps

**Glide maintenance.** The last stable release, 6.0.3, is from February 2024. React 19 support exists only in `6.0.4-alpha24` (October 2025), which the spike uses. `npm audit` flags a moderate build-time issue in its styling dependency (linaria, then minimatch). Mitigations:

- It's MIT and small, so forking or vendoring it is realistic.
- The spike already keeps the parts that matter in our own code: data, clipboard, undo, validation drawing, and the formula bar.

**Spreadsheet behaviour Glide doesn't provide.** This is Phase 4 work:

- Text doesn't overflow into empty neighbouring cells. Univer does this, and long comment rows need it.
- Pointing at cells while typing a formula, as in Excel. Needs our own formula editor.
- A fill handle that shifts formulas. Glide has `fillHandle`/`onFillPattern`; the shifting would use the engine's `copy`.
- Multi-range selection. Glide's `rangeStack` is a start.
- Number formats. Currently a raw `display()`, which shows `16.666666666666668`.
- Glide's overlay editor needs a `<div id="portal">` in the page. Without it, editing fails silently except for a console error.

**Univer would make sense** only if we wanted its whole application and gave up stable-ID ops. DESIGN §6 and §8 rule that out.

## Not covered

- Editing and paste performance at scale beyond the single-edit numbers above.
- Accessibility. Glide has an accessibility tree, but it wasn't checked.
- Mobile and touch.
