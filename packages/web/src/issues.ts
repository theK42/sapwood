// The validation panel's list (DESIGN §9.2): every issue in the task or at the head, each with
// where it is (sheet, cell or row, as the grid counts) and the entity its row makes, in the
// order of the pack tree, then down each sheet. Issues on no sheet come first.

import { classify, numberToCol, validate, type Issue, type Project } from "@thek42/sapwood-core";
import { packTree, type PackNode } from "./home.ts";

export interface IssueItem {
  issue: Issue;
  /** The sheet's ID and name, or null for an issue on no sheet. */
  sheet: { id: string; name: string } | null;
  /** 0-based, as the grid counts; col is null for an issue about the whole row. */
  row: number | null;
  col: number | null;
  /** "D4", "Row 5", or "" for an issue on no sheet. */
  where: string;
  /** "Weapon blaster", when the row is an entity's. */
  entity: string | null;
}

export function issueList(project: Project, issues: readonly Issue[] = validate(project).issues): IssueItem[] {
  const order = new Map<string, number>();
  const walk = (p: PackNode) => {
    for (const s of p.sheets) order.set(s.id, order.size);
    p.packs.forEach(walk);
  };
  walk(packTree(project.doc, []).root);

  const pos = new Map<string, { rows: Map<string, number>; cols: Map<string, number> }>();
  const at = (sheet: string) => {
    let x = pos.get(sheet);
    if (!x) {
      const s = project.wb.sheet(sheet);
      const index = (ids: readonly string[]) => new Map(ids.map((id, i) => [id, i]));
      x = { rows: index(s.rows.liveIds()), cols: index(s.cols.liveIds()) };
      pos.set(sheet, x);
    }
    return x;
  };

  const items: IssueItem[] = issues.map((issue) => {
    const a = issue.at;
    if (!a || !project.doc.sheets.has(a.sheet)) return { issue, sheet: null, row: null, col: null, where: "", entity: null };
    const s = project.wb.sheet(a.sheet);
    const p = at(a.sheet);
    const row = p.rows.get(a.row) ?? null;
    const col = a.col === undefined ? null : (p.cols.get(a.col) ?? null);
    const where = row === null ? "" : col === null ? `Row ${row + 1}` : `${numberToCol(col + 1)}${row + 1}`;
    let entity: string | null = null;
    const [colA, colB] = s.cols.liveIds();
    if (s.kind === "data" && colA !== undefined && row !== null) {
      const k = classify(project.schema, project.inputAt(a.sheet, a.row, colA));
      if (k.kind === "entity") {
        const id = colB === undefined ? "" : project.inputAt(a.sheet, a.row, colB);
        entity = id ? `${k.type} ${id}` : k.type;
      }
    }
    return { issue, sheet: { id: a.sheet, name: s.name }, row, col, where, entity };
  });

  const rank = (x: IssueItem) => (x.sheet ? (order.get(x.sheet.id) ?? order.size) : -1);
  return items
    .map((x, i) => ({ x, i }))
    .sort((a, b) => rank(a.x) - rank(b.x) || (a.x.row ?? -1) - (b.x.row ?? -1) || (a.x.col ?? -1) - (b.x.col ?? -1) || a.i - b.i)
    .map(({ x }) => x);
}
