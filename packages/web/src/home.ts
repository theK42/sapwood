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

// ------------------------------------------------------------ dragging in the tree

/** What's being dragged: a sheet (in its pack) or a pack. */
export type Dragged = { kind: "sheet"; id: string; pack: string } | { kind: "pack"; id: string };

/** Where it's dropped: before or after a sheet, or before, after or into a pack. */
export type DropAt = { on: "sheet"; id: string; where: "before" | "after" } | { on: "pack"; id: string; where: "before" | "after" | "into" };

/**
 * The patches a drop makes, as one change: reordering among siblings, or moving into another
 * pack and placing it there. Empty when it changes nothing; null when it can't be dropped
 * there (a pack into itself or its own packs, a sheet before or after a pack, the root moved).
 */
export function dropPatches(root: PackNode, d: Dragged, at: DropAt): Record<string, unknown>[] | null {
  const packs = new Map<string, { node: PackNode; parent: PackNode | null }>();
  const walk = (n: PackNode, parent: PackNode | null) => {
    packs.set(n.id, { node: n, parent });
    for (const q of n.packs) walk(q, n);
  };
  walk(root, null);
  /** The one to go after, so as to land just before or after `target` among `list` (without the one moving). */
  const afterOf = (list: string[], me: string, target: string, where: "before" | "after"): string | null => {
    const rest = list.filter((x) => x !== me);
    const i = rest.indexOf(target);
    return where === "after" ? target : i > 0 ? rest[i - 1]! : null;
  };

  if (d.kind === "sheet") {
    const from = packs.get(d.pack)?.node;
    const me = from?.sheets.find((s) => s.id === d.id);
    if (!from || !me) return null;
    let to: PackNode;
    let after: string | null | undefined; // undefined: wherever a move puts it (last)
    if (at.on === "sheet") {
      const owner = [...packs.values()].find((p) => p.node.sheets.some((s) => s.id === at.id))?.node;
      if (!owner) return null;
      if (at.id === d.id) return [];
      to = owner;
      const names = owner.sheets.map((s) => s.name);
      after = afterOf(names, me.name, owner.sheets.find((s) => s.id === at.id)!.name, at.where);
    } else {
      if (at.where !== "into") return null;
      to = packs.get(at.id)!.node;
      if (to.id === from.id) return [];
    }
    const out: Record<string, unknown>[] = [];
    if (to.id !== from.id) out.push({ op: "moveSheet", name: me.name, to: to.name, pack: from.name });
    if (after !== undefined) {
      const was = from.sheets.map((s) => s.name);
      const before = was.indexOf(me.name) > 0 ? was[was.indexOf(me.name) - 1]! : null;
      if (to.id !== from.id || before !== after) out.push({ op: "orderSheet", name: me.name, after, pack: to.name });
    }
    return out;
  }

  const me = packs.get(d.id);
  if (!me || me.parent === null || at.on !== "pack") return null;
  const target = packs.get(at.id);
  if (!target) return null;
  // Not into itself, nor anything inside it.
  for (let p: { node: PackNode; parent: PackNode | null } | undefined = target; p; p = p.parent ? packs.get(p.parent.id) : undefined) if (p.node.id === d.id) return at.id === d.id ? [] : null;
  const out: Record<string, unknown>[] = [];
  if (at.where === "into") {
    if (me.parent.id !== target.node.id) out.push({ op: "movePack", name: me.node.name, parent: target.node.name });
    return out;
  }
  if (target.parent === null) return null; // beside the root: nowhere
  if (me.parent.id !== target.parent.id) out.push({ op: "movePack", name: me.node.name, parent: target.parent.name });
  const siblings = target.parent.packs.map((q) => q.name);
  const after = afterOf(siblings, me.node.name, target.node.name, at.where);
  const was = me.parent.packs.map((q) => q.name);
  const before = was.indexOf(me.node.name) > 0 ? was[was.indexOf(me.node.name) - 1]! : null;
  if (me.parent.id !== target.parent.id || before !== after) out.push({ op: "orderPack", name: me.node.name, after });
  return out;
}
