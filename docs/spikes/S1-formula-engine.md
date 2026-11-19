# Spike S1: Formula engine

Status: **done** (2026-11-18; formula-ID follow-up the same day). Code: [`spikes/s1-formula`](../../spikes/s1-formula).

## Decision

**Write our own engine in TypeScript.** Keep IronCalc as a dev-only *test oracle*: run the same formulas through both and diff the results, so we get Excel-compatible semantics without having to depend on IronCalc at runtime.

IronCalc is a good engine. It is fast at raw evaluation and has a far larger function library than we will have for a while. But it fails three of the pass criteria in ways that can't be patched from the outside:

- **No incremental recalculation.** Every edit re-evaluates the whole workbook. On the 30k-formula weapons workbook, a one-cell edit costs ~200 ms (native) or ~230 ms (WASM). Ours takes 4 ms.
- **No custom function hook.** `ENTITY()`, `REFS`, `ENTITIES`, singletons and pack reach would all need a fork of the Rust code.
- **Positional storage.** IronCalc rewrites formula text itself on row insert/delete (~800 ms per insert here). Our model stores formulas against stable row/column IDs. To use IronCalc we would have to mirror it as a positional grid and keep the two in sync, and we'd still need our own parser to check reach and render references.

## What was built

A TypeScript prototype of about 2,200 lines with no dependencies, plus 77 tests (66 for the base engine, 11 for formula IDs):

| File | Contents |
|---|---|
| `parse.ts` | Lexer and Pratt parser: Excel precedence (`-2^2 = 4`), A1 / `$A$1` / `A:A` / `3:5`, `Sheet!A1`, `'pack/Sheet'!A1`, error literals, `ENTITY("id").field`. A **rule mode** treats every identifier as a name, so `hp1` is a field, not a cell |
| `model.ts` | Packs, sheets, and row/column **axes of stable IDs with tombstones** |
| `bind.ts` | A1 ↔ stable IDs. `render` produces the A1 text shown for a stored formula; `shift` does copy/fill |
| `engine.ts` | Cells, dynamic dependency tracking, incremental recalc, entity index, pack reach, rule evaluation |
| `functions.ts` | 46 Excel functions plus `ENTITY`, `ENTITIES`, `REFS` |
| `bench.ts` | The same workbooks in our engine, IronCalc native and IronCalc WASM |

### How it works

- **Stable references.** A reference stores `(sheetId, rowId, colId)` plus `$` flags. Inserting, deleting or moving rows changes only the axis, never a stored formula. The A1 text is re-rendered on demand.
- **Tombstones.** A deleted row ID stays in the axis, marked dead:
  - A single-cell reference to it shows and evaluates as `#REF!`.
  - A range whose corner was deleted still covers the same stretch of rows.
  - Restoring the row brings every formula back as it was. That is exactly what reverting a delete needs.
- **Dynamic dependencies.** Dependencies are recorded *while* a formula evaluates, so `ENTITY("x")`, `INDEX` and anything else that picks its target at run time is tracked exactly.
- **Non-recursive recalc.** Stale cells are processed from a stack.
  - If a formula reads a precedent that is still stale, it aborts, the precedent is pushed, and the formula retries afterwards.
  - If it reads a precedent that is itself waiting further down the stack, that's a cycle (`#CYCLE!`).
  - A 20k-deep chain built in reverse order recalculates without deep recursion. Normal edits need no retries, because the change is propagated breadth-first.
- **Range watchers** are indexed per sheet and column. Within one recalc, a range read is cached and shared across formulas until a cell on that sheet changes. This is what makes 10k `VLOOKUP`s into one table cheap.
- **Entity index** (a simplified version of DESIGN §6.2): column A is the type (`#Type` rows are inactive), column B the ID.
  - Layouts map fields to column IDs, so `ENTITY("Blaster").cooldown` survives row and column moves.
  - Edits to A/B update the index incrementally, row by row. Structural changes rebuild it.
- **Pack reach** is checked on entry, giving a clear error when you type the formula, and again on every evaluation. Moving a sheet to another pack therefore turns existing out-of-reach formulas into `#REACH!`. `ENTITY()` and `ENTITIES()` obey the same rule in cells. Validation rules see everything.
- **Errors carry details,** e.g. `#REF!: No entity "blaster" (did you mean "Blaster"?)`, ready for the validation UI.

## Pass criteria

| Criterion | Result |
|---|---|
| Stable row/column IDs, rendered as A1; structure ops never rewrite formula text | **Pass.** Tested for insert, delete, restore, move, column insert/delete, and range corners |
| Cross-sheet references, ranges, incremental recalc over a dependency graph | **Pass** |
| Extensible with `ENTITY()` and rule functions; enforces pack reachability | **Pass.** `ENTITY("id").field`, `ENTITIES(type[, field])`, `REFS(field, "other")`, rule-mode names, `#REACH!` |
| Runs identically in Node and the browser | **Pass.** The compiled output, run in a browser, produced the same values as Node (`Summary!A1 = 3264760.45714286`) |
| ~10k formula cells recalculate after one edit in < 50 ms | **Pass.** 10k-cell fan-out: 13 ms. Weapons, 10k recomputed cells: 21–26 ms (Node), 16–18 ms (browser) |
| Honest cost estimate for the top ~100 functions | See below |

## Benchmarks

Each edit time is the median of 9 runs and includes everything needed to make all values correct. `N = 10,000` rows. All three engines produced identical values in every scenario.

| Scenario | Ours (TS) | IronCalc native | IronCalc WASM |
|---|---:|---:|---:|
| chain (10k deep): load | 78 | 48 | 180 |
| chain: edit head (10k recompute) | 10 | 2.0 | 5.6 |
| fan (10k read one cell): load | 94 | 75 | 117 |
| fan: edit shared input (10k recompute) | 13 | 2.8 | 7.3 |
| fan: edit one leaf input (1 recompute) | <0.01 | 2.8 | 5.2 |
| weapons (30k formulas, VLOOKUPs, whole-column SUM/MAX/COUNTIF): load | 387 | 545 | 728 |
| weapons: edit global multiplier (10k recompute) | 21 | 200 | 230 |
| weapons: edit one damage cell (~6 recompute) | 4.0 | 199 | 230 |
| weapons: edit lookup table (10k VLOOKUPs + COUNTIF) | 26 | 198 | 235 |
| weapons: insert row at top | 26 | 780 | 937 |

Entity scenarios (ours only; IronCalc can't express them), on top of the weapons workbook with 10k `=ENTITY("wN").damage*2` cells:

| Scenario | ms |
|---|---:|
| edit one damage cell | 4.5 |
| move 100 entity rows | 29 |
| rename one ID | <0.1 |
| change the layout (re-resolves all 10k) | 64 |

**Reading the numbers:**

- IronCalc evaluates a simple formula about 4× faster than we do. That is visible when everything really does need recomputing (chain, fan).
- In a realistic workbook, most edits touch a few cells, and IronCalc pays for the whole workbook every time.
- Our evaluator is a plain AST walker with string-keyed maps. There is easy headroom: integer cell keys, compiled closures instead of AST walking, fewer allocations per evaluation.

**At 100k rows** (10× our realistic upper bound; ours only):

| Scenario | ms |
|---|---:|
| one damage cell | 65 |
| 100k-cell recompute | 200–330 |
| insert a row | 400 |
| load (300k formulas) | 4.7 s |

Fine for an upper bound, but it says where to optimise: whole-column aggregates and full entity-index rebuilds on structure changes.

## Function library: cost estimate

Implemented in the spike, with tests:

- **Aggregates:** SUM, PRODUCT, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTBLANK, COUNTIF, SUMIF.
- **Math:** ABS, SQRT, INT, EXP, LN, ROUND, ROUNDUP, ROUNDDOWN, MOD, POWER.
- **Logic:** IF, IFS, IFERROR, IFNA, AND, OR, NOT.
- **Info:** ISBLANK, ISERROR, ISNUMBER, ISTEXT.
- **Text:** CONCAT, CONCATENATE, LEN, UPPER, LOWER, TRIM, LEFT, RIGHT, MID.
- **Lookup:** ROWS, COLUMNS, INDEX, MATCH, VLOOKUP, XLOOKUP.

Writing them took a few hours. The framework (lazy arguments, Excel coercion, reference-vs-literal aggregate rules, error propagation) is the part that was hard to get right, and it is done.

Remaining work to reach a solid top ~100:

| Group | Examples | Estimate |
|---|---|---|
| Simple math, info and logic | SIGN, TRUNC, CEILING, FLOOR, LOG, PI, SUMPRODUCT, CHOOSE, SWITCH, XOR, ISNA, NA, TYPE, HLOOKUP | 2–3 days |
| Multi-criteria and wildcards | SUMIFS, COUNTIFS, AVERAGEIF(S), MAXIFS, MINIFS; `*`/`?` in criteria and MATCH | 2 days |
| Text | SUBSTITUTE, FIND, SEARCH, REPLACE, REPT, TEXTJOIN, VALUE, EXACT | 1–2 days |
| Dates and durations | DATE, TIME, YEAR…SECOND, EDATE, EOMONTH, DATEDIF, WEEKDAY; tied to our UTC datetime/duration types | 3 days |
| `TEXT()` and number formats | format-string parser and renderer, also needed for cell display | 3–5 days |
| `LET` | | 1 day |
| **Subtotal** | | **~3 weeks** |
| Dynamic arrays (`FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`) | needs spill semantics in the grid: anchor and child cells, `#SPILL!` | +1.5–2 weeks, can come later |

Differential tests against IronCalc should cut the edge-case hunting in each group substantially.

## Findings to carry into Phase 1 and the design

1. **Exclude volatile functions** (`TODAY`, `NOW`, `RAND`, `RANDBETWEEN`, `OFFSET`/`INDIRECT` as volatile). Exports must be deterministic: the same commit always produces the same bytes. `INDIRECT` could come back later as a non-volatile, reach-checked function.
2. **Column A stays literal; column B may be a formula.** The first write-up proposed banning both. Formula IDs turned out to be cheap to support (see [Formula IDs](#follow-up-formula-ids) below).
3. **Tombstones accumulate.** Snapshots can compact row IDs that no stored formula, op or blame entry still references. Not urgent at our scale.
4. **Entity-index rebuilds on structure changes** are O(entities). Make row insert/delete/move incremental, as cell edits already are.
5. **Rule function set**, proposed for DESIGN §5.7:
   - Field names as variables in per-entity rules.
   - `REFS(field, "other")` follows `ref` and `list<ref>` fields.
   - `ENTITIES(type)` returns the IDs; `ENTITIES(type, field)` returns that field's values.
   - `ENTITY(id).field` for fields, and `.id` for the entity's ID.
   - Singletons use the same mechanism: `SINGLETON("T").field`.
6. **`ENTITY("id").field` syntax is confirmed** (DESIGN §6.5). It parses as a postfix field access on any expression, so `ENTITY(B2).damage` works too.
7. **Sheet names render bare when unambiguous and qualified when shadowed.** For example, a formula in `weapons` pointing at `root/Tuning` shows `'root/Tuning'!A1` when `weapons` has its own `Tuning`.
8. **Cells are scalar.** Array results take the top-left value until spill is implemented (see above).

## Follow-up: formula IDs

Computed IDs (`=Tuning!$A$1&K2`, `="sword_"&C2`) are likely to be common, so the spike was extended to support them. Code: `engine.ts`; tests: `formula-ids.test.ts` (11 tests).

**How it works:**

- **Sheet kinds** (DESIGN §6.1). Only data sheets have bound rows, so the column rules apply only there.
- **Column A stays literal.** A formula there is `#VALUE!` and the row is not an entity.
- **Column B may be a formula.** When an ID cell finishes calculating, its row of the index is updated, and formulas that look up the old or new ID (or use `ENTITIES` of its type) are marked stale.
  - Those readers are **deferred** until the current work is done. One prefix edit that renames 10k entities therefore recomputes each reader once, not once per rename.
  - An ID that has not been calculated yet keeps its previous index entry until it is.
- **An ID may not depend on the entity index.** Every value carries a "depends on the index" flag. It is set by `ENTITY()` and `ENTITIES()`, and passed along through cell reads and range reads (including cached ranges). An ID cell with the flag set is `#CYCLE!`, with an explanation.
  - This rules out every cycle through the index, including the oscillating one: `=IF(ISERROR(ENTITY("x")), "x", "y")` would otherwise flip between two values forever.
  - It also guarantees that IDs never need a second pass.
  - Scratch rows on data sheets are not affected.
- **Rename detection.**
  - `entityIds()` takes a per-row snapshot, and `Engine.idChanges(before, after)` lists `{row, from, to}`.
  - `rewriteEntityRefs(from, to)` points `ENTITY("from")` literals at the new ID. That is the core of the "update references" offer at land time. Ref-typed fields join it in Phase 1, once the schema says which columns hold refs.

**Benchmarks** (10k weapons with computed IDs, plus 10k `ENTITY()` readers and an `ENTITIES` reader):

| Scenario | Literal IDs | Formula IDs |
|---|---:|---:|
| load | 554 ms | 590 ms |
| edit one damage cell | 4.5 ms | 6.3 ms |
| rename one entity | <0.1 ms | 3.5 ms |
| rename all 10k (one prefix edit; 20k evaluations) | n/a | 86 ms |
| move 100 rows | 29 ms | 34 ms |

- Renaming one entity costs 3.5 ms because the `ENTITIES` reader recomputes and re-sorts the type list. Phase 1 can update the list in place.
- Renaming all 10k at once exceeds the 50 ms target, but it is the equivalent of 10k separate renames.

**Nothing untoward came up.** The remaining work is in the design (DESIGN §6.5 and §8.4): an ID formula using `ROW()` or `COLUMN()` gets a validation warning, and landing offers to update references after a computed rename.

## Not covered

Named ranges, the date serial system, number formatting for display, and memory measurements. None of them changes the decision.
