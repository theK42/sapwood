// Moving entities to another pack (DESIGN §7.4): which refs a move would put out of reach,
// both ways, and formulas following moved cells. Sapwood.moveEntities and previewMove use
// these; they're apart so they can be tested on their own.

import type { Expr } from "../formula/bind.ts";
import type { ColId, PackId, RowId, SheetId, Workbook } from "../formula/model.ts";
import type { Entity, Project } from "../project/project.ts";
import { refsIn } from "../project/refs.ts";

/** A ref that a move would put out of reach: `from`'s `field` names `to`. */
export interface ReachBreak {
  from: string;
  field: string;
  to: string;
}

/** Own pack or an ancestor; descendants too when the field allows it (§7.2). */
function reaches(wb: Workbook, from: PackId, to: PackId, reach?: "descendants"): boolean {
  return from === to || wb.canReach(from, to) || (reach === "descendants" && wb.canReach(to, from));
}

/**
 * For entities about to move to `pack`: refs in them to entities the new pack can't reach
 * (`needs`: moving those along would mend them), and refs to them from entities that won't
 * reach them there (`breaks`: moving those along too would mend them).
 */
export function moveReach(project: Project, moving: readonly Entity[], pack: PackId): { needs: ReachBreak[]; breaks: ReachBreak[] } {
  const wb = project.wb;
  const all = project.project().entities;
  const ids = new Set(moving.map((e) => e.id!));
  const byId = new Map<string, Entity>();
  for (const e of all) if (e.id !== null && e.active && !byId.has(e.id)) byId.set(e.id, e);
  const needs: ReachBreak[] = [];
  const breaks: ReachBreak[] = [];
  for (const e of all) {
    const inMove = moving.includes(e);
    for (const [name, entry] of e.fields) {
      for (const id of refsIn(entry.value)) {
        const t = byId.get(id);
        if (!t) continue; // missing already: validation says so
        if (inMove && !ids.has(id) && !reaches(wb, pack, t.pack, entry.field.reach)) needs.push({ from: e.id ?? "", field: name, to: id });
        if (!inMove && e.active && ids.has(id) && reaches(wb, e.pack, t.pack, entry.field.reach) && !reaches(wb, e.pack, pack, entry.field.reach))
          breaks.push({ from: e.id ?? "", field: name, to: id });
      }
    }
  }
  return { needs, breaks };
}

/** Where a moved cell went: its new sheet, row and column. */
export interface Moved {
  sheet: SheetId;
  row: RowId;
  col: ColId;
}

/**
 * A formula with its references to moved cells pointed at where they went. `rows` are the
 * moved rows (`sheet|row`): a reference into one that has no new place (a cell outside any
 * field) can't follow, nor can a range touching one. `hostPack` is the pack the formula is
 * in after the move, for what it can reach.
 */
export function followMove(
  e: Expr,
  host: SheetId,
  moved: ReadonlyMap<string, Moved>,
  rows: ReadonlySet<string>,
  wb: Workbook,
  hostPack: PackId,
  /** The formula itself moves: everything it reads is checked for reach, not just moved cells. */
  hostMoved: boolean,
): { expr: Expr; changed: boolean; problems: string[] } {
  let changed = false;
  const problems: string[] = [];
  const reach = (sheet: SheetId) => {
    const s = wb.sheets.get(sheet);
    if (s && !wb.canReach(hostPack, s.pack)) problems.push(`#REACH!: it reads ${s.name}, which pack ${wb.packName(hostPack)} can't reach`);
  };
  const go = (x: Expr): Expr => {
    switch (x.k) {
      case "ref": {
        const p = x.p;
        const to = p.row !== null && p.col !== null ? moved.get(`${x.sheet}|${p.row}|${p.col}`) : undefined;
        if (to) {
          changed = true;
          reach(to.sheet);
          return { k: "ref", sheet: to.sheet, explicit: to.sheet !== host, p: { ...p, row: to.row, col: to.col } };
        }
        if (p.row !== null && rows.has(`${x.sheet}|${p.row}`)) problems.push("#REF!: it reads a cell of a moved row that isn't a field's, which stays behind");
        else if (hostMoved) reach(x.sheet);
        if (!x.explicit && x.sheet !== host) {
          changed = true;
          return { ...x, explicit: true };
        }
        return x;
      }
      case "range": {
        if ([x.a.row, x.b.row].some((r) => r !== null && rows.has(`${x.sheet}|${r}`))) problems.push("a range in it starts or ends on a moved row, and stays where it is");
        else if (hostMoved) reach(x.sheet);
        if (!x.explicit && x.sheet !== host) {
          changed = true;
          return { ...x, explicit: true };
        }
        return x;
      }
      case "call":
        return { ...x, args: x.args.map(go) };
      case "bin":
        return { ...x, l: go(x.l), r: go(x.r) };
      case "neg":
      case "pct":
      case "field":
        return { ...x, e: go(x.e) };
      default:
        return x;
    }
  };
  const expr = go(e);
  return { expr, changed, problems };
}
