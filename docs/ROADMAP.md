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
- **GitHub sign-in** (DESIGN §11.1): the device flow for `sapwood login`, through the server, and the OAuth redirect for the web, ending in an HTTP-only session cookie that writes need a custom header with. No scope is asked for. Users are bound to their GitHub account's numeric ID at first sign-in. The device flow works against github.com (2026-11-22); the web redirect is tested against a fake GitHub only.
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
