# Sapwood — Design Document

> **Status:** Draft 8, 2026-11-20 (formula engine decided by spike S1, grid component by spike S2, op rebase by spike S3). Decisions marked **Decided** came out of design discussion; items marked **Open** are listed again in [§14](#14-open-questions).

---

## 1. Summary

Sapwood is a version-controlled, validated game-data authoring system that looks and feels like a spreadsheet.

Designers work in a real spreadsheet: formulas, cross-sheet references, scratch space, copy/paste. Product managers work in generated forms and wizards. Engineers and LLMs work in JSON through a CLI, HTTP API and MCP server. Every view reads and writes the same versioned store. Every change is part of a **task** (a set of edits) that can only **land** once the merged result passes validation. Output is one JSON file per **content pack**, consumed by the game client.

## 2. Goals and non-goals

### Goals

1. A familiar interface for large-scale designer work: a real spreadsheet, not a fake one.
2. Automated validation with immediate, in-place feedback.
3. Full history, with per-cell and per-entity history and revertible changes.
4. Many users editing at the same time, through parallel tasks and branches.
5. Non-spreadsheet editing (forms, wizards) for less technical team members.
6. Text/JSON/CLI editing for scripts and LLM connections.
7. Security: authenticated users, role-based permissions, scoped tokens, an audit trail.

### Non-goals (for now)

- Live co-editing of the *same* task (Google Docs-style). Concurrency comes from parallel tasks.
- Review and approval workflows, and protected branches. These come later and are always optional.
- Asset validation as a built-in feature. Asset paths are plain `string` fields, and game-specific checks are custom rules (§5.7).
- Catching content bugs that are valid data (an off-by-one texture, an unused entity). That is QA's job.
- Hot reload into a running client. There is no client yet.
- Codegen and binary formats as built-in features. A plugin hook is a stretch goal (§10.4).
- Localization. Loc keys are planned as a field type later (§5.3).

### Target scale

| Scenario | Entities | Notes |
|---|---|---|
| Realistic dev/test | 50–500 | Day-to-day for the first months |
| Comfortable target | 10k | "Thrilled" scenario |
| Design ceiling | 100k | Must not need a redesign; may need tuning |

## 3. Glossary

| Term | Meaning |
|---|---|
| **Schema** | The set of types, fields, enums and validation rules. Versioned like data. |
| **Type** | An entity type such as `Weapon`. Every entity of every type has a string ID. |
| **Trait** | A reusable, named group of fields that types can include. `ref<Trait>` accepts any type that has it. |
| **Struct / union** | A named value shape with no ID of its own, used as a field type. A union is a tagged choice between structs. |
| **Entity** | One instance of a type. Derived from a *bound row* on a sheet. |
| **Singleton** | A type with at most one instance per branch and no ID, such as `GameConfig`. Entered one field per row (§6.8). |
| **ID** | A string that identifies a keyed entity. **Globally unique** across all types and packs. |
| **Sheet** | A grid of cells. Belongs to exactly one pack. May be a *data sheet* or a *scratch sheet*. |
| **Bound row** | A row whose column A names a type (or `#Type`). Its mapped cells are the entity's fields. |
| **Scratch** | Any cell that is not a bound field: unbound rows, unmapped columns, and whole scratch sheets. Versioned, never exported. |
| **Layout** | For one sheet and one type, the mapping from columns to fields. |
| **Content pack** ("pack") | A node in the pack tree. Exported as one file. Called "pack" for short in prose, CLI flags (`--pack`), schema properties and export fields. |
| **Op** | One atomic edit, such as `setCell` or `insertRows`. |
| **Task** | An ordered list of ops on top of a base commit on one branch. Lands atomically. |
| **Commit** | The result of landing a task or merging a branch. Immutable. |
| **Branch** | A line of commits forked from a parent branch. `main` is the root. |
| **Head** | The latest commit on a branch. |

## 4. Architecture

### 4.1 The key decision: sheets are the source of truth; entities are derived

**Decided.** The authored truth is **schema + sheet documents** (cells, row order, layouts, formats, formulas). Entities are a **derived projection**: the system classifies rows, parses cells, evaluates formulas and builds an indexed entity store from the result.

Why: formulas live in cells. If entities were primary and sheets were a "view", every formula-backed field would have two competing truths (the formula and the value), and every non-sheet edit would have to decide which one wins. With sheets primary, the rules are simple:

- The JSON view, form view and CLI **read** from the derived entity store.
- They **write** by emitting ordinary sheet ops against the entity's home row. Creating an entity inserts a row; editing a field sets a cell.
- Writing a field whose cell holds a formula is rejected unless the caller explicitly asks to replace the formula with a literal (§9.3).

"Core is a relational database" still holds logically. Types are relations, IDs are keys and references are foreign keys, all enforced by validation. Physically, the store is an **op log plus snapshots** (§12). The relational entity model is rebuilt from it and indexed in memory.

### 4.2 Layers

```
 ┌───────────── Clients ──────────────────────────────────────────────┐
 │ Web app: Home (pack tree) · Spreadsheet · Forms · History          │
 │ CLI · MCP server · HTTP consumers (game builds, CI)                │
 └──────────────┬─────────────────────────────────────────────────────┘
                │ HTTP + WebSocket (ops in; state, validation, events out)
 ┌──────────────┴───────────── Server ────────────────────────────────┐
 │ Auth & permissions · Task/branch service · Land queue · Export     │
 │ In-memory materialized state per active branch head (+ overlays)   │
 └──────────────┬─────────────────────────────────────────────────────┘
                │
 ┌──────────────┴────────────── @thek42/sapwood-core (shared, no I/O) ┐
 │ Schema model · Sheet model · Ops (apply/invert/rebase)             │
 │ Row classification · Cell parsing · Formula engine · Validation    │
 │ Entity projection · Export (JSON)                                  │
 └──────────────┬─────────────────────────────────────────────────────┘
                │
 ┌──────────────┴───────────── Storage (SQLite) ──────────────────────┐
 │ Commits · Op log · Tasks · Branches · Snapshots · Users · Audit    │
 └────────────────────────────────────────────────────────────────────┘
```

`@thek42/sapwood-core` is pure and deterministic, and runs both **in the browser and on the server**. The browser uses it for instant formula results and validation while typing. The server uses it as the authority when landing and exporting. Same code means identical results.

## 5. Schema

### 5.1 Scope and permissions

The schema covers types, fields, enums, the pack tree, validation rules, default layouts, wizards and export config. It is **versioned in the same op log as data**, so a task can contain schema and data changes together and land them atomically, including migrations.

**Decided.** Schema and validation editing is separate from data editing, and needs the **Developer** role (§11).

Every type, field and enum has a **stable internal ID**. Names are display and export labels, so renaming a field is a metadata change and layouts never break.

### 5.2 Types

**Decided.** Every entity type is keyed: every entity has a globally unique string ID in column B, and exports as part of an `id → fields` map. There are no keyless or array-shaped types. Clients get dictionaries directly, rather than rebuilding them from arrays at load time. Singletons are the one exception.

**Singletons.** **Decided.** A singleton type (`singleton: true`) has exactly zero or one instance per branch, for things like `GameConfig`.

- **No ID.** The type name is its identity. Singletons aren't in the global ID namespace, and `ref` can't point at them (a ref to the only instance carries no information).
- **One pack.** The schema names the singleton's pack (`pack:`, default `root`). Every field entry must be on a sheet in that pack. A singleton can't be split across packs or repeated per pack.
- **Optional.** A missing singleton, or a missing field, is not an error unless the field is `required`. Clients are expected to have good defaults.
- **Entered as rows**, either in a block or as qualified field rows anywhere in its pack (§6.8). Each field may have at most one active entry in the branch.
- **Exported** under a top-level `singletons` key in its pack's file (§10.1).
- Traits, structs and lists work in singletons just as in entity types.

Type, trait and field names can't contain `.`, because `.` separates names in singleton rows.

### 5.3 Field types

| Type | Cell input | Stored/exported | Constraints |
|---|---|---|---|
| `string` | Text | JSON string | `minLength`, `maxLength`, `pattern`, `nonEmpty` |
| `int` | `12`, `-3`, or an integral formula result (`3.0` → `3`) | JSON number | `min`, `max`. Default range is JS safe-integer (±2⁵³). `int64` is out of scope |
| `float` | Number | JSON number (IEEE double) | `min`, `max`, `finite` (default true) |
| `bool` | Checkbox. Accepts `TRUE/FALSE`, `1/0`, `yes/no` (case-insensitive) | JSON boolean | — |
| `enum<E>` | Dropdown of member names | Member name as string | Must be a member |
| `ref<T₁\|T₂\|…>` / `ref<Trait>` / `ref<any>` | ID string, with autocomplete | `{ "type", "id" }` object by default; exporter option (§10.2) | Target exists (exact, case-sensitive match), is active, has an allowed type or trait, and is reachable under pack rules (§7.2) |
| `datetime` | ISO 8601. `2026-11-14 18:00` with no offset is read as UTC; explicit offsets are converted | ISO 8601 UTC string `2026-11-14T18:00:00Z` | `min`, `max` |
| `duration` | `1d 2h 30m`, `90s`, `PT1H30M` | Seconds as a JSON number | `min`, `max` |
| `list<T>` | JSON array in one cell, *or* repeated columns (§6.4) | JSON array | `minItems`, `maxItems`, `unique`. `T` is any scalar, ref, struct or union type |
| `json` | JSON text. Edited in a JSON editor panel (§9.2) | Raw JSON value | Optional JSON Schema |
| `struct<S>` | Panel form editor, or flattened sub-columns (§5.6) | JSON object | Field constraints of `S` |
| `union<U>` | Panel form editor: pick a variant, then fill its fields (§5.6) | JSON object with a discriminator field | Valid variant; that variant's field constraints |
| *(later)* `lockey` | Key into a localization table | String | Key exists |

Applies to all types:

- **Presence.** Each field is `required` (blank cell is an error), `optional` (blank exports as omitted), or has a `default` (blank exports the default). **Decided default:** `optional`, with blanks omitted from export.
- **Time is UTC everywhere.** **Decided.** Storage, display and export are all UTC. Teams across timezones share one human-readable standard. A per-user display timezone may come later as an opt-in.
- **Formulas see datetimes** as spreadsheet serial numbers (days since epoch) and durations as days, so date arithmetic works like Excel. Conversion happens at the bound-cell boundary.
- **No built-in asset or hash types.** Asset paths are `string`s with game-specific custom rules (e.g. `=ENDSWITH(script, ".lua")`). Hashing IDs for a client is a job for an export plugin (§10.4), not a field type.

### 5.4 Enums

**Decided.** Enums are defined in the schema: an ordered list of member names, optionally with descriptions. Renaming a member is a schema op that rewrites matching cells (§8.2). Exporting enums as integers could be a later per-field option.

### 5.5 Traits

**Decided.** A trait is a named group of fields that any number of types can include. It replaces inheritance.

```yaml
traits:
  Visual:
    id: tr1
    fields:
      sprite:   { id: f20, type: "ref<Sprite>", required: true }
      script:   { id: f21, type: string }

types:
  Enemy:      { id: t5, traits: [Visual], fields: { health: { id: f22, type: int } } }
  PlayerShip: { id: t6, traits: [Visual], fields: { speed:  { id: f23, type: float } } }
```

- Trait fields behave exactly like the type's own fields: they appear in layouts, forms, JSON and export, flattened into the entity. In export there is no nesting.
- `ref<Visual>` accepts any entity whose type includes `Visual`.
- Editing a trait (adding a field, changing a constraint) changes every type that includes it, in one schema op.
- Rules can target a trait (`trait: Visual`) and then run for every entity that has it.
- Field names must not collide between a type and its traits; that is a schema error.
- **Traits can include other traits.** **Decided.** For example, `Collidable` includes `Visual`, so a type with `Collidable` has both sets of fields, and `ref<Visual>` accepts it.
  - Including the same trait by two paths (diamonds) is fine: its fields appear once.
  - Cycles are a schema error.
  - Field name collisions anywhere in the flattened set are a schema error, as above.

### 5.6 Structs and unions

Rare, but worth doing well, because the alternative today is unvalidated JSON in a cell.

- A **struct** is a named set of fields with no ID. It isn't an entity: it can't be referenced, and it lives inside one field of one entity.
- A **union** is a tagged choice between structs. The export carries a discriminator field (default name `kind`).

```yaml
structs:
  Cost:  { id: s1, fields: { currency: { type: "ref<Currency>" }, amount: { type: int, min: 0 } } }
  Box:   { id: s2, fields: { width: { type: float }, height: { type: float } } }
  Circle:{ id: s3, fields: { radius: { type: float } } }

unions:
  Shape: { id: u1, discriminator: kind, variants: [Box, Circle] }

types:
  ShopItem: { id: t7, fields: { price: { type: "struct<Cost>" } } }
```

How they appear on a sheet is a **layout choice**, like lists (§6.4):

- **Flattened sub-columns** (simple structs): `price.currency` and `price.amount` get their own columns. They're ordinary cells, so formulas, paste and fill all work. Not available for unions or lists of structs.
- **Summary cell + panel editor** (anything): the cell shows a compact read-only summary such as `Box 40×20`. Opening it shows a generated form in a side panel: pick the union variant, then fill its fields, with per-field validation. Lists of structs get a list editor in the same panel.
- **Raw JSON** is always available as a fallback in the panel, and is validated against the struct.

Nesting:

- Structs can contain structs, unions, and lists of either.
- **A union's variants are always structs.** A union directly inside a union adds nothing over flattening its variants into the outer union.
- **Recursion through a struct field** (a union variant containing a list of the same union) is the case that matters for game data: unlock conditions, quest requirements, AND/OR trees. **Decided:** supported. Validation recurses normally. The panel editor shows recursive values as a collapsible tree, with a configurable depth limit (validation error past it). Example:

```yaml
unions:
  Condition: { variants: [HasItem, LevelAtLeast, QuestDone, AllOf, AnyOf, Not] }
structs:
  AllOf: { fields: { conditions: "list<union<Condition>>" } }
  Not:   { fields: { condition: "union<Condition>" } }
```

### 5.7 Validation rules (custom)

Beyond field constraints, Developers write rules as **expressions in the formula language**, so designers can read them and the engine is reused:

```yaml
rules:
  - id: weapon-cooldown-sane
    type: Weapon            # per-entity rule; fields are in scope by name
    severity: warning
    expr: =cooldown >= 0.05
    message: "Cooldown under 50ms is probably a typo"

  - id: loot-table-sums-to-one
    type: LootTable
    severity: error
    expr: =ABS(SUM(REFS(entries, "weight")) - 1) < 0.0001
    message: "Entry weights must sum to 1"
```

- **Per-entity rules** run once per active entity of `type`. Fields are named variables, and `REFS(field, "otherField")` follows references.
- **Global rules** (no `type`) can use aggregate functions such as `ENTITIES("Weapon")`.
- **Severity:** `error` blocks landing; `warning` does not.
- **Rule functions** (from spike S1):
  - Field names are variables in per-entity rules. Rules have no grid, so `hp1` is a field, not a cell.
  - `REFS(field, "other")` follows `ref` and `list<ref>` fields.
  - `ENTITIES(type)` returns IDs; `ENTITIES(type, field)` returns that field's values.
  - `ENTITY(id).field` and `ENTITY(id).id` work as in cells.
  - Rules are not limited by pack reach.

### 5.8 Schema authoring

- **UI.** A schema editor in the web app.
- **Text.** `sapwood schema get > schema.yaml` and `sapwood schema apply schema.yaml` (inside a task). The text form includes stable IDs, so renames are detected as renames, not as delete + add. `apply` diffs the text against the current schema and emits schema ops. **Decided** (2026-11-21):
  - Items are matched by ID. An item written without one matches the item of the same name in the same place (a rule: the same type and expression), so IDs are needed only to rename; new items get IDs no item has had.
  - A name changed under the same ID is a rename (`renameType`, `renameField`), which rewrites cells (§8.2). Names can be swapped. Enum members have no IDs: with the same number of members, one renamed in place to a name the enum didn't have is a rename (`renameEnumMember`); any other change to the list is a plain change, matched by name.
  - The ops are removals, then renames, then additions and property changes. An item moved to another owner or section is removed and added again.
  - Removing a field whose cells hold data needs `--force`, and the cells that became scratch are listed. Formulas and rules a rename can't rewrite are listed too.
  - Reordering has no op yet, so an order change is reported and not applied.
  - Text that doesn't parse or resolve is refused as a whole.

Example, modeled on KRBSG:

```yaml
enums:
  DamageType: { id: e1, members: [kinetic, energy, fire] }

types:
  Texture:
    id: t1
    fields:
      filename:   { id: f1, type: string, required: true }
      isPixelArt: { id: f2, type: bool, default: false }
  Sprite:
    id: t2
    fields:
      shader:  { id: f3, type: "ref<Shader>", required: true }
      texture: { id: f4, type: "ref<Texture>", required: true }
      width:   { id: f5, type: int, min: 1 }
      height:  { id: f6, type: int, min: 1 }
  Weapon:
    id: t3
    fields:
      projectiles: { id: f7, type: "list<ref<Projectile>>", minItems: 1 }
      script:      { id: f8, type: string }
      cooldown:    { id: f9, type: float, min: 0 }
      damage:      { id: f10, type: float }
      damageType:  { id: f15, type: "enum<DamageType>", default: kinetic }
  StarfieldLayer:
    id: t4
    fields:
      density: { id: f11, type: int, min: 0 }
      speed:   { id: f12, type: float }
      alpha:   { id: f13, type: float, min: 0, max: 1 }
      stars:   { id: f14, type: "list<ref<Sprite>>" }
```

### 5.9 Schema migrations

Schema ops in a task change how existing cells are read. That never changes cells directly, except through the explicit rewrite ops in §8.2.

| Change | Effect |
|---|---|
| Rename type/field/enum member | Metadata only (an entity field: layouts hold field IDs), or a cell rewrite (type names in column A, singleton field rows, struct keys and union tags in JSON cells, enum values) |
| Add field | Appended to layouts. Existing rows are blank, so a `required` field causes errors until filled |
| Change field type | Cells are re-parsed under the new type. Failures become validation errors in the same task, to fix before landing |
| Remove field | Requires confirmation if any active cell has data. Cells become scratch rather than being deleted, so no data is lost |
| Remove type | Rows become invalid (unknown type) until deleted or commented out |

**Layouts don't shift.** A default layout follows the schema's field order, so adding a field mid-type (or to a trait, whose fields come first) or removing one would move every later field to a different column. On sheets that already hold rows of the type, the edit first pins the layout as it was: a removed field's column drops out of it and new fields are appended after its last column. Appending a field to the end of a type changes no columns, so nothing is pinned. **Decided.**

**How schema ops are shaped.** The schema is a tree of nodes with stable IDs: the definitions in each section, and the fields of types, traits and structs. Three plain ops cover every change: `addSchema` (a definition or field, after a sibling), `removeSchema` (a definition goes with its fields), and `setSchema` (one property of one node, such as a field's `type` or `min`, or an enum's `members`). Schemas are values: an op makes a new schema and never changes the old one. **Decided.**

## 6. Sheets

### 6.1 Sheet kinds

- **Data sheets** belong to a pack. Their bound rows produce that pack's entities.
- **Scratch sheets** also belong to a pack, for formula reachability (§7.3), but have no bound rows. **Decided:** shared, versioned through tasks like everything else, and referenceable by formulas.

### 6.2 Row classification (column A)

| Column A | Meaning |
|---|---|
| empty | Scratch row |
| `Weapon` (a known entity type) | Active bound row |
| `#Weapon` | **Inactive** bound row: commented out |
| `GameConfig` (a known singleton type) | Singleton block header (§6.8) |
| `#GameConfig` | Inactive block header: the whole block is inactive |
| `.maxLives` | Field row in the current singleton block. Error if no block is open |
| `GameConfig.maxLives` | Qualified singleton field row, valid anywhere in the singleton's pack |
| `#.maxLives`, `#GameConfig.maxLives` | Inactive singleton field row |
| `#` + anything else, including `# Weapon` with a space | Comment/scratch row. A commented-out row has no space after `#` |
| Any other text | **Error**: unknown type or field. Prevents a typo like `Weapn` from silently dropping data |

**Inactive rows** keep their data. Formulas can still read their cells. They are skipped by export, field validation and ID uniqueness. A `ref` that points at an inactive entity is an error ("refers to commented-out entity").

### 6.3 Layouts and the sticky header

**Decided.** Column mapping is a **per-sheet, per-type layout**, defaulting to the schema's field order.

- Column A is always the type and column B is always the ID.
- Columns C onward map to fields according to that sheet's layout for the row's type.
- Cells in a bound row outside the layout's columns are scratch.
- The **sticky header** shows the field names for the type of the row under the cursor. It changes as you move between interleaved types, and can be pinned to a type.
- A thin colored type gutter makes interleaved rows easy to scan.
- Editing a layout (reordering, hiding, adding a field's column) is an op. Layouts reference stable field IDs.

### 6.4 Lists in cells

How a `list<T>` appears is a **layout choice, not a schema choice**. The same field can be a JSON cell on one sheet and repeated columns on another.

- **JSON cell:** `["BlasterBolt", "PlasmaBolt"]`. Each element is parsed and validated, and ref elements get autocomplete.
- **Repeated columns** (often the best choice for short, simple lists): `projectiles[0]`, `projectiles[1]`, `projectiles[2]` over N columns. Trailing blanks are trimmed, and a gap (a blank before a filled column) is an error. `maxItems` defaults to N.

Child rows under a parent are explicitly **not** supported.

### 6.5 Formulas

- **Real formula support:** an Excel/Sheets-compatible function library (math, logic, text, lookup including `VLOOKUP`/`XLOOKUP`/`INDEX`/`MATCH`, date/time), cross-sheet references (`'Weapons'!C14`), ranges and named ranges.
- **Stable references.** **Decided.** Formulas are stored internally against stable row and column IDs and rendered as A1 notation. Inserting, deleting or moving rows never rewrites formula text, and concurrent tasks rebase cleanly. A reference to a deleted row becomes `#REF!`.
- **Sheet names are unique per pack**, not per branch. **Decided.** In formulas:
  - `'Weapon'!C4` (unqualified) resolves to the `Weapon` sheet in the formula's own pack. If there isn't one, it resolves to the nearest ancestor pack that has one.
  - `'root/Weapon'!C4` (qualified) always names the pack explicitly.
  - Either way, the reference is **stored against the sheet's stable ID**, not its name. A sheet added or renamed later never silently retargets an existing formula. Once a reference would be ambiguous, it is rendered qualified.
  - The UI shows `pack/sheet` wherever a bare sheet name would be ambiguous.
- **Entity references:** `ENTITY("Blaster").cooldown`. **Decided** (S1). `.field` is postfix access on any expression, so `ENTITY(B2).damage` works too, and `SINGLETON("T").field` uses the same mechanism. These references survive any row or column movement, and they're the natural form for LLM-written formulas. `ENTITY()` and `ENTITIES()` in cells obey pack reach.
- **No volatile functions.** **Decided** (S1). `TODAY`, `NOW`, `RAND` and similar are not provided, because the same commit must always export the same bytes.
- **Column A is always literal; column B may be a formula.** **Decided** (S1). These rules apply on data sheets; scratch sheets have no bound rows.
  - The type drives classification, layout and the sticky header, so it can't come from a formula.
  - A computed ID (`=Tuning!$A$1&K2`, `="sword_"&C2`) is entered in the entity index once it has been calculated.
  - An ID may not depend on `ENTITY()` or `ENTITIES()`, directly or through other cells (`#CYCLE!`). That rules out every cycle through the index, such as an ID that changes which entities exist, which in turn changes the ID.
  - An entity's identity is its **row**. Editing an input renames the entity as a side effect (§8.4).
  - ID formulas that use position (`ROW()`, `COLUMN()`) get a validation warning, because moving rows would rename entities.
- **Pack reachability.** **Decided.** A formula may only read cells on sheets in its own pack or an ancestor pack. This is the same rule as for refs (§7.2), so the UI only has one rule to explain.
- **No external I/O functions.** `IMPORTDATA`, `IMPORTRANGE`, web fetches and similar are not provided (§11.5).
- **Errors:** a formula error in a bound cell is a validation error. In scratch it is only displayed.
- **Evaluation** is incremental over a dependency graph, in `@thek42/sapwood-core`, and runs on both client and server. `ENTITIES(type, field)` depends on the column as a whole, so a reader of every entity's field costs one dependency, not one per entity.

### 6.6 Copy/paste

- **Our own clipboard layer**, not the grid component's. **Decided** (S2). Copy writes TSV of the shown values, plus an HTML table whose formula cells carry relative R1C1 formulas in `data-sheets-formula`. That attribute is Google Sheets' own, and it is also how Sapwood pastes into itself.
- Within Sapwood: cells copy with formulas, adjusted relatively as in Excel, and with formats.
- To and from Excel and Google Sheets: through the clipboard's HTML and TSV formats. Values and formulas where they map, values otherwise.
- Pasting into bound cells parses and validates immediately. A bad paste shows errors and is never silently coerced.

### 6.7 Formatting

Users get familiar formatting: fill and text color, bold/italic, number formats, borders, column widths and row heights. Conditional formatting comes later. Formatting is versioned, never validated, and merges with "last write wins" per cell.

**Validation indicators are a reserved visual channel**, drawn in an overlay layer above user formatting, so user styling can never hide or imitate them:

- An **inset outline** (dashed red for errors, amber for warnings), drawn inside the cell so it doesn't fight user borders.
- A **corner flag**. Hovering shows the message.
- A **row gutter badge** and a count in the sheet tab.
- A **brief pulse** when an edit *introduces* a new error. One time only; persistent animation is distracting.

### 6.8 Singletons on sheets

Singleton fields are entered **one field per row**: the field name in column A and the value in column B. There are two equivalent forms, and they can be mixed.

**Blocks.** A header row naming the singleton type, followed by `.field` rows:

| | A | B | C | D |
|---|---|---|---|---|
| 1 | `GameConfig` | | | |
| 2 | `.maxLives` | `3` | | *lives at start of a run* |
| 3 | | *scratch row inside the block* | | |
| 4 | `.startingWeapon` | `Blaster` | | |
| 5 | `.reviveCost.currency` | `gems` | | |
| 6 | `.reviveCost.amount` | `=BaseCost*2` | | |
| 7 | `.dailyRewards` | `coin_100` | `coin_200` | `gem_5` |
| 8 | `Weapon` | `Blaster` | `["BlasterBolt"]` | … |

**Qualified rows.** `GameConfig.maxLives | 3` works on any sheet in the singleton's pack, with no header needed. For example, `GameConfig.startingWeapon` can sit right beside the weapon rows it relates to.

Rules:

- **A block runs** from its header to the next bound row (an entity row or another singleton header, active or not) or the end of the sheet. **Scratch and comment rows inside a block don't end it.** A `.field` row with no open block is an error.
- Field rows can be in any order and can be left out. Each field can have **at most one active entry across the branch**, whether in a block or qualified. Two active entries for the same field is an error.
- `#GameConfig` on a header disables that block's rows only, not qualified rows elsewhere. `#.maxLives` disables one field, which then falls back to its default or blank.
- **Values:**
  - Column B holds the value, including formulas.
  - Cells to the right of the value are scratch, which leaves room for notes.
  - Lists are either a JSON array in B or repeated cells spreading right from B (row 7), as a per-sheet layout choice like §6.4.
- **Structs flatten into dotted paths** (`.reviveCost.currency`). `json` and union fields use the summary cell and panel editor (§5.6).
- **Sticky header:** on a singleton row, it shows that field's type and constraints (`maxLives: int, min 1`) instead of column names.
- **Formulas elsewhere** read a field with `SINGLETON("GameConfig").maxLives`, or by plain A1 reference.
- **Form and JSON edits** of a field that has no entry yet append a `.field` row to the singleton's block. If there is no block, they create one on the singleton's default sheet, with rows in schema order.
- **Renaming** a singleton type or field rewrites the matching column A cells (§8.2).

## 7. Content packs

### 7.1 Structure

**Decided.**

- Content packs form a **tree** with a single **root**. Every sheet, data or scratch, belongs to exactly one pack.
- **One export file per pack** (§10).
- The pack tree is the **home view** of the web app (§9.1).
- Creating, moving and renaming packs needs the Developer role. Assigning a sheet to an existing pack needs Editor.

### 7.2 Reference rules

For a `ref` field on an entity in pack **B**, the target must be in:

| Target pack | Allowed? |
|---|---|
| B itself | Yes |
| Any ancestor of B | Yes |
| A sibling, cousin, or any non-ancestor | **Never** |
| A descendant of B | Only if the field explicitly allows it in the schema: `reach: descendants` |

`reach: descendants` is for "table of contents" data. For example, the root's `EventIndex` lists every event pack's `EventDef`. **It is the only relaxable pack rule.**

```yaml
EventIndex:
  fields:
    events: { type: "list<ref<EventDef>>", reach: descendants }
```

### 7.3 Formula reachability

Formulas follow the §7.2 default rule (own pack plus ancestors) for every sheet, including scratch sheets. Scratch sheets that should be readable everywhere go in root. `reach: descendants` does **not** extend to formulas (**Decided**, Q4).

### 7.4 Moving things across packs

Moving a sheet to another pack, or moving rows to a sheet in another pack, is allowed. Validation reports any references or formulas the move breaks, in the task, before landing.

## 8. Change model: ops, tasks, branches, history

### 8.1 Ops

Every change is an op against stable IDs. Every op has an exact inverse.

| Group | Ops |
|---|---|
| Cells | `setCell(sheet, row, col, content)` where content is a literal or formula · `setFormat(range, format)` |
| Structure | `insertRows(sheet, afterRow, rowIds[])` · `deleteRows` · `moveRows` · `insertCols` · `deleteCols` · `moveCols` |
| Sheets | `createSheet` · `deleteSheet` · `renameSheet` · `setSheetPack` · `reorderSheets` · `setLayout(sheet, type, layout)` |
| Packs | `createPack` · `renamePack` · `movePack` · `deletePack` (must be empty) |
| Schema | `addSchema(parent, def, after)` · `removeSchema(id)` · `setSchema(id, key, value)`, over definitions and fields by stable ID (§5.9) · wizard and export config ops |

### 8.2 Refactor ops (compound with intent)

Some edits are recorded with their **intent**, so a rebase can re-run them instead of replaying stale cell writes:

- `renameId(old, new)` rewrites column B and every **literal** reference to the ID across all sheets. It reports refs produced by formulas (`="sword_"&B2`) that it cannot rewrite. When column B is itself a formula, there is nothing to rewrite there; a rename happens by changing the formula's inputs (§8.4).
  - References are found through the schema, not by matching text: only cells where the field type puts a ref (`ref<…>`, a list of them, or a ref inside a struct or union) are rewritten, so a description that happens to equal the ID is left alone. Inside JSON cells, only the matching string tokens change; the rest of the text stays as written. Matching is exact (case-sensitive). Commented-out rows are rewritten too. Formulas are never rewritten; the ones mentioning the old ID as a string literal are listed for the user.
- `renameType(id, name)` renames a type, trait, struct, union or enum. It rewrites the schema's references to it (field types, trait lists, union variants, rules), column A for a type (entity rows, singleton headers, qualified field rows), the sheets' layouts for it, and, for a struct that is a union variant, its tag in JSON cells.
- `renameField(id, name)` rewrites singleton field rows in column A (`.lives`, `GameConfig.lives`, `.cost.amount`) and, for a struct's field, its key in JSON cells. Entity rows need nothing: layouts hold field IDs.
- `renameEnumMember(enum, from, to)` rewrites enum cells, including lists and values inside JSON, and fields' defaults.
- Schema renames address definitions and fields by stable ID, so a concurrent rename on the other side doesn't lose them. Like `renameId`, they never rewrite formulas or rule expressions; they list the ones that mention the old name (`ENTITIES("Weapon")`, `ENTITY(x).cooldown`, `="fire"`).

On rebase, the intent is re-applied against the new head, so rows added concurrently by other tasks are rewritten too.

### 8.3 Tasks

- **Low ceremony.** **Decided.** Each user has an implicit working task per branch, created on their first edit. Its validation status is always visible, with one **Land** button. Users can name tasks, start new ones, and switch between them. Undo and redo work within a task.
- A task has a **base commit**. When the branch head moves:
  - If the task's ops rebase onto the new head without conflicts, it is **auto-rebased** in the background.
  - Otherwise the conflicts are flagged and block landing until resolved.
- **States:** `open` → `landing` → `landed`, or `open` → `abandoned`. Abandoned tasks are kept and can be reopened. On the server a land runs start to finish in one call, so `landing` is never seen.
- **In the server** (2026-11-21):
  - A task is its changes since its base commit, one per write, kept so undo and redo survive a restart. A new write drops what was undone.
  - A task behind the head is rebased when it is next read or written, if that has no conflicts and there is nothing to redo. With conflicts, or with undone changes, it stays on its old base and its status says how far behind it is; an explicit `rebase` (or a new edit, which drops the redo) moves it on.
  - A rebase keeps the task's undo history: each change stays its own step, its ops rewritten for the head and its inverse worked out again there. A change left with nothing (the head's side won all of it) goes. Ops that settle conflicts, such as a cell resolved as mine, make one more step, so a resolution can be undone on its own. What was undone can't be redone after a rebase, so only an explicit rebase drops it. Core's `rebase` reports, for each op it writes, which of the task's ops it came from. **Decided** (2026-11-21), replacing a first version that folded the changes into one.
  - Only the owner writes to a task, and abandons or reopens it. Any Editor may land it (§11.2).
  - Each task's new rows, columns, sheets and schema IDs carry the task's number (`s1r7_1`), so two tasks never make the same ID. Without this, two tasks that each created an entity made the same row, and the rebase saw one insert.
- **Visibility:** everyone with read access can see the list of other users' open tasks and their diffs. **Decided:** there are no per-cell markers for other people's pending edits. Conflicts surface on rebase.

### 8.4 Landing

1. Rebase the task onto the branch head (op transformation against stable IDs).
2. Recompute affected formulas.
3. Run full validation on the **merged result**, so problems that only appear in combination (such as the same ID created in two tasks) are caught.
   - **Computed-ID renames.** Rows whose ID changed are detected per row (the row's ID before and after). Validation reports the references left dangling, and the task offers a one-click **update references** that adds a `renameId`-style rewrite to the task.
4. If there are no errors, commit atomically. Lands are **serialized** per branch through a queue.

### 8.5 Conflicts

| Situation | Result |
|---|---|
| Both sides set the same cell to different contents | Conflict |
| One side edits a row the other deleted (a cell in it, or moves it); the same for columns | Conflict |
| A deletion stands (unconflicted, or settled for the deleting side) | Under it, the row keeps what the deleting side left there, which is what a restore brings back. Deleted by both, the earlier-landed side's. A move of it still moves its tombstone |
| Both sides move the same row to different places | Conflict. Moving it to the same place is not |
| Both sides rename the same ID to different names | Conflict |
| Both sides insert after the same anchor row | No conflict. Deterministic order: the earlier-landed side goes first, including rows it then inserted after those |
| One side inserts after a row the other deleted | No conflict. The tombstone still anchors it |
| One side inserts or moves rows after a row the other moved | No conflict. They stay put: they go after the anchor's old predecessor, so the result doesn't depend on landing order |
| Each change is valid alone but invalid together (duplicate IDs, a broken ref) | Not a conflict. Caught by validation step 3 |
| Formatting on the same cell | Last write wins |
| Sheet, pack and layout changes (rename, move to a pack, set a layout) | Last write wins. One that no longer applies on the head, such as a sheet name the other side took, is dropped and reported |
| Both sides set one schema property (a field's type, a type's name) to different values | Conflict. Different properties of the same field are not |
| One side removes a schema definition or field the other changed or added fields to | Conflict. Keeping the change brings it back as it was in the base, with the keeping side's changes; the removing side's changes to it go with the removal |
| Both sides add enum members, traits or union variants | No conflict. Lists of names merge item by item; the earlier-landed side's additions go first |
| Both sides add fields at the same place | No conflict. The earlier-landed side's go first |
| One side's new schema value names a definition the other side renamed | No conflict. It gets the new name |
| Both sides rename the same enum member differently | Conflict |

Conflicts are decided on each side's **net** effect, a three-way comparison with the base: writing a cell and writing it back is not a change. **Decided by S3.**

To resolve a conflict, the user picks *mine*, *theirs*, or edits the cell, per conflict. Keeping an edit to a row the other side deleted restores the row with all its cells.

### 8.6 Branches

**Decided.**

- A branch forks from a parent branch at a commit. `main` is the root branch. The model allows any depth; the UI shows `main` plus one level at first.
- **Tasks land onto a branch** exactly as above.
- **Merge into parent:** the branch's net change since its fork is rebased onto the parent's head and validated, then committed as one **merge commit** with two parents. The branch's individual commits stay in history.
- **Sync from parent:** the parent's changes are merged into the branch the same way. Needed for long staging branches that receive live hotfixes on `main`.
- **Discard:** the branch is archived, not deleted.
- **Every branch is exportable** over HTTP and CLI, for example for QA on staging.
- All Editors can create, merge, sync and discard branches. Protected branches are later work (§11).
- **How the server does it** (2026-11-21):
  - Each branch keeps its **net change**: ops that take its **base** (a commit on its parent: where it forked, or last synced or merged) to its head. Lands on the branch, and merges into it from its own branches, add to it.
  - **Sync** rebases the net change onto the parent's head; mine is the branch, theirs the parent. The result is validated and committed on the branch, with the parent's head as second parent.
  - **The sync commit** is the parent's changes rebased over the branch's, as if they were a task landing on it, so open tasks on the branch rebase across it like any other commit, and history shows just what came in. That rebase runs with `mineFirst`: the parent counts as landed first though it's rebased second, so ties go as they did the other way round (its rows first at one spot, the branch winning last-write-wins, a row both deleted keeping the parent's contents). Ties then agree exactly. Moves and renames can still come out a little different that way round (a rename re-run meets the other side's writes in one order and not the other); then **reconcile** adds the few ops that say what's left: a row moved, a cell or schema property set. Only if it can't (schema nodes added or removed differently) does the commit undo the branch's net change, apply the parent's, and redo the branch's. In random tests: of syncs over data edits, 1 in about 1,900 needs reconciling and none the long way; of schema-heavy random edits on both sides, about 5% need reconciling, usually by one or two ops, and 0.24% the long way, all with renames or removed fields.
  - **Hidden cell writes.** `setCell` and `setFormat` can carry `hidden: true`, for a cell under a deleted row or column. Only a rebase or reconcile writes them, so that both directions keep the same contents under a deletion; a history view should leave them out.
  - **Merge** syncs first when the parent has moved on, in the same step and with the same resolutions. The merge commit, on the parent with the branch's head as second parent, is then exactly the branch's net change, so afterwards the two are the same and the branch's net change starts again from the merge commit. Merging again brings only what's new.
  - Sync and merge are refused with unsettled conflicts or validation errors, and a merge with no changes. They need the Editor role and a token that may land, on the branch (and, for a merge, the parent).

### 8.7 History and rollback

- History is the immutable commit graph. **History is never rewritten.**
- Views: per-branch commit log, per-task diff, **per-cell history** (blame), and per-entity history (following the entity across row moves).
- **Revert a commit** creates a task containing the inverse ops, rebased onto head and validated like any other task.
- **Restore to a point** reverts every commit after a chosen one, as one task.
- **How the server does it** (2026-11-21):
  - **Revert** makes a new task, the actor's current one on the branch, based on the reverted commit, with one change: the commit's inverse. Rebasing it onto the head is a task rebase like any other, so a later change to the same cells is a conflict, settled on land (mine is the revert). It is named `Revert "<message>"`, and so is the commit it lands as. The commit must be on the branch's line of first parents; by default the branch is the commit's own. Reverting a commit that changed nothing, or the first commit, is refused.
  - **Restore** makes a new task on the head whose one change takes the branch back to the earlier commit's state exactly. The change is the difference said plainly (`reconcile`: rows added since are removed, deleted ones restored, cells set back), not every commit since undone one by one; only when schema nodes or sheets were added or removed since does it fall back to the full inverse. Named `Restore to <id> "<message>"`. Refused when the branch is already as it was then.
  - When two sides both bring back the same row (a revert and a restore, say), the rebase keeps the one already on the head.
  - A commit can be named by a unique start of its ID, 4 characters or more, as `sapwood log` shows it.
- **Read any commit:** browse and export the state at any commit.

## 9. Views

### 9.1 Home: the pack tree

The landing page:

- The pack tree, with sheets under each pack and per-pack and per-sheet validation badges.
- A branch selector and the current task with its status and Land button.
- Recent commits, and other people's open tasks.
- Search across IDs, sheets and types.

### 9.2 Spreadsheet view

The grid described in §6, plus:

- A formula bar, fill handle, keyboard navigation and multi-range selection.
- A validation panel listing every issue in the task, with click-to-jump.
- **Type views:** a virtual sheet showing every entity of a type across all sheets. Edits go back to each entity's home row.
- **Find references** and **go to definition** for IDs.
- **Open row in form**, and **edit complex cell in panel**. `json`, `struct` and `union` cells open a side panel with a generated form (from the struct/union definition, or from the field's JSON Schema if it has one) and a code editor fallback (§5.6).

### 9.3 Form view

- Generated per type from the schema:
  - enum → dropdown
  - ref → searchable picker, filtered by allowed types *and* pack reach
  - datetime → UTC picker
  - list → list editor
  - json → editor panel
- Fields backed by formulas are shown read-only, with "open in sheet" and an explicit "replace formula with value" action.
**Placement of new entities.** **Decided.** Applies to forms, JSON, CLI and MCP.

1. **The pack is always required.** A form asks for it (defaulting to the pack you're browsing). The CLI and API take `--pack`.
2. **Choose the sheet.** "Data sheets in the pack that contain the type" means sheets with at least one row of that type, active or commented out. Scratch sheets never count.

   | Data sheets in the pack containing the type | Sheet used |
   |---|---|
   | None | The **type-named sheet** (below) |
   | Exactly one | That sheet |
   | Several | The user picks one. With no choice, the **type-named sheet** |

   The **type-named sheet** is the data sheet in the pack named exactly after the type (`Weapon`). If it doesn't exist, it is created, in the same task.
3. **Choose the row.** Insert directly after the last row of that type on the sheet, active or commented out. If the sheet has none, append at the end.
4. **Several entities in one request** (a JSON batch, for example) are placed one at a time, so new rows of the same type end up in request order.

The CLI and API can't prompt. When several sheets match, they use `--sheet` if given, and otherwise the type-named default. They never guess between existing sheets. Singletons follow their own rule (§6.8).

**Wizards** (later phase) are for creations too complex for those rules: several entities at once, interleaved rows, new sheets or packs. They are declarative templates written by Developers, versioned with the schema, and run as a form.

```yaml
wizards:
  RewardedMail:
    title: "New rewarded mail"
    params:
      key:     { type: string, required: true, pattern: "^[a-z0-9_]+$" }
      subject: { type: string, required: true }
      rewards: { type: "list<struct<RewardSpec>>", minItems: 1 }
      pack:  { type: pack, default: root }

    sheet: { pack: "{pack}", name: RewardedMail, create: true }
    position: afterLastGroup     # or: end, cursor (when launched from a sheet)
    spacing: 1                   # blank rows between groups

    rows:
      - type: MailMessage
        id: "mail_{key}"
        fields: { subject: "{subject}", format: "fmt_{key}", rewards: "{rewardRows.ids}" }
      - type: Format
        id: "fmt_{key}"
        fields: { template: standard }
      - name: rewardRows         # lets other rows refer to the IDs this step creates
        forEach: rewards
        as: r
        type: Reward
        id: "rwd_{key}_{r.index}"
        fields: { item: "{r.item}", amount: "{r.amount}" }
```

Each run produces one **group** of rows, written contiguously in template order. Repeated runs interleave naturally on the sheet:

```
MailMessage  mail_welcome    …
Format       fmt_welcome     …
Reward       rwd_welcome_0   …
(blank)
MailMessage  mail_comeback   …
Format       fmt_comeback    …
Reward       rwd_comeback_0  …
Reward       rwd_comeback_1  …
```

Wizard capabilities:

- **Parameters** are rendered with the same form generator as entities, including ref pickers, structs and lists. A `pack` parameter type lets the user choose where the wizard writes.
- **Templating:**
  - `{param}` interpolation for IDs and field values. Field values can also be formulas (`"=BaseCost*{tier}"`).
  - `forEach` repeats a row per list item.
  - `when:` includes or skips a row, a sheet or a pack based on a parameter.
- **Placement:**
  - The template targets a sheet by name. With `create: true`, the wizard creates it if missing.
  - `position: end` appends.
  - `position: afterLastGroup` goes after the last group this wizard wrote on that sheet. The system records which rows came from which run.
  - `position: cursor` inserts at the selected row, when the wizard is launched from a sheet.
- **Creating structure:** a `createPack` / `createSheet` step (`name: "event_{key}"`, `parent: root`) runs before rows are written, so a wizard can set up a whole event pack.
- **A run is all or nothing:**
  - The wizard shows a **preview** of exactly the rows, sheets and packs it will create.
  - It runs as one undoable op group in the user's current task.
  - The results are validated like any other edit.
  - It is refused if an ID it would create already exists.
- **Permissions:** running a wizard needs Editor. A wizard that creates packs can only be run by someone allowed to create packs, unless the Developer who wrote it marks that step as allowed for Editors.

### 9.4 JSON, CLI, HTTP and MCP

**Entity JSON** (read):

```json
{
  "$type": "Weapon",
  "$id": "Blaster",
  "$pack": "root",
  "$sheet": "Weapons",
  "$active": true,
  "projectiles": ["BlasterBolt"],
  "script": "blaster.lua",
  "cooldown": 0.5,
  "damage": { "$value": 1, "$formula": "=BaseDamage*1" }
}
```

**Writes** are entity-level patches, translated into sheet ops. A `set` on a formula-backed field fails unless `"force": true`.

- A field is written to the cells the sheet's layout gives it: one cell, a struct's sub-columns, or a list's repeated columns. Values are checked as the cells would be read, so a bad value is refused with the same message validation would give. Null clears a field. `{ "$formula": "=…" }` writes a formula, and needs no `force`.
- `$id` in a `set` renames the entity like `renameId` (§8.2), and `$active` comments it out or back in. `$type`, `$pack` and `$sheet` can't be set.
- `create` puts the new row after the last entity of its type (on the given sheet or pack, if any), or after another entity (`after`). A type with no entities yet needs a sheet, unless the pack has only one data sheet. If that sheet is named after another type, it belongs to that type, so a new data sheet named after the new type is created, in the same change. Taken IDs are refused, regardless of case.
- **Singletons** have no ID, so they have their own read and write: `singleton(type)` returns `{ "$type", "$pack", …fields }` from the active field rows, with a struct split into rows (`.cost.amount`) as one object. `setSingleton(type, fields)` writes column B of a field's row, or each sub-field's row for a split struct; formulas need `force` as above. A field with no row gets one, after the last field row of the singleton's first active block in its pack. With no block, a block is added at the end of the pack's only data sheet (unless it's named after another type), or else on the sheet named after the singleton, created if need be (§6.8). Null clears a field's value and keeps its row. Two active rows for a field is refused as `ambiguous` on write; a read shows the first.
- `applySchema(yaml)` is `schema apply` (§5.8): one change, undone in one step.
- A patch file applies all or nothing, as one undo step. Its lines are `set`, `create`, `commentOut`, `uncomment`, `delete` and `setSingleton`.
- Errors carry a stable code (`not-found`, `ambiguous`, `exists`, `formula`, `no-column`, `bad-value`, …) for the CLI and LLMs to act on.

In `@thek42/sapwood-core` this is the `Sapwood` class: reads, writes, validation located by sheet name and A1 address, export, and undo, over one in-memory project. The server adds tasks, branches and landing on top. **Decided.**

**CLI** (`sapwood …`):

| Area | Commands |
|---|---|
| Auth | `login` (GitHub device flow), `logout`, `whoami`, `token create` |
| Branches | `branch list/create/switch/merge/sync/discard` |
| Tasks | `task new/list/switch/status/name/rebase/land/abandon/reopen`, `undo`, `redo` |
| History | `log [<branch>] [-n <count>]`, `revert <commit>`, `restore <commit>` |
| Data | `get <id>`, `query <type> [--where …]`, `set <id> field=value`, `create <type> --pack <b> [--sheet <s>]`, `comment-out <id>`, `apply <patch.jsonl>` |
| Schema | `schema get`, `schema apply <file>` |
| Validation & export | `validate`, `export [--branch] [--commit] --out <dir>` |

The data, schema, validation and export commands work on a server or on a **local project file**. **Decided** (2026-11-21):

- **A local project file**, `sapwood.json`, is the whole document as JSON. `sapwood init [--schema <file>] [--from <project.yaml>]` starts one. Each command loads it, and a command that changes the project saves it again. There are no branches or tasks locally.
- **On a server**, reads show your current task on the branch (your edits so far), or the branch head when you have none; `--head`, `--task <id>` and `--commit <id>` choose otherwise. Export reads the branch head unless told otherwise. Writes go into your current task, made on your first edit, or into `--task <id>`. A write says which task it went into.
- **Which one:** `--project`, else `--server` (or `$SAPWOOD_SERVER`), else a `sapwood.json` in this folder or one above, else the server you last logged in to.
- **Login:** `sapwood login --server <url> --token <token>` checks the token and saves it, with the server, in `~/.sapwood/config.json` (or `$SAPWOOD_CONFIG`), readable by you only. `$SAPWOOD_TOKEN` stands in for the saved token, for CI and LLMs. Without `--token`, `login` signs in with GitHub: it shows a code to enter at github.com, and saves the Sapwood token the server then gives. Servers without GitHub sign-in hand out tokens with `sapwood-server token`; `sapwood token create` makes more from one you have. `branch switch` saves the branch you work on for that server; `--branch` or `$SAPWOOD_BRANCH` overrides it.
- **Branches:** `branch status [<b>]`, `branch sync [<b>]` and `branch merge [<b>] [-m …]` work on the branch you're on unless named, and take `--resolve` like a land, with mine the branch.
- **Conflicts:** `task status` numbers them, with the cell and both sides' values. `task land` and `task rebase` take `--resolve <n>=mine|theirs`, `--resolve all=theirs`, or a conflict's ID in place of its number. A refused land prints the conflicts or the validation errors.

How values are typed on the command line:

- `set <id> field=value…`: a value is read for the field's type. A blank clears the field, `=…` is a formula, numbers and `true`/`false` are read as such, and lists take JSON or a comma-separated list. Structs, unions and `json` take JSON. `field.sub=value` sets one part of a struct and keeps the rest. Quoted JSON text keeps a string as typed: `name='"=not a formula"'`. `$id=…` renames and `$active=false` comments out. A singleton's type name stands in for an ID in `get` and `set`.
- `query --where`: `field<op>value` with `=`, `!=`, `<`, `<=`, `>`, `>=` and `~` (contains, ignoring case). Repeated `--where`s must all hold. A list matches `=` when it has the value, and `field=` matches a blank field. Numbers compare as numbers, everything else as text, so ISO dates compare in time order.
- Output: `get` prints JSON, and `query` prints one JSON object per line (`--ids` for IDs only). Exit status 0 is success, 1 is a refused change, validation errors or a refused export, and 2 is a mistyped command.

**HTTP API:** the same operations as REST/JSON, under `/api`, with a bearer token on every request. **Decided** (2026-11-21):

- **Reads** work at a branch head (`/api/branches/:branch/…`), in a task (`/api/tasks/:task/…`) and at any commit (`/api/commits/:commit/…`): `entities/:id`, `singletons/:type`, `query/:type?where=…&pack=…&inactive=1` (the CLI's `--where` syntax, repeatable), `schema` (YAML), `validate`, `export` (the files with their ETags) and `export/:path` (one file, `304` when `If-None-Match` matches). Branch names with a slash are URL-encoded.
- **Writes** go into a task. `POST /api/tasks/:task/patches` takes the patch-file lines as a JSON list, all or nothing, as one change. `POST /api/tasks/:task/schema` takes `{ yaml, force }`. The same two under `/api/branches/:branch/` go into the caller's current task there, made on first edit.
- **Tasks:** `GET /api/branches/:b/tasks`, `POST` to make one (it becomes current), `GET …/tasks/current`. On a task: `GET` for its status (how far behind, conflicts, validation counts), `GET ops` for its diff, `PATCH` to name it, and `POST` to `undo`, `redo`, `switch`, `rebase`, `land`, `abandon` and `reopen`. `rebase` and `land` take `{ resolutions: { <conflict id>: "mine" | "theirs" } }`, and a conflict comes with its ID and, for a cell, its sheet and A1 address on the head.
- **Branches and history:** `GET`/`POST /api/branches`, `GET`/`DELETE /api/branches/:b` (delete discards), `GET …/compare` (commits to merge, commits to sync, a sync's conflicts), `POST …/sync` and `POST …/merge` (both take `resolutions`; merge takes `message`), `GET …/commits` (newest first), `GET /api/commits/:c` with its ops, `POST /api/commits/:c/revert` (`branch` optional) and `POST …/restore` (`commit`), each making a task.
- **Users and tokens:** `GET /api/me`. An Admin manages `/api/users`. `POST /api/tokens` makes a token for yourself, at most as able as the token asking; `DELETE /api/tokens/:id` revokes one.
- **Errors** are `{ error: { code, message, … } }`. The API's codes keep their meaning, with `404` for `not-found`, `409` for `exists`, `ambiguous`, `formula` and the like, and `400` for bad values. The server adds `unauthenticated` (401), `forbidden` (403), `conflict` (409, with the conflicts), `invalid` (422, with the validation) and `state` (409, such as a landed task).

A WebSocket will push validation results, head movement and task events to the web app.

**MCP server:** a thin wrapper over the API. LLM edits always go into a task. Tokens can be issued **without land permission**, so a human reviews and lands LLM work (§11.3).

## 10. Export

### 10.1 Files

**Decided.** One JSON file per pack, plus a manifest:

```
export/
  manifest.json
  root.json
  event_halloween.json
  level_07.json
```

Pack file: **Decided** shape `types → id → fields`.

```json
{
  "pack": "event_halloween",
  "parent": "root",
  "commit": "c_8f3a…",
  "types": {
    "Weapon": {
      "PumpkinLauncher": {
        "projectiles": [{ "type": "Projectile", "id": "PumpkinBolt" }],
        "cooldown": 1.5,
        "damage": 4
      }
    },
    "StarfieldLayer": {
      "spooky_far": { "density": 6, "speed": 30, "alpha": 0.3, "stars": ["galaxy", "nebula"] }
    }
  }
}
```

Singletons go under their own top-level key in their pack's file (usually `root.json`), so a client can tell the two shapes apart without reading the schema. A singleton with no entries is omitted.

```json
{
  "pack": "root",
  "types":      { "Weapon": { "Blaster": { "cooldown": 0.5, "damage": 1 } } },
  "singletons": { "GameConfig": { "maxLives": 3, "startingWeapon": { "type": "Weapon", "id": "Blaster" } } }
}
```

Manifest:

```json
{
  "branch": "main",
  "commit": "c_8f3a…",
  "exportedAt": "2026-11-14T18:00:00Z",
  "schemaVersion": "c_77e1…",
  "packs": [
    { "name": "root", "parent": null, "file": "root.json", "sha256": "…" },
    { "name": "event_halloween", "parent": "root", "file": "event_halloween.json", "sha256": "…" }
  ]
}
```

### 10.2 Rules

- Only active entities and computed values are exported. Scratch is never exported.
- **References** export as `{ "type": "Weapon", "id": "Blaster" }` by default, so clients can resolve polymorphic refs without a lookup. This is an **exporter option**: `refs: object` (default) or `refs: id` for bare ID strings. A plugin exporter decides for itself. The editing JSON view (§9.4) always shows refs as bare ID strings, since that's what people type.
- **Deterministic:** the same commit produces byte-identical files, with entity keys sorted by ID. That makes content hashes meaningful for CDN and live-ops delivery.
- Exporting a commit with validation errors is refused by default. `--allow-invalid` exists for debugging and stamps the manifest.

### 10.3 Delivery

**Decided for now:** CLI export, and HTTP `GET /api/branches/{branch}/export/{pack}.json` (also `?commit=`), with ETags. Webhooks, git mirroring and hot reload come later.

### 10.4 Export plugins (stretch)

An `Exporter` interface lets a separate, possibly private, package produce other formats (custom binary, codegen):

```ts
interface Exporter {
  name: string;
  export(snapshot: ExportSnapshot, options: unknown): Promise<ExportFile[]>;
}
```

Plugins are configured by an Admin and run in-process on the server as **trusted code**. Built-in JSON is just the first exporter.

## 11. Security and permissions

### 11.1 Authentication

**Decided:** GitHub OAuth first.

- **Web:** the user is redirected to GitHub, approves, and is redirected back. The server checks the GitHub identity against its user list and sets a secure, HTTP-only session cookie. Sapwood never sees a GitHub password and only requests the minimal scope (`read:user`).
- **CLI/MCP:** the GitHub device flow (the CLI shows a code; the user enters it at github.com) yields a Sapwood **personal access token**. Tokens are stored hashed on the server.
- **Bootstrap:** the server config lists the initial Admin's GitHub username. Admins add other users by GitHub username. Unknown GitHub users who sign in are refused.
- **Without GitHub:** `sapwood-server token <login> --name <name>` makes a token on the server's machine, for servers with no OAuth app and for CI. Tokens look like `swd_…` and are kept as SHA-256 hashes.
- **How the server does it** (2026-11-21):
  - **Setup:** a GitHub OAuth app with the device flow enabled. `serve` reads its client ID from `$SAPWOOD_GITHUB_CLIENT_ID` (enough for the CLI), its secret from `$SAPWOOD_GITHUB_CLIENT_SECRET` (for the web; from the environment only, never the command line, where other users of the machine can see it), and where browsers reach the server from `$SAPWOOD_PUBLIC_URL` or `--url`. Without the client ID, GitHub sign-in is off and says so.
  - **No scope** is asked for, which is less than `read:user`: the public profile's login and numeric ID are all sign-in needs. GitHub's token is used once, to ask who it belongs to, and dropped.
  - **Device flow:** the CLI talks only to the Sapwood server. `POST /auth/device` asks GitHub for a code; the CLI shows it, then polls `POST /auth/device/token`, which polls GitHub, waiting as GitHub says. Once the person approves, the answer is a new Sapwood token, named for the machine unless `--name` says otherwise.
  - **Web:** `GET /auth/github` sends the browser to GitHub with a random state, kept in an HTTP-only cookie. `GET /auth/github/callback` checks the state, exchanges the code, and sets the session cookie: HTTP-only, `SameSite=Lax`, `Secure` when the server is on HTTPS, for 30 days. A session is a token kept on the server, named "Web sign-in", so it shows in the token list and can be revoked; `POST /auth/logout` revokes it. A write made with the cookie must carry the header `X-Sapwood-Request: 1`, which a page on another site can't send.
  - **Who is who:** a user is bound to the GitHub account's numeric ID at first sign-in, and matched by it after. A renamed GitHub account is still its user; someone who later takes the old login is refused. GitHub accounts that aren't users are refused. Sign-ins and refusals go in the audit log.

### 11.2 Roles

**Decided.** Each role includes everything in the roles above it.

| Role | Can |
|---|---|
| **Viewer** | Read everything, export |
| **Editor** | Edit data and scratch; create, name and land tasks; create, merge, sync and discard branches; manage sheets and assign them to packs |
| **Developer** | Edit schema, validation rules, default layouts, wizards and export config; create and move packs |
| **Admin** | Manage users and roles; manage export plugins; later, protect branches and override protection |

Permissions are checked **when an op is authored**. A task containing schema ops authored by a Developer can be landed or merged by any Editor.

### 11.3 Tokens

Personal access tokens carry scopes that are at most the user's own role, plus restrictions:

- `read-only`
- `no-land` (for LLMs: edit only, a human lands)
- `branches: [...]`
- an expiry date
- `role`: at most this role, below the user's own. A user's role is read on every request, so lowering it takes effect at once.

### 11.4 Audit

The commit and op log already records who changed what and when. Auth events, role changes and token creation are logged separately.

### 11.5 Hardening

- The formula engine has no I/O functions and no way to evaluate code.
- Evaluation time and memory are bounded, against pathological formulas.
- Cell content is always rendered as text, never as HTML.
- JSON fields are parsed, never evaluated.
- Strict CORS and CSRF protection for cookie sessions. Rate limits on the auth endpoints.
- SQLite file permissions and a documented backup procedure (the database is one file).

## 12. Technology and persistence

### 12.1 Stack

| Piece | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere | The browser is non-negotiable. One language lets the formula engine, validation and op logic run identically on client and server. Designed by the creator of C#, so it should feel familiar |
| Runtime | Node.js LTS | Mature; first-class SQLite bindings |
| Server framework | **Hono** (MIT), on `@hono/node-server` | Small, typed, fast. Its handlers take web-standard requests, so tests call the app directly with no network |
| Web | React + Vite | Largest ecosystem for grid components |
| Grid | **Glide Data Grid** (MIT, canvas; decided by spike S2) | Canvas rendering is needed at 100k rows. Glide never owns data: it reads cells through a callback and reports edits, so our ops stay the truth. Univer (Apache-2.0) also scrolled 100k rows, but it has its own model, undo stack, clipboard and formula engine, and each had to be overridden |
| Formula engine | **Our own, in TypeScript** (§12.2, decided by spike S1) | Needs incremental recalc, stable-ID references, entity functions and pack reach, none of which an existing engine offers |
| Database | **SQLite**, through Node's built-in `node:sqlite`, behind a thin storage interface | Single file, no server process, trivial to self-host. Our writes are serialized lands, so we don't need Postgres's concurrent writers. A Postgres adapter stays possible later |
| Repo | Monorepo: `packages/core`, `server`, `web`, `cli`, `mcp` | `core` has no I/O and is shared by all |

### 12.2 WebAssembly

**Decided: WASM is not a goal.** TypeScript compiles to JavaScript, not WebAssembly. The TS-to-WASM options (AssemblyScript and similar) are a different language with TS-like syntax. The preference for WASM was aesthetic, so it doesn't drive the choice. Spike S1 decides the formula engine on merit:

- **(a) Engine in TypeScript.** Simplest integration, one language. **Decided** ([S1 result](spikes/S1-formula-engine.md)). With incremental recalc, a typical edit to a 30k-formula workbook takes 4–26 ms, against IronCalc's 200 ms.
- **(b) IronCalc** (Rust → WASM, MIT/Apache). Fast at raw evaluation, with a large function library. But it recalculates the whole workbook on every edit, has no custom-function hook, and stores formulas by position. It is kept as a **dev-only differential test oracle** for function semantics.

HyperFormula is excluded (GPLv3).

### 12.3 Runtime model

At ≤100k entities, a branch's full state fits comfortably in memory. The server keeps the **materialized head state** for each active branch, plus a lightweight overlay per open task. SQLite holds:

| Table | Contents |
|---|---|
| `branches` | name, parent, fork commit, head, archived |
| `commits` | id, branch, parents, task, author, message, timestamp |
| `commit_ops` | commit id, sequence, op (JSON) |
| `tasks` | id, branch, owner, name, base commit, state |
| `task_changes` | task id, sequence, ops and their inverse (JSON), undone. One row per change, for undo and redo |
| `current_tasks` | user, branch → task: each user's current task per branch |
| `snapshots` | commit id → serialized full state, taken every N commits for fast checkout of history |
| `users`, `tokens`, `audit` | as named |

Loading a branch means: nearest snapshot, then replay ops. This is closer to a git server than to a CRUD app.

Performance targets at 10k entities (to be checked as we go):

- Single-cell edit: recompute and validate in under 50 ms. **Met** (2026-11-20): 8–15 ms, including edits that change an ID or move a row.
- Full validation: under 1 s. **Met:** 91 ms from scratch. Validation keeps what it read per row, so a run after an edit takes about 9 ms.
- Land: under 2 s. Measured once landing exists (Phase 2).

`npm run bench` measures these on a generated project (`packages/core/bench/engine.bench.ts`).

## 13. Lessons from KRBSG Data

The KRBSG Data sheet (a small prior project) informed this design:

| KRBSG | Sapwood |
|---|---|
| One type per tab, types in row 1, names in row 2 | Schema lives outside the grid. The sticky header shows names and types. Interleaving is allowed |
| `Ref(Sheet,column)` | `ref<Type>` / `ref<Trait>` with globally unique IDs |
| `Hash` fields that were really refs (`Fonts.texture`, `Starfield.stars`) | Real `ref`s, validated. `Hash` was specific to KRBSG's export format and is not a Sapwood concept |
| Multi-line raw JSON in cells | Panel editors for `json`, `struct` and `union`; raw JSON as a validated fallback |
| Enemies, PlayerShips and Projectiles repeating the same fields | Traits (§5.5) |
| Inconsistent type spelling (`int`/`Int`) | Types chosen in a schema editor, not typed freely |

KRBSG's `CollisionShapes` and `Starfield` designs are explicitly **not** models to follow.

## 14. Open questions

None currently. New questions get added here as they come up.

### Resolved

| # | Question | Decision |
|---|---|---|
| Q2 | Project name | Sapwood, published under the author's npm scope as `@thek42/sapwood-*`; CLI command `sapwood`. License: **MIT** |
| Q1 | WASM | Not a goal; the preference was aesthetic. Formula engine chosen on merit in S1 (§12.2) |
| Q3 | ID case | Stored as typed. **Uniqueness** is checked case-insensitively, so `Blaster` and `blaster` can't both exist. **References** must match exactly (case-sensitive); a case-only mismatch is an error with a "did you mean" hint |
| Q4 | `reach: descendants` for formulas | No. Formulas always follow the default rule |
| Q5 | Singletons | Yes. No ID, one per branch, in one schema-declared pack (default root), optional. Entered as row blocks or qualified rows (§5.2, §6.8). Exported under `singletons` |
| Q6 | Duration export | Seconds as a JSON number |
| Q7 | Placement of form/JSON-created entities | Pack required. Sheet: the only sheet containing the type, the user's pick, or the type-named sheet (created if missing). Row: after the last row of that type. Wizards have their own placement rules (§9.3) |
| Q8 | Traits | Yes (§5.5) |
| Q9 | Per-cell markers for others' pending edits | No |
| Q10 | Pack JSON shape | `types → id → fields` |
| Q11 | Type info on exported refs | Yes by default (`{type, id}`); exporter option `refs: id` turns it off (§10.2) |
| Q12 | Restricting types to packs | No general feature; no solid use case. Singletons already declare their pack (§5.2) |
| Q13 | Traits including traits; nested unions | Traits can include traits (§5.5). Union variants are always structs; recursion through struct fields is supported (§5.6) |
| Q14 | Sheet name scope | Unique **per pack**. Formula sheet references resolve as in §6.5 |
| — | Keyless types | Dropped. Every entity has an ID (§5.2) |
| — | Blank optional fields | Omitted from export |
