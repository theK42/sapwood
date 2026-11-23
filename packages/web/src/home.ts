// The home page's pack tree (DESIGN §9.1): packs nested as they are, each with its sheets,
// and validation counts per sheet and per pack (a pack's counts include its sub-packs').
// Issues that aren't on any sheet, such as a missing required singleton field, are the
// project's own.

import { rootPack, type Doc, type Issue } from "@thek42/sapwood-core";

export interface Counts {
  errors: number;
  warnings: number;
}

export interface SheetNode extends Counts {
  id: string;
  name: string;
  kind: "data" | "scratch";
  /** Live rows. */
  rows: number;
}

export interface PackNode extends Counts {
  id: string;
  name: string;
  sheets: SheetNode[];
  packs: PackNode[];
}

export interface Tree {
  root: PackNode;
  /** Issues on no sheet. */
  project: Counts;
}

export function packTree(doc: Doc, issues: readonly Issue[]): Tree {
  const bySheet = new Map<string, Counts>();
  const project: Counts = { errors: 0, warnings: 0 };
  for (const i of issues) {
    let c = project;
    if (i.at && doc.sheets.has(i.at.sheet)) {
      c = bySheet.get(i.at.sheet) ?? { errors: 0, warnings: 0 };
      bySheet.set(i.at.sheet, c);
    }
    if (i.level === "error") c.errors++;
    else c.warnings++;
  }
  const node = (id: string): PackNode => {
    const p = doc.packs.get(id)!;
    const sheets: SheetNode[] = [];
    for (const s of doc.sheets.values()) {
      if (s.pack !== id) continue;
      const c = bySheet.get(s.id) ?? { errors: 0, warnings: 0 };
      sheets.push({ id: s.id, name: s.name, kind: s.kind, rows: s.rows.order.length - s.rows.dead.size, ...c });
    }
    const packs = [...doc.packs.values()].filter((q) => q.parent === id).map((q) => node(q.id));
    const sum = (k: keyof Counts) => sheets.reduce((n, s) => n + s[k], 0) + packs.reduce((n, q) => n + q[k], 0);
    return { id, name: p.name, sheets, packs, errors: sum("errors"), warnings: sum("warnings") };
  };
  return { root: node(rootPack(doc)), project };
}
