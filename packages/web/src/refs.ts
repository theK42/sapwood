// Find references and go to definition, as the web app shows them (DESIGN §9.2): which IDs a
// cell names, and where an ID is defined and used, by position, for jumping to.

import { findReferences, numberToCol, refsIn, type Location, type Project, type RowId, type SheetId } from "@thek42/sapwood-core";

/** A place by position, 0-based as the grid counts; col null for a whole row. */
export interface Place {
  sheet: SheetId;
  sheetName: string;
  row: number;
  col: number | null;
  /** "C2", or "Row 3". */
  where: string;
}

export function placeOf(project: Project, at: Location): Place | null {
  if (!project.doc.sheets.has(at.sheet)) return null;
  const s = project.wb.sheet(at.sheet);
  const row = s.rows.liveIds().indexOf(at.row);
  if (row < 0) return null;
  const col = at.col === undefined ? null : s.cols.liveIds().indexOf(at.col);
  if (col !== null && col < 0) return null;
  return { sheet: at.sheet, sheetName: s.name, row, col, where: col === null ? `Row ${row + 1}` : `${numberToCol(col + 1)}${row + 1}` };
}

/** The IDs a cell is about: the one it defines (an entity's ID cell), and those it names. */
export function idsAt(project: Project, sheet: SheetId, row: number, col: number): { defines: string | null; names: string[] } {
  const s = project.wb.sheet(sheet);
  const rowId = s.rows.liveIds()[row] as RowId | undefined;
  const colId = s.cols.liveIds()[col];
  const none = { defines: null, names: [] };
  if (rowId === undefined || colId === undefined) return none;
  const p = project.project();
  const e = p.entities.find((x) => x.at.sheet === sheet && x.at.row === rowId);
  if (e && col === 1) return { defines: e.id, names: [] };
  const names = new Set<string>();
  const input = project.inputAt(sheet, rowId, colId);
  // A formula naming an entity as text: ENTITY("Blaster").
  if (input.startsWith("=")) for (const m of input.matchAll(/ENTITY\(\s*"((?:[^"]|"")+)"\s*\)/gi)) names.add(m[1]!.replace(/""/g, '"'));
  const fieldsHere = e
    ? [...e.fields.values()].filter((f) => f.cells.some((c) => c.col === colId)).map((f) => ({ value: f.value, split: f.cells.length > 1 }))
    : p.singletons.filter((x) => x.at.sheet === sheet && x.at.row === rowId).map((x) => ({ value: x.value, split: false }));
  for (const f of fieldsHere)
    for (const id of refsIn(f.value))
      // A split list's cell holds one element: only the IDs typed in it.
      if (!f.split || input.toLowerCase().includes(id.toLowerCase())) names.add(id);
  return { defines: null, names: [...names] };
}

export interface RefItem extends Place {
  kind: "definition" | "field" | "formula";
  /** "Enemy grunt", "Config". */
  owner: string | null;
  field: string | null;
  active: boolean;
}

/** Where an ID is defined, then where it's used, in the order core finds them. */
export function refList(project: Project, id: string): RefItem[] {
  const u = findReferences(project, id);
  const out: RefItem[] = [];
  for (const d of u.definitions) {
    const b = project.wb.sheet(d.at.sheet).cols.liveIds()[1];
    const at = placeOf(project, b === undefined ? { sheet: d.at.sheet, row: d.at.row } : { sheet: d.at.sheet, row: d.at.row, col: b });
    if (at) out.push({ ...at, kind: "definition", owner: `${d.type} ${d.id}`, field: null, active: d.active });
  }
  for (const r of u.references) {
    const at = placeOf(project, r.at);
    if (at) out.push({ ...at, kind: r.kind, owner: r.owner ? (r.owner.id ? `${r.owner.type} ${r.owner.id}` : r.owner.type) : null, field: r.field, active: r.active });
  }
  return out;
}
