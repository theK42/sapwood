// The form view (DESIGN §9.3): one entity's fields in one form, each with its value as JSON,
// whether a formula computes it, the cell it's in, and its issues; and where a new entity
// goes (the placement rules of §9.3). Apart from React, so it's tested in Node.

import {
  ApiError, numberToCol, validate, valueJson,
  type Entity, type FieldDef, type Issue, type Location, type PackId, type Project, type SheetId, type RowId,
} from "@thek42/sapwood-core";

/** The entity whose row this is, active or commented out; null for any other row. */
export function entityAt(project: Project, sheet: SheetId, row: RowId): Entity | null {
  return project.project().entities.find((e) => e.at.sheet === sheet && e.at.row === row) ?? null;
}

export interface FormField {
  def: FieldDef;
  /** As JSON, as the API shows it; undefined when blank. */
  value: unknown;
  /** The formula computing it (the first, for split columns), or null. */
  formula: string | null;
  /** The cell to show for it: where the formula is, or its first cell. Null: no column. */
  cell: Location | null;
  /** A cell doesn't read as the field's type; this is what's in it. */
  invalid?: unknown;
  issues: Issue[];
}

export interface Form {
  entity: Entity;
  fields: FormField[];
  /** Issues on the row that no field's cell has: the ID, a missing required field. */
  rowIssues: Issue[];
}

/** One entity's fields, in the schema's order. */
export function formOf(project: Project, e: Entity): Form {
  const schema = project.schema;
  const t = schema.types.get(e.type);
  const issues = validate(project).issues.filter((i) => i.at?.sheet === e.at.sheet && i.at.row === e.at.row);
  const used = new Set<Issue>();
  const fields: FormField[] = [];
  for (const f of t?.fields ?? []) {
    const entry = e.fields.get(f.def.name);
    const cols = new Set(entry?.cells.map((c) => c.col));
    const mine = issues.filter((i) => (i.at?.col !== undefined && cols.has(i.at.col)) || (i.at?.col === undefined && i.message.startsWith(`${f.def.name} `)));
    for (const i of mine) used.add(i);
    const value = entry?.value === undefined ? undefined : valueJson(schema, f.def.type, entry.value, { ref: (id) => id, defaults: false }) ?? undefined;
    let formula: string | null = null;
    let cell: Location | null = entry?.cells[0] ?? null;
    if (entry?.formula)
      for (const c of entry.cells) {
        const text = c.col === undefined ? null : project.engine.formula(c.sheet, a1(project, c));
        if (text) {
          formula = text;
          cell = c;
          break;
        }
      }
    const out: FormField = { def: f.def, value: value === null ? undefined : value, formula, cell, issues: mine };
    if (entry?.invalid && out.value === undefined) {
      const raw = entry.cells.map((c) => project.engine.cellById(c.sheet, c.row, c.col!).value).find((x) => x !== null);
      out.invalid = raw;
    }
    fields.push(out);
  }
  return { entity: e, fields, rowIssues: issues.filter((i) => !used.has(i)) };
}

function a1(project: Project, c: Location): string {
  const s = project.wb.sheet(c.sheet);
  return `${numberToCol(s.cols.posOf(c.col!) ?? 0)}${s.rows.posOf(c.row) ?? 0}`;
}

/** Where a new entity of a type may go in a pack (§9.3): the sheet to use, or the ones to pick from. */
export interface Placing {
  /** Data sheets in the pack with a row of the type, active or commented out. */
  sheets: { id: SheetId; name: string }[];
  /** The data sheet named after the type, and whether it's there yet (if not, it's made). */
  typeNamed: { name: string; exists: boolean; id?: SheetId };
  /** The sheet used when nobody picks: the only one with the type, or the type-named one. */
  default: string;
  /** Several sheets have the type, so the user picks. */
  pick: boolean;
}

export function placing(project: Project, type: string, pack: PackId): Placing {
  const wb = project.wb;
  const ids = new Set<SheetId>();
  for (const e of project.project().entities) if (e.type === type && e.pack === pack) ids.add(e.at.sheet);
  const sheets = [...wb.sheets.values()].filter((s) => s.pack === pack && s.kind === "data" && ids.has(s.id)).map((s) => ({ id: s.id, name: s.name }));
  const named = [...wb.sheets.values()].find((s) => s.pack === pack && s.name === type);
  const typeNamed = named ? { name: type, exists: true, id: named.id } : { name: type, exists: false };
  return { sheets, typeNamed, default: sheets.length === 1 ? sheets[0]!.name : type, pick: sheets.length > 1 };
}

/** A message for a write the API refused, or null when it isn't one of those. */
export function refusal(e: unknown): string | null {
  return e instanceof ApiError ? e.message : null;
}
