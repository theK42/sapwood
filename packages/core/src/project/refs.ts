// Find references and go to definition for entity IDs (DESIGN §9.2).
//
// A reference is a ref value that names the ID, in any entity's or singleton's field (inside
// lists and structs too, and whether typed or computed by a formula), or a formula that
// mentions the ID as text (`ENTITY("Blaster")`). IDs match as validation matches them,
// ignoring case. Commented-out rows count, marked inactive.

import type { ColId } from "../formula/model.ts";
import { renameIdFormulas } from "../ops/rename.ts";
import type { Entity, FieldEntry, Location, Project } from "./project.ts";
import { Ref, type FieldValue } from "./values.ts";

export interface IdUse {
  at: Location;
  /** A ref in a field, or a formula naming the ID. */
  kind: "field" | "formula";
  /** The entity or singleton whose cell it is, if any. */
  owner: { type: string; id: string | null } | null;
  /** Where in the owner: `projectiles[0]`, `cost.item`. */
  field: string | null;
  active: boolean;
}

export interface IdUses {
  /** The rows defining the ID (more than one is a duplicate). */
  definitions: Entity[];
  references: IdUse[];
}

export function findReferences(project: Project, id: string): IdUses {
  const lower = id.toLowerCase();
  const p = project.project();
  const definitions = p.entities.filter((e) => e.id !== null && e.id.toLowerCase() === lower);
  const references: IdUse[] = [];
  const seen = new Set<string>();
  const add = (u: IdUse) => {
    const k = `${u.at.sheet}|${u.at.row}|${u.at.col ?? ""}`;
    if (!seen.has(k)) seen.add(k), references.push(u);
  };

  for (const e of p.entities)
    for (const f of e.fields.values()) {
      const paths = refPaths(f.value, f.field.name, lower);
      if (paths.length === 0) continue;
      add({ at: cellFor(project, f, id), kind: "field", owner: { type: e.type, id: e.id }, field: paths[0]!, active: e.active });
    }
  for (const s of p.singletons) {
    const paths = refPaths(s.value, s.path.join("."), lower);
    const b = project.wb.sheet(s.at.sheet).cols.liveIds()[1]; // a singleton's value is in column B
    if (paths.length) add({ at: b === undefined || s.at.col !== undefined ? s.at : { ...s.at, col: b }, kind: "field", owner: { type: s.type, id: null }, field: paths[0]!, active: s.active });
  }
  // Formulas: by the exact text, and by any other spelling a ref would match.
  const spellings = new Set([id, ...definitions.map((d) => d.id!)]);
  for (const sp of spellings)
    for (const m of renameIdFormulas(project.doc, sp)) {
      const owner = p.entities.find((e) => e.at.sheet === m.sheet && e.at.row === m.row) ?? null;
      add({ at: { sheet: m.sheet, row: m.row, col: m.col }, kind: "formula", owner: owner && { type: owner.type, id: owner.id }, field: null, active: owner?.active ?? true });
    }
  return { definitions, references };
}

/** The IDs a value's refs name, with where each is, in order. */
export function refsIn(value: FieldValue | undefined): string[] {
  const out: string[] = [];
  const walk = (v: FieldValue | undefined) => {
    if (v instanceof Ref) out.push(v.id);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v as Record<string, FieldValue>).forEach(walk);
  };
  walk(value);
  return out;
}

/** Where in a value its refs to `lower` sit, as `name[1].sub`. */
function refPaths(v: FieldValue | undefined, label: string, lower: string): string[] {
  if (v instanceof Ref) return v.id.toLowerCase() === lower ? [label] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => refPaths(x, `${label}[${i}]`, lower));
  if (v !== null && typeof v === "object") return Object.entries(v as Record<string, FieldValue>).flatMap(([k, x]) => refPaths(x, `${label}.${k}`, lower));
  return [];
}

/** The cell a field's ref is in: of its cells (a split field has several), the one naming the ID. */
function cellFor(project: Project, f: FieldEntry, id: string): Location {
  if (f.cells.length === 1) return f.cells[0]!;
  const lower = id.toLowerCase();
  const hit = f.cells.find((c) => c.col !== undefined && project.inputAt(c.sheet, c.row, c.col as ColId).toLowerCase().includes(lower));
  return hit ?? f.cells[0]!;
}
