// Suggested moves down the pack tree (DESIGN §7.4): entities used only from one branch of
// the tree could live lower, in the lowest pack every user still reaches. A user is an entity
// whose ref names it, or a formula that reads its row, names it with ENTITY("id"), or reads
// its type with ENTITIES("Type") (moving it down would change what that sees). Entities
// nothing uses aren't suggested, nor ones whose row is marked "don't suggest moving".

import type { Expr } from "../formula/bind.ts";
import type { PackId, SheetId } from "../formula/model.ts";
import type { Entity, Project } from "../project/project.ts";
import { refsIn } from "../project/refs.ts";

export interface MoveSuggestion {
  id: string;
  type: string;
  /** Pack names. */
  from: string;
  to: string;
  /** Who uses it: entity IDs, and formula cells as `Sheet!A1`, a few of each. */
  usedBy: string[];
  /** How many uses in all. */
  uses: number;
}

/** The lowest pack every one of these packs reaches: their common ancestor (or one of them). */
function lowestCommon(project: Project, packs: readonly PackId[]): PackId {
  const lists = packs.map((p) => project.wb.ancestors(p));
  return lists[0]!.find((a) => lists.every((l) => l.includes(a)))!;
}

/**
 * Suggested moves, in the order the entities are in the project. `within` limits it to
 * entities in that pack and its sub-packs.
 */
export function suggestMoves(project: Project, within?: PackId): MoveSuggestion[] {
  const wb = project.wb;
  const doc = project.doc;
  const all = project.project().entities.filter((e) => e.active && e.id !== null);
  const byRow = new Map<string, Entity>();
  const byId = new Map<string, Entity>();
  for (const e of all) {
    byRow.set(`${e.at.sheet}|${e.at.row}`, e);
    if (!byId.has(e.id!)) byId.set(e.id!, e);
  }
  const users = new Map<Entity, { packs: Set<PackId>; names: string[] }>();
  const use = (e: Entity | undefined, pack: PackId, name: string) => {
    if (!e) return;
    let u = users.get(e);
    if (!u) users.set(e, (u = { packs: new Set(), names: [] }));
    u.packs.add(pack);
    if (!u.names.includes(name)) u.names.push(name);
  };

  // Refs from entities (commented-out ones keep their data, but don't count).
  for (const e of all)
    for (const entry of e.fields.values()) for (const id of refsIn(entry.value)) if (id !== e.id) use(byId.get(id), e.pack, e.id!);

  // Formulas: the rows they read, and the IDs and types they name.
  const types = project.schema.types;
  for (const s of doc.sheets.values()) {
    const sheet = wb.sheets.get(s.id);
    if (!sheet) continue;
    for (const [k, content] of s.cells) {
      if (content === null || !("f" in content)) continue;
      const [row, col] = k.split("|") as [string, string];
      const host = byRow.get(`${s.id}|${row}`);
      const name = `${sheet.name}!${colName(sheet.cols.posOf(col) ?? 0)}${sheet.rows.posOf(row) ?? 0}`;
      walk(content.f, (x) => {
        if (x.k === "ref" && x.p.row !== null) {
          const e = byRow.get(`${x.sheet}|${x.p.row}`);
          if (e && e !== host) use(e, sheet.pack, name);
        } else if (x.k === "range") {
          for (const e of rowsIn(project, x.sheet, x.a.row, x.b.row, byRow)) if (e !== host) use(e, sheet.pack, name);
        } else if (x.k === "call" && x.args[0]?.k === "str") {
          const arg = x.args[0].v;
          const fn = x.fn.toUpperCase();
          if (fn === "ENTITY") use(byId.get(arg), sheet.pack, name);
          if (fn === "ENTITIES" && (types.has(arg) || [...types.values()].some((t) => t.traits.has(arg))))
            for (const e of all) if (e.type === arg || types.get(e.type)?.traits.has(arg)) use(e, sheet.pack, name);
        }
      });
    }
  }

  const out: MoveSuggestion[] = [];
  for (const e of all) {
    if (within !== undefined && !wb.canReach(e.pack, within)) continue;
    if (doc.sheets.get(e.at.sheet)?.rowFlags.get(e.at.row)?.has("keepHere")) continue;
    const u = users.get(e);
    if (!u) continue;
    const to = lowestCommon(project, [...u.packs]);
    if (to === e.pack || !wb.canReach(to, e.pack)) continue; // not below where it is
    out.push({ id: e.id!, type: e.type, from: wb.packName(e.pack), to: wb.packName(to), usedBy: u.names.slice(0, 5), uses: u.names.length });
  }
  return out;
}

function walk(e: Expr, f: (x: Expr) => void): void {
  f(e);
  if (e.k === "call") e.args.forEach((a) => walk(a, f));
  else if (e.k === "bin") (walk(e.l, f), walk(e.r, f));
  else if (e.k === "neg" || e.k === "pct" || e.k === "field") walk(e.e, f);
}

/** The entities on the rows a range covers (every row, for whole columns). */
function rowsIn(project: Project, sheet: SheetId, a: string | null, b: string | null, byRow: Map<string, Entity>): Entity[] {
  const s = project.wb.sheets.get(sheet);
  if (!s) return [];
  const ids = s.rows.liveIds();
  const pa = a === null ? 1 : (s.rows.posOf(a) ?? 1);
  const pb = b === null ? ids.length : (s.rows.posOf(b) ?? ids.length);
  const out: Entity[] = [];
  for (let i = Math.min(pa, pb); i <= Math.max(pa, pb); i++) {
    const e = byRow.get(`${sheet}|${ids[i - 1]}`);
    if (e) out.push(e);
  }
  return out;
}

function colName(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
