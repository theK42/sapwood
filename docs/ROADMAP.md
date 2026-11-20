# Sapwood — Roadmap

Companion to [DESIGN.md](DESIGN.md). Phases are ordered by dependency and risk. Each phase ends in something usable or testable on its own.

**Guiding principle:** build the headless core first. Schema, ops, validation and export are fully testable without a UI, and are immediately useful through the CLI and LLMs. The spreadsheet UI comes after the model has been proven.

**Reference fixture:** the KRBSG Data sheet, rebuilt as a Sapwood project, is the end-to-end test case for every phase. The milestone "KRBSG round-trip" means: import it, edit it, land the edits, and export JSON that a client could read.

---

## Phase 0: Spikes (decide before building on them)

Each spike is throwaway code with a written result: what was tried, measurements, and a decision.

### S1. Formula engine (riskiest): done

**Result:** [spikes/S1-formula-engine.md](spikes/S1-formula-engine.md). We write our own TypeScript engine. IronCalc becomes a dev-only test oracle: we run the same formulas through it and compare results. Every pass criterion was met.

Evaluate (a) a TypeScript engine of our own and (b) IronCalc via WASM, with (c) C++/Rust → WASM in view (DESIGN §12.2).

Pass criteria:

- Formulas stored against **stable row/column IDs**, rendered as A1. Row insert/delete/move never rewrites formula text.
- Cross-sheet references, ranges, and incremental recalculation over a dependency graph.
- Can be extended with `ENTITY()` and rule functions (`REFS`, `ENTITIES`), and can enforce pack reachability.
- Runs identically in Node and the browser.
- About 10k formula cells recalculate after a single edit in under 50 ms.
- An honest estimate of the cost to reach the target function set (the top ~100 Excel functions).

### S2. Grid component: done

**Result:** [spikes/S2-grid-component.md](spikes/S2-grid-component.md). We use Glide Data Grid. Our model, ops, clipboard and undo stay in our code, and Glide only renders and reports edits. Univer passed the criteria too, but only after its model, formula engine, editor and clipboard were all overridden. Copy/paste round trips with the real Excel and Sheets apps work.

Evaluate Glide Data Grid vs Univer.

Pass criteria:

- 100k rows scroll smoothly.
- Custom overlay layer for validation indicators (DESIGN §6.7).
- A sticky header that changes per row type.
- Copy/paste round-trips with Google Sheets and Excel (HTML + TSV).
- We keep control of the data model: our ops are the truth, not the component's internal state.

### S3. Op rebase

Prototype `apply`, `invert` and `rebase` for the cell, structure and `renameId` ops.

Pass criteria:

- Property-based tests: random concurrent op sequences give the same result regardless of land order where that's expected, and every conflict in DESIGN §8.5 is detected.

---

## Phase 1: Core library (`packages/core`), headless

- Schema model: types (with optional singleton), traits, all field types from DESIGN §5.3 including structs and unions (model and validation only; editors come in Phase 4), enums, stable IDs, YAML text form.
- Sheet model: cells, stable row/column IDs, layouts, formats.
- Row classification, cell parsing, entity projection.
- Formula engine integration (per S1).
- Validation pipeline: parse → constraints → global ID uniqueness → refs → pack reach → custom rules.
- Ops: apply, invert, rebase (per S3), including schema migrations.
- JSON export per pack, plus the manifest, deterministic.
- In-memory "project" API: load, apply ops, validate, export.

**Milestone M1:** KRBSG expressed as a schema plus sheets in test fixtures. Validation catches injected errors (bad ref, duplicate ID, wrong type, a cross-sibling pack ref). Export produces the expected JSON.

## Phase 2: Server, persistence, CLI

- SQLite storage: commits, ops, tasks, branches, snapshots.
- Task service: implicit working task, named tasks, auto-rebase, land queue.
- Branches: create, merge, sync, discard; merge commits.
- History: commit log, revert commit, read/export at a commit.
- HTTP API and WebSocket events.
- GitHub OAuth (web) and device flow (CLI). Users, the four roles, scoped tokens.
- CLI covering DESIGN §9.4.
- HTTP export endpoint with ETags.
- MCP server as a thin wrapper over the API.

**Milestone M2:** headless KRBSG round-trip.

1. Create a branch and a task.
2. Use the CLI or an LLM over MCP to add a weapon and a projectile.
3. Validate, land, merge to `main`.
4. Fetch `root.json` over HTTP.
5. Revert the commit.

This is already a useful tool for the author.

## Phase 3: Web app, home and spreadsheet

- Sign-in, the home pack tree, branch selector, task bar.
- Spreadsheet view: formulas, formula bar, selection, fill, copy/paste, interleaved types, sticky header, scratch, formatting.
- Validation overlay and issue panel.
- Type views, find references.
- Commit log and task diff views.

**Milestone M3:** a designer can do all KRBSG editing in the browser, with two people working in parallel tasks.

## Phase 4: Forms and schema UI

- Generated form view, with ref pickers that respect pack reach.
- Panel editors for `json` (with JSON Schema), `struct` and `union` fields, including lists of structs. Flattened sub-columns for simple structs. "Open in form" from the sheet.
- Schema editor UI and validation rule editor (Developer role).
- Per-cell history (blame), per-entity history, restore-to-point.

## Phase 5: Adoption

- Importers: Google Sheets, `.xlsx`, CSV. Map tabs and columns to types and fields.
- Wizards (declarative templates with interleaved placement).
- Performance pass to the 100k-entity ceiling.

## Stretch and later

- Export plugins (custom binary, codegen) from private packages.
- `lockey` field type and a localization table.
- Asset validation against a build manifest.
- Protected branches, review/approval.
- Hot reload into a running client, webhooks, git mirror of exports.
- Per-user display timezone.
- Conditional formatting.
- Postgres storage adapter.
