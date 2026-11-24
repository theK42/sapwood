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

### S3. Op rebase: done

**Result:** [spikes/S3-op-rebase.md](spikes/S3-op-rebase.md). The op model in DESIGN §8 works as designed. Conflicts are decided by a three-way comparison of each side's net effect, ops are transformed one at a time, and `renameId` is re-run as intent. Property tests over 100,000 random cases each found two bugs and a design gap (anchors of rows the other side moved), all fixed. Phase 2 needs rebase to work from the keys the ops touch instead of diffing whole sheets.

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

**Status (2026-11-19): M1 met.** The fixtures are in [`packages/core/fixtures/krbsg`](../packages/core/fixtures/krbsg), including the expected export. Done so far:

- **Schema:** the model, the YAML text form and resolution.
- **Engine:** the S1 formula engine is in core and is now schema-aware.
- **Sheets:** layouts (whole, split-struct and repeated-list columns), row classification including singletons, cell parsing for every field type, and entity projection.
- **Validation:** the whole pipeline, including custom rules.
- **Export:** deterministic JSON per pack, plus the manifest.

**Ops and rebase (2026-11-20).** The project's truth is a plain document that ops apply to; the workbook and engine mirror each op. Done:

- Cell, format, structure, sheet, pack and layout ops, each with an exact inverse.
- `renameId`, schema-aware, rewriting refs inside JSON cells token by token.
- Rebase per S3, on the real document, with S3's property tests ported and passing.
- Per-writer ID salts, so concurrent tasks never mint the same row ID; stable pack IDs.
- An engine fix found by the property tests: deleting a row a formula reads, where the cell is empty, now gives `#REF!`.

**Schema ops and migrations (2026-11-20).** Done:

- `addSchema`, `removeSchema` and `setSchema` over the schema's definitions and fields by stable ID, each with an exact inverse, mirrored into the engine (cells are re-read under the new schema).
- The intent ops `renameType` (types, traits, structs, unions and enums), `renameField` and `renameEnumMember`, rewriting column A, singleton field rows, struct keys and union tags in JSON cells, and enum values. Each reports the formulas and rules it can't rewrite.
- §5.9's migrations: layouts are pinned so adding or removing a field never shifts other columns; a removed field's cells become scratch and the edit lists the ones holding data.
- Rebase of schema ops: per-property conflicts, removed-versus-changed conflicts, item-by-item merging of enum members, traits and variants, and theirs' renames carried into mine's new schema values.
- Property tests for schema edits (undo, replay, mirror; a three-way merge oracle; landing-order symmetry). They found:
  - a crash reading a union whose variant struct was gone;
  - an export crash on two fields of one name;
  - a pre-existing engine bug: with a duplicate ID, `ENTITY(id)` gave whichever row was indexed first, so an engine updated edit by edit could disagree with one rebuilt from scratch. The first in document order now wins, and a row move that changes which one recalculates its readers;
  - rebase bugs: mine renaming a field and back undid theirs' rename of it, and mine removing a member it had added removed theirs' member of the same name.
- Known limits: enum members, traits and variants are matched by name when lists merge, so a task that removes `fire` and then renames `ice` to `fire` merges as if `fire` had stayed. Reordering fields or definitions has no op of its own yet.

**Engine performance (2026-11-20).** Measured with `npm run bench`, on S2's workload: one Projectile, then four Weapons that use it, repeated; each weapon computes `dps` and `impact` (`=ENTITY(E).speed*C`), and a scratch cell sums every weapon's `dps`. Done:

- `ENTITIES(type, field)` depends on the column, not on each cell in it. A reader of 80k weapons' `dps` records one dependency, and an edit to one weapon's `dps` finds it through the row's entity and the sheet's layout. Before, each evaluation recorded 80k dependencies and compared them with the last 80k.
- The entity index updates row by row on row inserts, deletes, restores and moves, as it already did for edits; only a column change that alters columns A and B (which ops never do) rebuilds it. An ID edit patches the type's cached order in place.
- Validation keeps each row's reading and each entity's own checks until a cell in the row changes, so validating after an edit re-reads only that row. Unique IDs, refs, singletons and custom rules are still checked across the project each time.
- Loading was quadratic: each op's inverse was put at the front of a growing list. 20k rows took 14.6 s; now 1 s.
- A topological recalc order turned out not to be needed. The retry scheme evaluates each formula at most twice per recalc, and recalculation is about a third of a load; the rest is applying the ops.

| 10k rows (8k weapons) | Before | After |
|---|---:|---:|
| Load (every formula computed) | 3.4 s | 0.46 s |
| Validate, first time / again | 122 / 104 ms | 91 / 9 ms |
| Edit a weapon's damage, then validate | 107 ms | 13 ms |
| Edit a weapon's ID, then validate | 110 ms | 13 ms |
| Insert / delete / move a row, then validate | 137 / 165 / 153 ms | 11 / 10 / 15 ms |

DESIGN §12's targets at 10k entities are met: an edit with validation in under 50 ms, full validation in under 1 s. At 100k rows a weapon edit with validation takes 170–185 ms (1.4 s before), a full validation 0.9 s, and a load 4.9 s; the remaining costs are listed under Phase 2 and Phase 5. Property tests now validate between random edits, so what validation keeps is checked against a fresh project. They found one bug in the new column dependencies, fixed: an ID taken by an entity of another type changes which row `ENTITIES(type, field)` reads for it, and its readers weren't told.

**The project API (2026-11-20).** `Sapwood` in `packages/core/src/api`, the entry point the CLI, HTTP API and MCP server will wrap (DESIGN §9.4). Done:

- Reads: `get(id)` and `query(typeOrTrait, { where, pack, inactive })`, as entity JSON. A formula field shows its value and formula; a cell that doesn't parse shows what it holds.
- Writes: `set`, `create`, `commentOut`, `uncomment`, `delete`, and `apply(patches)`, all or nothing. Each is ops applied to the project, and comes back with its inverse; `undo` and `redo` work over them. Columns a sheet doesn't have yet are added as ops in the same change.
- `validate()` gives issues by sheet name, A1 address and entity; `export()`, `schemaYaml()`, `doc` and `applyOps` pass through.
- Singletons (2026-11-21): `singleton(type)` and `setSingleton(type, fields)`, also a patch line. Writes go to a field's row, row by row for a struct split into rows; a new field joins the singleton's block, and a singleton with no block gets one (DESIGN §9.4).
- A property test applies random patches and checks that every change undoes exactly, a refused patch changes nothing, and a project rebuilt from the document reads the same.
- `schema apply` (2026-11-21): `applySchema(yaml)` turns an edited schema file into schema ops (DESIGN §5.8), in `ops/schemaDiff.ts`. A property test makes random schema edits on a copy of a project and applies the copy's schema text to the original: the schemas, entity reads and validation must agree, and undo must restore the original. It found:
  - adding a field mid-type on a sheet with no spare columns pinned the layout to a column that didn't exist, in the project's own `addField` too. Pinning now adds the columns;
  - a new field could be given a removed field's ID, so anything still holding the old state would read the new field as the old one. A project now never gives out an ID it has held, and numbers new ones past the highest.
- Known limits of the text form: enum members are matched by name, so renaming a member to a name the enum had reads as a removal and an addition. And edits made in another order than apply's (renaming a type, then removing it) can leave cells the text can't show.
- The text syntax for `query --where` is the CLI's (below).

**The CLI, on a local project file (2026-11-21).** `packages/cli`, the `sapwood` command, over the `Sapwood` API (DESIGN §9.4). Done:

- `init`, `get`, `query --where`, `set`, `create`, `comment-out`, `uncomment`, `delete`, `apply <patch.jsonl>`, `schema get`, `schema apply`, `validate` and `export`, on `sapwood.json` (the document as JSON, `docToJson`). Values are typed for each field's type.
- `create` puts a project's first entity on a new sheet named after its type.
- Tests run each command in a temporary folder. The API's property test now rebuilds the project from the document's JSON form, as a saved file would be.
- Against the server (2026-11-21): `login`, `logout`, `whoami`, `token create`, `branch`, `task`, `undo` and `redo`, and the data, schema, validation and export commands in your current task (DESIGN §9.4). A local `sapwood.json` still works, and comes first when there is one. Tests run the CLI against the real server app in the same process. Running the suite in a loop showed saves failing now and then on Windows: renaming the new file over the old one is refused while something (a virus scanner, the indexer) has it open for a moment. Saves now try the rename again for up to about two seconds.

Importing KRBSG showed that its per-tab names collide once IDs are global (`Ship` was both a texture and a sprite, and so on). The fixture prefixes them. Phase 5's importer will need a way to handle this.

Still to do in Phase 1:

- **Smaller gaps:**
  - the `SINGLETON("T").field` formula function;
  - schema checks for datetime and duration `min`/`max`;
  - singleton lists spread over repeated cells (§6.8).

## Phase 2: Server, persistence, CLI

- SQLite storage: commits, ops, tasks, branches, snapshots.
- Task service: implicit working task, named tasks, auto-rebase, land queue.
- Branches: create, merge, sync, discard; merge commits.
- History: commit log, revert commit, read/export at a commit.
- HTTP API and WebSocket events.
- GitHub OAuth (web) and device flow (CLI). Users, the four roles, scoped tokens.
- CLI covering DESIGN §9.4: done against the server.
- HTTP export endpoint with ETags.
- MCP server as a thin wrapper over the API: done.

**Status (2026-11-21): started.** `packages/server`, over the `Sapwood` API. Done:

- **Storage:** one SQLite file through `node:sqlite`, with the tables of DESIGN §12.3. A commit holds the ops it applied to its first parent, and the full state is stored every 50 commits. Any commit is read back from the nearest snapshot plus the ops after it.
- **Tasks:** an implicit current task per user and branch, named tasks, switching, undo and redo kept in the database, abandon and reopen. A task behind the head is rebased when it's next read or written, if that has no conflicts and loses nothing still to redo. A rebase keeps each change as its own undo step; a property test checks that undoing back to any change gives the same state as rebasing the changes up to it.
- **Landing:** rebase onto the head with conflicts resolved per ID, validation of the merged result, and an atomic commit. Lands run one at a time.
- **Branches:** create from a head, list, discard. Reads at any commit.
- **Merge and sync** (DESIGN §8.6): each branch keeps its net change since its base on the parent. Sync commits the parent's changes onto the branch; merge syncs if need be, then commits the net change on the parent, with two parents. `compare` gives commits to merge, commits to sync, and a sync's conflicts. HTTP routes, and `sapwood branch status`, `sync` and `merge`. A property test lands random changes on `main`, a branch and a branch of it, with random syncs and merges and an open task across them. After every step each branch's base plus net change must rebuild its head exactly, a restarted server must read the same, and a merge must leave the parent equal to the branch.
- **Clean sync commits:** rebase takes `mineFirst`, which settles ties as if mine landed first, and fixed rules for what a deleted row keeps; `reconcile` says the small differences moves and renames can leave. A sync commit is just the parent's changes in all random data tests, plus a reconciling op or two in about 1 in 1,900. Core property tests check that rebasing either way round ends in exactly the same document (or reconcile closes the gap exactly), for data and for schema. The server's test fails if any sync takes the long way.
- **Revert and restore** (DESIGN §8.7): revert makes a task with the commit's inverse, based on the commit, so later changes to the same cells are conflicts settled on land. Restore makes a task taking the branch back to an earlier commit's state exactly, as the difference said plainly (`reconcile`, which now also adds and removes rows and columns). HTTP routes, and `sapwood log`, `revert` and `restore`; commits can be named by a start of their ID. A property test lands random commits, reverts the latest (back to its parent exactly), restores to a random point (exactly that state), reverts an older one settling conflicts for the revert, and checks a restarted server reads the same. It found that a revert and a restore can both bring back one row; a rebase now keeps the one on the head.
- **GitHub sign-in** (DESIGN §11.1): the device flow for `sapwood login`, through the server, and the OAuth redirect for the web, ending in an HTTP-only session cookie that writes need a custom header with. No scope is asked for. Users are bound to their GitHub account's numeric ID at first sign-in. The device flow and the web redirect both work against github.com (2026-11-22).
- **Landing measured** (DESIGN §12.3, 2026-11-22), with `npm run bench:server`. At 10k rows a land takes 50 ms, 160 ms when it rebases first. Getting there:
  - Core's `rebase` compared every cell of the document as JSON, twice, whatever the ops touched; `docsEqual` turned both documents into sorted JSON. Both now skip cells that are still the same object (cloneDoc keeps them), so they cost little more than walking the cells. A property test checks the new `docsEqual` says just what comparing canonDoc()s does.
  - A task behind the head, and a land that rebases, moved onto the head by ops on the project they already have, instead of a project built from the document. The property tests that restart the server now also check every computed value against a project built afresh.
  - At 100k rows: an open task's next read after another task lands went from 12.7 s to 3.8 s, and a land that rebases from 6.2 s to 3.5 s. What's left is mostly copying the whole document, about ten times per rebase.
- **Redo carried over** (DESIGN §8.3): a land or a rebase keeps what was undone, still undone, rebased onto the new head the way a sync commit is made; after a land it goes into a new task, the owner's current one. What no longer applies is dropped and reported (the CLI lists it). Exact with nothing landed in between. A property test checks every carried redo step works and undoes exactly, in rounds of changes, undos and lands by two users.
- **WebSocket events** (DESIGN §9.4): `GET /api/events` pushes head, branch and task events, and validation counts after each burst of changes, to every client allowed to read the branch, by token or by session cookie from a page of this server. Events are sent once committed, never for what was rolled back. Tests use real sockets on a real server: what each client may hear, the cookie's origin check, a revoked token closing its socket, and a rolled-back change saying nothing.
- **MCP server** (DESIGN §9.4): `sapwood-mcp` in `packages/mcp`, over stdio, on the CLI's backend and login. Edits go into your current task; it starts or switches tasks and branches when asked, and the CLI follows. No tools land, merge or discard. Tests drive it through an in-memory MCP client, on a project file and on a server alongside the CLI, and it has been used from Claude Code (2026-11-22): an LLM added a weapon and its projectile to a task, which a person landed.
- **HTTP API** (DESIGN §9.4), on Hono: reads at a head, a task or a commit; writes into tasks; tasks, landing, branches, history, users and tokens; export with ETags.
- **Auth:** the four roles, and tokens with `read-only`, `no-land`, branch and role limits. `sapwood-server init`, `user add`, `token` and `serve` set a server up.
- **Tests:** units for the repo, the HTTP API and the command, and a property test. Three users write random patches to their current tasks and land them in random order, resolving conflicts one way or the other. After every step, a server restarted on the same database must read the same head and tasks, and refused lands must leave the head alone. It found that two tasks creating an entity each made the same row ID; each task's new IDs now carry its number.

Phase 2 is done; what was left of loading speed moved to Phase 5 (2026-11-22).

**Milestone M2:** headless KRBSG round-trip.

1. Create a branch and a task.
2. Use the CLI or an LLM over MCP to add a weapon and a projectile.
3. Validate, land, merge to `main`.
4. Fetch `root.json` over HTTP.
5. Revert the commit.

This is already a useful tool for the author.

**M2 run by hand (2026-11-22):** on a test server with the KRBSG sample, signed in through GitHub's device flow. A branch and a task, a weapon and its projectile added (by CLI, and by an LLM over MCP), landed, merged to `main`, seen in `root.json` fetched over HTTP, then reverted and gone from it.

## Phase 3: Web app, home and spreadsheet

- Sign-in, the home pack tree, branch selector, task bar.
- Spreadsheet view: formulas, formula bar, selection, fill, copy/paste, interleaved types, sticky header, scratch, formatting.
- Validation overlay and issue panel.
- Type views, find references.
- Commit log and task diff views.

**Plan (2026-11-22),** in this order, each step usable before the next:

1. **Foundation:** `packages/web` (React, Vite, Glide Data Grid), served by `sapwood-server serve`. The browser keeps its own copy of the task's document and project, as DESIGN §4.2 says, so formulas and validation answer as you type; it sends ops to the task and the server applies them again as the authority. New routes: a task's document, and ops written into a task, refused if the task moved on since the client last saw it (another client, an LLM, a rebase), so the client reloads instead of diverging. Sign-in through GitHub.
2. **Home:** the pack tree with validation badges, the branch selector, the task bar (status, name, new and switch, Land), recent commits and other people's tasks, kept current by the WebSocket events.
3. **Spreadsheet:** the grid from spike S2 over the real project: formula bar, selection, editing, undo and redo through the task, the sticky per-type header, the type gutter, scratch sheets, formatting.
4. **Sheet editing:** copy/paste (spike S2's clipboard), fill, inserting, deleting and moving rows and columns.
5. **Validation:** the overlay (§6.7) and the issue panel, with click-to-jump.
6. **Type views and find references.**
7. **History:** the commit log, and a task's diff.
8. **Selecting and dragging rows and columns, as in Google Sheets** (must be done before M3):
   - Rows can be selected by their numbers, as columns are by their letters.
   - Click-dragging across unselected headers selects them; it doesn't move anything.
   - Dragging a selected header moves the whole selection (on a data sheet, dropping A and B from it, since they don't move).
   - While dragging, nothing moves: a semi-transparent grey block follows the pointer smoothly, and a highlighted line on a boundary between headers shows where the rows or columns will land. They move on release.

**Status (2026-11-23): steps 1 to 8 done, and M3 met.**

- **Foundation** (step 1): `packages/web`, built with `npm run build:web` and served by `sapwood-server serve` (or `--web <dir>`), with a content security policy that keeps the page to its own server. Sign-in by GitHub, or by pasting a Sapwood token, which becomes a session no more able than the token. A task session keeps the browser's own copy of the task: an edit shows at once, recalculated and validated in the browser, and its ops go to the server one change at a time, each with the revision it was made on. When the task moved on elsewhere, the session reads it again and replays what it hadn't sent; an edit that no longer applies is dropped and said so. Undo and redo are the server's. The WebSocket keeps it current: a write from the CLI or an LLM, or a rebase, shows without a reload. So far the page shows the branch, your task with its validation, undo, redo and Land, and the task's sheets. Tests run the session against a real server in-process: edits, undo and redo, another writer, an edit that no longer applies, a refused edit, a rebase and a land. Tried in the browser on the KRBSG sample.
- **Home** (step 2): the pack tree, with error and warning counts per sheet and per pack (a pack's include its sub-packs'), from your task, or from the branch head when you have none. Beside it, the branch's recent commits and other people's open tasks. The task bar names the task, starts a new one or switches to another of yours, abandons it, says how far behind the head it is and how many conflicts it has, and lands with a message, settling each conflict as yours or the branch's. All of it follows the WebSocket events, so another person's task, land or conflict shows without a reload. Tried in the browser with two users: a conflict on one cell, settled as mine, and the undone change carried into a new task. Not yet: search across IDs, sheets and types (§9.1).
- **Spreadsheet** (step 3): a sheet opens from the pack tree, on Glide Data Grid, at its own address (`/branches/<b>/sheets/<id>`). Cells show values (numbers to 12 significant digits, formulas in blue, errors in red) and the formula bar shows what was typed, with the cell's issue beside it. Typing in a cell or the formula bar writes to your task; typing past the sheet's end makes the rows and columns it needs, in the same change; Delete clears; Ctrl+Z and Ctrl+Y are the task's undo and redo. With no task, your first edit starts one (§8.3). The sticky header names the columns for the row under the cursor's type, or can be pinned to a type; column A has the type's color stripe. Validation draws in its own channel (§6.7): an inset dashed outline and a corner flag, red or amber, with the message on hover; a rule's issue, which is about a row, sits on column A. Formatting: bold (Ctrl+B), italic, five fills and four text colors, and clear, over the selection. Core gained `inputAt` (a cell as typed, `'` before text that would read as a number) and `columnSpecs`; the grid's model (`SheetGrid`) is tested apart from Glide. Tried in the browser on the KRBSG sample. Glide 6.0.4-alpha24 doesn't start editing on a key typed in column A next to the row numbers (its visible-region check is off by one), so there a key goes to the formula bar. Not yet: column widths kept (they reset on reload), number formats, borders, row heights; the rest is steps 4 to 6.
- **Sheet editing** (step 4): copy, cut and paste through our own clipboard (§6.6, spike S2's format): TSV of the shown values, and an HTML table carrying what was typed, the formats, and Sheets' R1C1 formulas. Within Sapwood, formulas move as in Excel (core's `moveFormula`, on the parsed formula) and formats come along; from Sheets, R1C1 formulas are read; from Excel, plain numbers; text that starts with = stays text. The HTML is read without a DOM, so paste is tested in Node. Fill by the fill handle, Ctrl+D (down) and Ctrl+R (right), up and left too. Each line of the source along the fill carries on as a series when it is two or more numbers with a steady step (1, 2 gives 3, 4), or text around such a number (Wave 1, Wave 2 gives Wave 3; star1.png, star2.png gives star3.png; leading zeros kept); anything else repeats, formulas moving with each copy. One cell alone is never a series. Formats repeat. Right-click (on a cell or a column header): copy, cut, clear, insert rows above or below, delete rows, insert columns left or right, delete columns; rows and columns drag to move (at first Glide's own drag, which moved them as you went; step 8 replaced it). Columns A and B of a data sheet stay first. **Columns don't take fields with them:** a type without a custom layout maps fields by position from C, so a column put in, taken out or moved before them would move every field onto its neighbor's data; before any of those, core's `pinColumns` fixes each type used on the sheet to its columns, by ID. Tried in the browser: paste (by dispatched clipboard events, as the automation's keys don't make them), Ctrl+D, inserting and deleting a column and a row, and the fill handle and dragging a row and a column (by slow mouse events from the page, as the automation's own drags are too quick for Glide). The fill handle first did nothing: Glide only passes a fill-handle drag on when `getCellsForSelection` is set, which it now is.
- **Validation** (step 5): the issues panel, opened from the validation badge in the task bar or the sheet bar (or, at the head, an Issues button), sits beside the home page or the sheet. It lists every issue in your task, by sheet in pack-tree order and down each sheet, with its cell or row and the entity the row makes; it filters to errors, warnings or the open sheet. Clicking an issue opens its sheet if need be, selects the cell, scrolls it to the middle and flashes it. The rest of §6.7's overlay: a row with an issue has its number in red or amber, and a cell flashes once when an edit gives it a new error (not the errors a sheet opens with). Glide doesn't let us draw in the row-number column, so the row's mark is its number's color. Tried in the browser on the KRBSG sample: an error and a warning made by typing, then a jump to each from the sheet and from the home page, and to a row out of view.
- **Type views and find references** (step 6): the home page lists the entity types, with how many of each; each opens a type view (`/branches/<b>/types/<Type>`), every entity of the type from every sheet in one grid, in pack-tree order. Each cell is a window on the entity's home cell: its value, format and issue are the home sheet's, the formula bar names it (`Weapons!E2`), and typing writes there, as typed on that sheet (a formula's references are the home sheet's). Columns: the sheet, the ID, the type's fields, then any column a sheet's layout adds (a split list's elements); a field a sheet has no column for is blank there and can't be typed in. Commented-out entities show greyed. Rows aren't added, removed or moved in a type view; that's the home sheets'. Core gained `findReferences(project, id)`: the entities defining an ID, and every ref to it in any field (inside lists and structs, typed or computed, matching as validation does, ignoring case), in singletons, and in formulas naming it (`ENTITY("Blaster")`), with commented-out rows marked. Right-click on a cell (on a sheet or in a type view) offers **Go to** and **Find references** for the ID the cell defines or names, and **Show every Weapon** for its row's type; F12 and Shift+F12 do the same from the keyboard, as in code editors. Find references opens a panel beside the page, in place of the issues panel, listing the definition and each use, which go there when clicked; going to an ID that's defined twice or not at all opens that panel instead. Tried in the browser on the KRBSG sample: the type list, the Weapon type view, its menu, the references to BlasterBolt, going to its definition and to a use, and F12. Not yet: copy and paste, fill and formatting in a type view (Glide's own copy and paste work there, as plain values). Checked later, with step 7: the sheet's right-click menu (Go to, Find references, Show every Weapon), and that a jump leaves the keyboard in the grid.
- **History** (step 7): the branch's history (`/branches/<b>/history`, from "All history" on the home page), each commit opening what it changed (`/branches/<b>/commits/<id>`), and a task's changes (`/branches/<b>/tasks/<n>/changes`), from the change count in the task bar, or another person's task on the home page. Core gained `diffProjects(before, after)`, which compares two whole states by their stable row, column and schema IDs and says what changed as people think of it: schema definitions and fields added, removed, renamed or changed (`Weapon.dmg: type float → int`); sheets added, removed or renamed; on each sheet, entities added, removed, commented out or back, renamed, and each changed field before and after; other cells by address; and how many rows and columns were added, removed or moved, and how many cells' formats changed. A moved row is a move, not a delete and an add. A commit is compared with its parent (the first, for a merge); a task with the commit it's based on, and your own task's diff follows your edits as you make them, with each entity and cell going there when clicked. From a commit, **Revert this commit** and **Restore main to here** each make a new task of yours (DESIGN §8.7), after asking. Tried in the browser on the KRBSG sample: the history, a commit's diff, the task's diff, and going from it to a row. Not tried there: revert and restore, which the server's tests cover. Not yet: per-cell and per-entity history (blame, §8.7).
- **Selecting and dragging rows and columns** (step 8): the headers and row numbers are ours, not Glide's (`headerDrag.ts`). Pressing on a column letter or row number selects it, and dragging across others selects them too; Shift extends from the last one and Ctrl adds or takes one away. The whole rows or columns become the selection's range, so copy, clear, formatting and the right-click menu act on them, and that menu offers only the rows' or the columns' items. Pressing on a selected one and dragging moves the selection: a grey block follows the pointer and a line on the nearest boundary shows where they'll land, and nothing moves until release, when they move in one change and stay selected. On a data sheet A and B are left out of it, and nothing lands before them. Rows or columns not side by side come together where they land. They can land out past the sheet's last row or column, among the blank ones the grid shows; the rows or columns up to there are made in the same change, as inserting them from the menu would. Near an edge the grid scrolls, and Escape calls the move off. A click on one selected header of several selects just that one. The resize handle at a column's edge is still Glide's. Core gained `Project.moveSet`, a move of any set of rows or columns to a boundary, as one op. Tried in the browser on the KRBSG sample: selecting columns and rows by dragging, moving three columns (scrolling as they went) and three rows, a row and a column out into the blank ones past the end, A and B left out of a move, Escape, Shift-click, and the right-click menus on a header and a row number.

**Milestone M3:** a designer can do all KRBSG editing in the browser, with two people working in parallel tasks.

**M3 run by hand (2026-11-23):** on a test server with the KRBSG sample, two designers (Editors, not Admins) signed in with tokens, side by side in the browser. Ana, in one task: a texture, a sprite on it, a collision shape (copied from another with Ctrl+D, renamed, and its box typed as JSON in the formula bar), a projectile using all three, and a weapon firing it, with its damage a formula on the Blaster's; a typo in a ref, flagged at once, fixed from the issues panel; her task's changes reviewed, then landed. Ben, at the same time: the starfield's speeds retyped, a new layer copied from another with its stars typed as a plain list; he saw Ana's task on the home page as she worked. Both changed the Blaster's cooldown: once Ana landed, Ben's task bar said it was a commit behind with a conflict, and landing asked him to keep his or take hers. The branch's export then had both people's work. Found and fixed on the way:

- The sheet's toolbar wrapped onto a second line when an error badge appeared, moving the grid down a row under the pointer, so a typed ID landed in the row above. The toolbar and the formula bar now stay one line each; when there's no room (the issues panel open), the sheet's name, the header picker and an issue's message give way, and the toolbar scrolls sideways.
- A list cell refused `HeavyBolt` for a one-projectile list: it wanted `["HeavyBolt"]`. A plain list typed in a cell holding a whole list of plain values or IDs (`HeavyBolt`, `spr_star3, spr_star4`, `1, 2`) is now written as its JSON, as the CLI reads it.
- A conflict in the land form now names the entity and field: "Blaster's cooldown (Weapons!E2): yours 0.4, the branch's 0.45".
- Glide loads its cell editor the first time a key is typed in a cell; the app now loads it at start, so a quick typist's first keys on a page can't arrive before it.
- Two of the suite's random property tests failed during the run, both on old bugs: schema apply didn't pin the columns of rows that only become a type in the same edit (one type removed and another renamed to its name, then a field added), which one edit at a time does. Fixed, with a test; the property now also says which edits it made when it fails, and renames each type at most once, since the text shows only where a type ends up. The other is in the rebase: rarely (a few in 20,000 random cases), when one side moves rows and the other inserts rows beside them, the rows come out in a different order than a three-way merge gives. Values aren't affected. Fixed, with a test: when placing rows after theirs' rows at the same spot, a row being moved stopped the skip, and a row mine had moved since still counted as theirs' placement.

Not yet, as the run showed: structs and unions (a collision shape's boxes) are typed as JSON until Phase 4's panel editors; there's no autocomplete for IDs; the land form names a cell conflict's entity only for entity rows.

## Phase 4: Forms and schema UI

- Generated form view, with ref pickers that respect pack reach.
- Panel editors for `json` (with JSON Schema), `struct` and `union` fields, including lists of structs. Flattened sub-columns for simple structs. "Open in form" from the sheet.
- Schema editor UI and validation rule editor (Developer role).
- Pack and sheet management: create, rename and move packs (Developer) and sheets (Editor), in the web app's pack tree and the CLI. Making packs and sheets is already in the CLI, the API and MCP (2026-11-22); renaming and moving them isn't, though the ops exist.
- Per-cell history (blame), per-entity history, restore-to-point.

**Plan (2026-11-23),** in this order, each step usable before the next:

1. **Panel editors:** a struct, union, list-of-structs or `json` cell shows a short summary (`Box size (2, 1)`) in place of its JSON, and opens in a panel beside the sheet or type view. The panel is a form generated from the struct or union (pick the variant, then fill its fields; lists with add, remove and reorder; nesting and recursion as sections that fold), or from a `json` field's JSON Schema, with each field's issues beside it. Raw JSON is always there as a fallback, checked as it's typed. Validation checks `json` values against their JSON Schema.
2. **Ref pickers and ID autocomplete:** typing in a ref cell, the formula bar or a panel offers the IDs the field accepts, filtered by type and pack reach.
3. **Form view:** "Open in form" for a row: every field of the entity in one form, with formula-backed fields read-only, "open in sheet" and "replace formula with value". A new entity from a form, placed by the rules in DESIGN §9.3.
4. **Layouts:** choosing, per sheet and type, whether a simple struct is one cell or flattened sub-columns, and whether a list is one cell or repeated columns.
5. **Packs and sheets:** create, rename and move packs (Developer) and sheets (Editor), in the pack tree and the CLI.
6. **Schema editor and rule editor** (Developer role).
7. **History:** per-cell history (blame), per-entity history, restore-to-point.

**Status (2026-11-24): steps 1 to 3 done.**

- **Panel editors** (step 1): a cell holding a whole struct, union, `json` field or list of them (on an entity row, or a singleton's field row) shows a summary in place of its JSON: `Box size (5, 40); Circle radius 3`, a struct of numbers alone as `(5, 40)`, cut at 80 characters. JSON that doesn't read shows as typed, so the problem shows. The formula bar still shows and takes the JSON, and copying gives the JSON to other apps. Enter, a double-click or "Edit in the panel" on the right-click menu opens the cell in a panel beside the sheet or the type view (where it edits the home cell), and while it's open it follows the selection to the next such cell. The form: a union's variant picked from a list (switching keeps the fields of the same name), each field of a struct on its own line with nested ones in sections that fold, lists with add, move up and down and take out, enums and booleans as lists to pick from, and a field that isn't set as a button to set it, so a recursive type unfolds only as far as its value goes. Each change writes the whole value back as one change of the task (text and numbers when they're left), so undo takes back one at a time. Each issue shows under the part it's about, read from validation's message (`shapes[1].radius: must be at least 0` goes under the second shape's radius). The JSON tab shows the value as indented JSON, checked against the field's type as it's typed, written with Apply; JSON that doesn't read can be applied too, and validation says what's wrong. A formula cell is shown, not edited. A `json` field with a JSON Schema gets a form from it (objects with properties, arrays with items, enums, numbers, text, booleans; anything else as JSON text); core gained `checkJsonSchema`, and validation now checks `json` values against their schema (DESIGN §5.3 lists the keywords understood). Tried in the browser on the KRBSG sample: a collision shape's boxes, a circle added, a bad radius and its issue, the JSON tab and a bad variant caught as typed, undo, and the same from the CollisionShape type view. Not tried there: a `json` field with a JSON Schema (KRBSG has none; its checks are tested in core). Not yet: a depth limit for recursive values (DESIGN §5.6); split columns of a struct open nothing (they're plain cells).
- **Ref pickers and ID autocomplete** (step 2): typing where an ID goes lists the IDs it may point at: active entities of the field's types or traits, in a pack it can reach (its own and its ancestors, and descendants for `reach: descendants`), each with its type and where it's defined, an ID defined twice offered once. Those the typing starts come first, then those where it starts a word (`bolt` finds `heavy_bolt` and `HeavyBolt`), then any containing it. ↑ and ↓ move, Enter or Tab puts one in, Escape closes the list, ↓ opens it on an empty box; an ID typed in full closes it, so Enter writes what's typed. It works in a ref cell (a cell editor of our own, given to Glide for those cells), the formula bar, and the panel's ref fields, on sheets and in type views. In a list of refs it completes the item the caret is in, in a plain list (`BlasterBolt, Hea`) or a JSON one (`["BlasterBolt", "Hea`, closing the quote); an element of a list spread over columns and a ref in a struct's split columns count as single refs. Tried in the browser on the KRBSG sample: an enemy's sprite picked in its cell, a second projectile added to the Blaster's list from the formula bar, and an enemy's collider from the Enemy type view. Later tried in the panel's ref fields too, on a struct with refs added to KRBSG in a test task (step 3). On the way: Glide gives its cell editor the cell's column counting the row numbers, so it's one less in ours; the list is put on the page itself, since Glide's editor would clip it.
- **Form view** (step 3): "Open in the form" on the right-click menu of an entity's row, on a sheet or in a type view, shows every field of the entity in a panel beside it, with the value panel's editors (ref suggestions, enums, structs, unions, lists, `json`), each issue under its field, and while it's open it follows the selection to another entity's row. Each change is one change of the task, written through the API's `set`, so a split struct or a list spread over columns goes to its columns, a field with no column gets one, and a new ID renames the entity and the refs to it (a row with no ID gets one in its cell). A field a formula computes is shown with its formula and not edited, with "Show in the sheet" and "Replace the formula with its value". A commented-out entity says so, with "Uncomment it". "New <type>…" on the right-click menu, "+ New" in a type view's bar and in the form make a new entity from a form: its type, pack (when there are several) and ID, and any fields; placed by DESIGN §9.3: the only data sheet in the pack with a row of the type, the user's pick when several have one, or else the sheet named after the type, made in the same change if it isn't there; after the last row of the type. The new entity then opens in the form, and the sheet goes to its row. Tried in the browser on the KRBSG sample with a test struct of refs added to Enemy (`drops: list<struct<Drop>>`, `hp`): hp written into a new column, a drop added with its item picked from the suggestions and a chance out of range shown under it, a formula in hp shown read-only and replaced with its value, a new Enemy made from the form, and the same form from the Weapon type view with its `damage` formula. Not tried there: picking between several sheets (tested in Node). The API's own placement (the CLI, patches, `create` without a sheet) now follows §9.3 too: it used the pack's only data sheet for a type none of its sheets had, guessed the last one's sheet when several had the type, and with no pack looked in every pack; now it's the root unless a pack is given, the only sheet there with the type, and otherwise the type-named sheet, made if need be (a scratch sheet of that name is refused with `no-sheet`).
- **Fixed on the way:** a rare failure of the schema property test (one type's field removed, the type removed, another type renamed to its name) was an old bug: removing a type left its pinned layouts behind, so a type later given its name took them over, with columns for fields it doesn't have, and its rows' data didn't show. Schema apply did it in one step and didn't. A removed type's layouts now go with it (undo puts them back), with a test; 20,000 random cases pass.

## Phase 5: Adoption

- Importers: Google Sheets, `.xlsx`, CSV. Map tabs and columns to types and fields.
- Wizards (declarative templates with interleaved placement).
- Performance pass to the 100k-entity ceiling. Known costs at 100k rows: the checks that span rows (unique IDs, refs) are rebuilt on every validation (about 120 ms); `SUM(ENTITIES(type, field))` re-reads its whole column on each edit (about 30 ms for 80k); loading applies 700k cell ops (about 3 s besides recalculation).
  - **Building a project from the document**, which a new task's first read and a server's first read of a head do: about 4.2 s at 100k rows (`npm run bench:server`). Recalculating every formula is about 40% of it; feeding the cells in is the rest. Two ways to weigh against each other: snapshots that keep computed values and their dependencies, so a load needn't recalculate (formulas' dependencies are found by evaluating them, so values alone aren't enough), and a cheaper build that feeds the cells in without applying the whole document again as ops.
  - **Copying documents:** a rebase copies the whole document about ten times, about 250 ms each at 100k rows. A land that rebases takes 3.5 s there, and an open task's next read after another task lands 3.8 s.

## Stretch and later

- Export plugins (custom binary, codegen) from private packages.
- `lockey` field type and a localization table.
- Asset validation against a build manifest.
- Protected branches, review/approval.
- Hot reload into a running client, webhooks, git mirror of exports.
- Per-user display timezone.
- Conditional formatting.
- Postgres storage adapter.
