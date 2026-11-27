// Ops (DESIGN §8.1): every change to a document, against stable IDs, each with an
// exact inverse. `applyOp` returns the ops that take the new state back to the old
// one; applying them gives a document equal to the original (see docsEqual).
//
// Inserting rows and then undoing it removes them entirely (purge), so an undone
// insert leaves no tombstone. Deleting tombstones them (restore brings them back).

import { sameContent, type Content } from "../formula/content.ts";
import { anchorIndex, insertAfter, type ColId, type PackId, type RowId, type SheetId, type SheetKind } from "../formula/model.ts";
import type { Layout } from "../project/layout.ts";
import { axisOf, cellKey, OpError, hasId, isLive, own, placeInMap, sheetContents, siblingBefore, splitCellKey, type Axis, type Doc, type Format, type RowFlag, type SheetContents, type SheetDoc } from "./doc.ts";
import type { Id } from "../schema/model.ts";
import { renameEnumMemberOps, renameFieldOps, renameIdWrites, renameTypeOps } from "./rename.ts";
import { addNode, removeNode, setNodeProp, type SchemaDef, type SchemaParent } from "./schema.ts";

export type Op =
  // cells
  // `hidden`: the cell is under a deleted row or column, and stays so. A rebase writes these so
  // both landing orders keep the same contents under a deletion (what comes back on restore).
  | { kind: "setCell"; sheet: SheetId; row: RowId; col: ColId; content: Content; hidden?: true }
  | { kind: "setFormat"; sheet: SheetId; row: RowId; col: ColId; format: Format | null; hidden?: true }
  // structure
  | { kind: "insert"; sheet: SheetId; axis: Axis; after: string | null; ids: string[] }
  | { kind: "delete"; sheet: SheetId; axis: Axis; ids: string[] }
  | { kind: "move"; sheet: SheetId; axis: Axis; after: string | null; ids: string[] }
  /** Undo an insert: the IDs go entirely. Their cells must be empty. */
  | { kind: "purge"; sheet: SheetId; axis: Axis; ids: string[] }
  /** Undo a delete. */
  | { kind: "restore"; sheet: SheetId; axis: Axis; ids: string[] }
  // sheets and packs
  /**
   * A new sheet, last of all or right after `after` in the document's order (null: first),
   * holding `contents` if given: how undoing a removal brings a sheet back as it was, where it was.
   */
  | { kind: "createSheet"; sheet: SheetId; name: string; pack: PackId; sheetKind: SheetKind; after?: SheetId | null; contents?: SheetContents }
  /** Remove a sheet and everything on it; the inverse brings it all back. */
  | { kind: "removeSheet"; sheet: SheetId }
  /** Put a sheet right after another of its pack's sheets (null: first of them). */
  | { kind: "orderSheet"; sheet: SheetId; after: SheetId | null }
  | { kind: "renameSheet"; sheet: SheetId; name: string }
  | { kind: "setSheetPack"; sheet: SheetId; pack: PackId }
  | { kind: "setLayout"; sheet: SheetId; type: string; layout: Layout | null }
  /** Set or clear a flag on a row (§7.4: `keepHere` is "don't suggest moving"). */
  | { kind: "setRowFlag"; sheet: SheetId; row: RowId; flag: RowFlag; on: boolean }
  /** A new pack, last of its parent's packs or after `after` (one of them; null: first). */
  | { kind: "createPack"; pack: PackId; name: string; parent: PackId; after?: PackId | null }
  /** Remove a pack: it must have no sheets or sub-packs (remove those first). */
  | { kind: "removePack"; pack: PackId }
  /** Put a pack right after another with the same parent (null: first of them). */
  | { kind: "orderPack"; pack: PackId; after: PackId | null }
  | { kind: "renamePack"; pack: PackId; name: string }
  /** Move a pack under another (not the root, and not under itself or its own sub-packs). */
  | { kind: "setPackParent"; pack: PackId; parent: PackId }
  // schema (§5.9): see schema.ts
  /** Add a definition to a section, or a field to its type, trait or struct, after a sibling (null: first). */
  | { kind: "addSchema"; parent: SchemaParent; def: SchemaDef; after: Id | null }
  /** Remove a definition (with its fields) or a field. */
  | { kind: "removeSchema"; id: Id }
  /** Set one property of a definition or field; without `value`, clear it. */
  | { kind: "setSchema"; id: Id; key: string; value?: unknown }
  // refactors with intent (§8.2): see rename.ts
  | { kind: "renameId"; from: string; to: string }
  /** Rename a type, trait, struct, union or enum, and rewrite what names it. */
  | { kind: "renameType"; id: Id; name: string }
  | { kind: "renameField"; id: Id; name: string }
  | { kind: "renameEnumMember"; enum: Id; from: string; to: string };

/** Intent ops: expanded against the document they apply to, and re-run by a rebase. */
export const isIntent = (op: Op): boolean =>
  op.kind === "renameId" || op.kind === "renameType" || op.kind === "renameField" || op.kind === "renameEnumMember";

export { OpError };

/**
 * The plain ops an op comes down to on this document. Refactor ops expand into the cell
 * writes they make here; everything else is already plain. A rebase re-expands a
 * refactor against the new head, which is what makes it an intent op.
 */
export function expand(doc: Doc, op: Op): Op[] {
  if (op.kind === "renameId") {
    if (op.from === op.to) throw new OpError("renameId: the new ID is the same as the old one");
    return renameIdWrites(doc, op.from, op.to).map((w) => ({ kind: "setCell", sheet: w.sheet, row: w.row, col: w.col, content: w.content }));
  }
  if (op.kind === "renameType") return renameTypeOps(doc, op.id, op.name);
  if (op.kind === "renameField") return renameFieldOps(doc, op.id, op.name);
  if (op.kind === "renameEnumMember") return renameEnumMemberOps(doc, op.enum, op.from, op.to);
  return [op];
}

/** Apply one op in place. Returns its exact inverse, already in the order to apply. */
export function applyOp(doc: Doc, op: Op): Op[] {
  const prims = expand(doc, op);
  if (prims.length === 1 && prims[0] === op) return applyPlain(doc, op);
  return undoAll(prims.map((p) => applyPlain(doc, p)));
}

/** The inverse of a sequence, from each op's inverse in order: the last op's undo comes first. */
export function undoAll(inverses: readonly (readonly Op[])[]): Op[] {
  const out: Op[] = [];
  for (let i = inverses.length - 1; i >= 0; i--) for (const op of inverses[i]!) out.push(op);
  return out;
}

/** Apply a sequence in place. The inverse undoes all of it. */
export function applyOps(doc: Doc, ops: readonly Op[]): Op[] {
  return undoAll(ops.map((op) => applyOp(doc, op)));
}

/** A sheet to write to: its own, not shared with a copy (cloneDoc). */
function sheetOf(doc: Doc, id: SheetId): SheetDoc {
  const s = doc.sheets.get(id);
  if (!s) throw new OpError(`No sheet ${id}`);
  return own(s);
}

/**
 * Columns A and B of a data sheet hold the type and the ID (§6.2): once they exist they
 * can't be deleted or moved, and nothing goes before them.
 */
function systemCols(s: SheetDoc): string[] {
  return s.kind === "data" ? s.cols.order.slice(0, 2) : [];
}

function checkPlacement(s: SheetDoc, axis: Axis, ord: readonly string[], after: string | null, what: string): void {
  if (axis !== "col") return;
  const sys = systemCols(s).filter((id) => ord.includes(id));
  if (anchorIndex(ord, after) + 1 < sys.length) throw new OpError(`${what}: columns A and B of a data sheet hold the type and ID; nothing goes before them`);
}

/** Apply an op that needs no expanding. */
export function applyPlain(doc: Doc, op: Op): Op[] {
  switch (op.kind) {
    case "setCell":
    case "setFormat": {
      const s = sheetOf(doc, op.sheet);
      const here = op.hidden ? hasId(s.rows, op.row) && hasId(s.cols, op.col) && !(isLive(s.rows, op.row) && isLive(s.cols, op.col)) : isLive(s.rows, op.row) && isLive(s.cols, op.col);
      if (!here) throw new OpError(`${op.kind}: no ${op.hidden ? "hidden " : ""}cell ${op.row}|${op.col} on ${s.name}`);
      const k = cellKey(op.row, op.col);
      if (op.kind === "setCell") {
        const prev = s.cells.get(k) ?? null;
        if (op.content === null) s.cells.delete(k);
        else s.cells.set(k, op.content);
        return sameContent(prev, op.content) ? [] : [{ ...op, content: prev }];
      }
      const prev = s.formats.get(k) ?? null;
      if (op.format === null || !Object.keys(op.format).length) s.formats.delete(k);
      else s.formats.set(k, { ...op.format });
      return [{ ...op, format: prev }];
    }
    case "insert": {
      const s = sheetOf(doc, op.sheet);
      const a = axisOf(s, op.axis);
      if (!op.ids.length) throw new OpError("insert: no IDs");
      if (new Set(op.ids).size !== op.ids.length) throw new OpError("insert: an ID is listed twice");
      for (const id of op.ids) if (hasId(a, id)) throw new OpError(`insert: ${id} already exists`);
      if (op.after !== null && !hasId(a, op.after)) throw new OpError(`insert: no anchor ${op.after}`);
      checkPlacement(s, op.axis, a.order, op.after, "insert");
      insertAfter(a.order, op.after, op.ids);
      a.index = undefined;
      return [{ kind: "purge", sheet: op.sheet, axis: op.axis, ids: [...op.ids] }];
    }
    case "purge": {
      const s = sheetOf(doc, op.sheet);
      const a = axisOf(s, op.axis);
      const ids = new Set(op.ids);
      for (const id of ids) {
        if (!hasId(a, id)) throw new OpError(`purge: no ${id}`);
        if (a.dead.has(id)) throw new OpError(`purge: ${id} is deleted; restore it first`);
      }
      const side = op.axis === "row" ? 0 : 1;
      for (const m of [s.cells, s.formats])
        for (const k of m.keys()) if (ids.has(splitCellKey(k)[side])) throw new OpError(`purge: ${k} is not empty`);
      if (op.axis === "col")
        for (const [type, l] of s.layouts) if (l.some((c) => ids.has(c.col))) throw new OpError(`purge: the ${type} layout uses a column being removed`);
      // The purged IDs need not be contiguous (a rebase may have put rows between them),
      // so the inverse re-inserts each after its own predecessor.
      const inverse: Op[] = [];
      for (const id of op.ids) {
        const i = a.order.indexOf(id);
        inverse.unshift({ kind: "insert", sheet: op.sheet, axis: op.axis, after: i > 0 ? a.order[i - 1]! : null, ids: [id] });
        a.order.splice(i, 1);
      }
      a.index = undefined;
      return inverse;
    }
    case "delete": {
      const s = sheetOf(doc, op.sheet);
      const a = axisOf(s, op.axis);
      const sys = op.axis === "col" ? systemCols(s) : [];
      for (const id of op.ids) {
        if (!isLive(a, id)) throw new OpError(`delete: ${id} is not there`);
        if (sys.includes(id)) throw new OpError("delete: columns A and B of a data sheet can't be deleted");
      }
      for (const id of op.ids) a.dead.add(id);
      return [{ kind: "restore", sheet: op.sheet, axis: op.axis, ids: [...op.ids] }];
    }
    case "restore": {
      const s = sheetOf(doc, op.sheet);
      const a = axisOf(s, op.axis);
      for (const id of op.ids) if (!a.dead.has(id)) throw new OpError(`restore: ${id} is not deleted`);
      for (const id of op.ids) a.dead.delete(id);
      return [{ kind: "delete", sheet: op.sheet, axis: op.axis, ids: [...op.ids] }];
    }
    case "move": {
      const s = sheetOf(doc, op.sheet);
      const a = axisOf(s, op.axis);
      const sys = op.axis === "col" ? systemCols(s) : [];
      if (!op.ids.length) throw new OpError("move: no IDs");
      if (new Set(op.ids).size !== op.ids.length) throw new OpError("move: an ID is listed twice");
      for (const id of op.ids) {
        if (!hasId(a, id)) throw new OpError(`move: ${id} is not there`); // tombstones move too, unseen
        if (sys.includes(id)) throw new OpError("move: columns A and B of a data sheet can't be moved");
      }
      if (op.after !== null && op.ids.includes(op.after)) throw new OpError("move: the anchor is one of the moving IDs");
      if (op.after !== null && !hasId(a, op.after)) throw new OpError(`move: no anchor ${op.after}`);
      const rest = a.order.filter((id) => !op.ids.includes(id));
      checkPlacement(s, op.axis, rest, op.after, "move");
      // The inverse moves each ID back after its old predecessor, last-moved first.
      const inverse: Op[] = [];
      op.ids.forEach((id, j) => {
        const i = a.order.indexOf(id);
        inverse.unshift({ kind: "move", sheet: op.sheet, axis: op.axis, after: i > 0 ? a.order[i - 1]! : null, ids: [id] });
        a.order.splice(i, 1);
        a.order.splice(anchorIndex(a.order, op.after) + 1 + j, 0, id);
      });
      a.index = undefined;
      return inverse;
    }
    case "createSheet": {
      if (doc.sheets.has(op.sheet)) throw new OpError(`createSheet: ${op.sheet} exists`);
      if (!doc.packs.has(op.pack)) throw new OpError(`createSheet: no pack ${op.pack}`);
      checkSheetName(doc, op.pack, op.name, null);
      if (op.after != null && !doc.sheets.has(op.after)) throw new OpError(`createSheet: no sheet ${op.after} to go after`);
      const c = op.contents;
      if (c) {
        const ids = (a: { order: string[]; dead: string[] }) => new Set(a.order);
        const rows = ids(c.rows);
        const cols = ids(c.cols);
        if (rows.size !== c.rows.order.length || cols.size !== c.cols.order.length) throw new OpError("createSheet: a row or column is listed twice");
        for (const [k] of [...c.cells, ...c.formats]) {
          const [r, col] = splitCellKey(k);
          if (!rows.has(r) || !cols.has(col)) throw new OpError(`createSheet: cell ${k} is on no row or column`);
        }
      }
      doc.sheets.set(op.sheet, {
        id: op.sheet, name: op.name, pack: op.pack, kind: op.sheetKind,
        rows: { order: c ? [...c.rows.order] : [], dead: new Set(c?.rows.dead) }, cols: { order: c ? [...c.cols.order] : [], dead: new Set(c?.cols.dead) },
        cells: new Map(c?.cells), formats: new Map(c?.formats.map(([k, f]) => [k, { ...f }])), layouts: new Map(c?.layouts), rowFlags: new Map(c?.rowFlags.map(([r, f]) => [r, new Set(f)])),
      });
      if (op.after !== undefined) placeInMap(doc.sheets, op.sheet, op.after, () => true);
      return [{ kind: "removeSheet", sheet: op.sheet }];
    }
    case "removeSheet": {
      const s = sheetOf(doc, op.sheet);
      const contents = sheetContents(s);
      const after = siblingBefore(doc.sheets, op.sheet, () => true);
      doc.sheets.delete(op.sheet);
      return [{ kind: "createSheet", sheet: s.id, name: s.name, pack: s.pack, sheetKind: s.kind, after, ...(contents ? { contents } : {}) }];
    }
    case "orderSheet": {
      const s = doc.sheets.get(op.sheet);
      if (!s) throw new OpError(`orderSheet: no sheet ${op.sheet}`);
      if (op.after === op.sheet) throw new OpError("orderSheet: a sheet can't go after itself");
      const inPack = (x: SheetDoc) => x.pack === s.pack;
      if (op.after !== null && doc.sheets.get(op.after)?.pack !== s.pack) throw new OpError(`orderSheet: ${op.after} is not a sheet of the same pack`);
      const prev = siblingBefore(doc.sheets, op.sheet, inPack);
      placeInMap(doc.sheets, op.sheet, op.after, inPack);
      return [{ ...op, after: prev }];
    }
    case "renameSheet": {
      const s = sheetOf(doc, op.sheet);
      checkSheetName(doc, s.pack, op.name, s.id);
      const prev = s.name;
      s.name = op.name;
      return [{ ...op, name: prev }];
    }
    case "setSheetPack": {
      const s = sheetOf(doc, op.sheet);
      if (!doc.packs.has(op.pack)) throw new OpError(`setSheetPack: no pack ${op.pack}`);
      checkSheetName(doc, op.pack, s.name, s.id);
      const prev = s.pack;
      s.pack = op.pack;
      return [{ ...op, pack: prev }];
    }
    case "setRowFlag": {
      const s = sheetOf(doc, op.sheet);
      if (!hasId(s.rows, op.row)) throw new OpError(`setRowFlag: no row ${op.row}`);
      const flags = s.rowFlags.get(op.row);
      const was = flags?.has(op.flag) ?? false;
      if (op.on) s.rowFlags.set(op.row, new Set([...(flags ?? []), op.flag]));
      else if (flags) {
        const left = new Set([...flags].filter((f) => f !== op.flag));
        if (left.size) s.rowFlags.set(op.row, left);
        else s.rowFlags.delete(op.row);
      }
      return [{ ...op, on: was }];
    }
    case "setLayout": {
      const s = sheetOf(doc, op.sheet);
      if (s.kind !== "data") throw new OpError("setLayout: only data sheets have layouts");
      for (const c of op.layout ?? []) if (!hasId(s.cols, c.col)) throw new OpError(`setLayout: no column ${c.col}`);
      if (op.layout?.some((c) => systemCols(s).includes(c.col))) throw new OpError("setLayout: columns A and B hold the type and ID");
      const prev = s.layouts.get(op.type) ?? null;
      if (op.layout === null) s.layouts.delete(op.type);
      else s.layouts.set(op.type, op.layout.map((c) => ({ ...c, path: [...c.path] })));
      return [{ ...op, layout: prev }];
    }
    case "createPack": {
      if (doc.packs.has(op.pack)) throw new OpError(`createPack: ${op.pack} exists`);
      if (!doc.packs.has(op.parent)) throw new OpError(`createPack: no parent ${op.parent}`);
      checkPackName(doc, op.name);
      if (op.after != null && doc.packs.get(op.after)?.parent !== op.parent) throw new OpError(`createPack: ${op.after} is not a pack of that parent`);
      doc.packs.set(op.pack, { id: op.pack, name: op.name, parent: op.parent });
      if (op.after !== undefined) placeInMap(doc.packs, op.pack, op.after, (x) => x.parent === op.parent);
      return [{ kind: "removePack", pack: op.pack }];
    }
    case "removePack": {
      const p = doc.packs.get(op.pack);
      if (!p) throw new OpError(`removePack: no pack ${op.pack}`);
      if (p.parent === null) throw new OpError("removePack: the root pack stays");
      for (const s of doc.sheets.values()) if (s.pack === op.pack) throw new OpError(`removePack: ${p.name} still has sheets`);
      for (const q of doc.packs.values()) if (q.parent === op.pack) throw new OpError(`removePack: ${p.name} still has packs`);
      const after = siblingBefore(doc.packs, op.pack, (x) => x.parent === p.parent);
      doc.packs.delete(op.pack);
      return [{ kind: "createPack", pack: p.id, name: p.name, parent: p.parent, after }];
    }
    case "orderPack": {
      const p = doc.packs.get(op.pack);
      if (!p) throw new OpError(`orderPack: no pack ${op.pack}`);
      if (p.parent === null) throw new OpError("orderPack: the root pack has no siblings");
      if (op.after === op.pack) throw new OpError("orderPack: a pack can't go after itself");
      if (op.after !== null && doc.packs.get(op.after)?.parent !== p.parent) throw new OpError(`orderPack: ${op.after} is not a pack with the same parent`);
      const sib = (x: { parent: PackId | null }) => x.parent === p.parent;
      const prev = siblingBefore(doc.packs, op.pack, sib);
      placeInMap(doc.packs, op.pack, op.after, sib);
      return [{ ...op, after: prev }];
    }
    case "renamePack": {
      const p = doc.packs.get(op.pack);
      if (!p) throw new OpError(`renamePack: no pack ${op.pack}`);
      if (p.name !== op.name) checkPackName(doc, op.name);
      const prev = p.name;
      p.name = op.name;
      return [{ ...op, name: prev }];
    }
    case "setPackParent": {
      const p = doc.packs.get(op.pack);
      if (!p) throw new OpError(`setPackParent: no pack ${op.pack}`);
      if (p.parent === null) throw new OpError("The root pack has no parent");
      if (!doc.packs.has(op.parent)) throw new OpError(`setPackParent: no pack ${op.parent}`);
      for (let q: PackId | null = op.parent; q !== null; q = doc.packs.get(q)?.parent ?? null)
        if (q === op.pack) throw new OpError(`A pack can't go inside itself: ${doc.packs.get(op.parent)!.name} is ${op.parent === op.pack ? "" : "inside "}${p.name}`);
      const prev = p.parent;
      p.parent = op.parent;
      return [{ ...op, parent: prev }];
    }
    case "addSchema":
      doc.schema = addNode(doc.schema, op.parent, op.def, op.after);
      return [{ kind: "removeSchema", id: op.def.id }];
    case "removeSchema": {
      const r = removeNode(doc.schema, op.id);
      doc.schema = r.schema;
      return [{ kind: "addSchema", parent: r.parent, def: r.def, after: r.after }];
    }
    case "setSchema": {
      const r = setNodeProp(doc.schema, op.id, op.key, op.value);
      if (r.schema === doc.schema) return [];
      doc.schema = r.schema;
      return [r.prev === undefined ? { kind: "setSchema", id: op.id, key: op.key } : { kind: "setSchema", id: op.id, key: op.key, value: r.prev }];
    }
    case "renameId":
    case "renameType":
    case "renameField":
    case "renameEnumMember":
      return applyOp(doc, op);
  }
}

function checkSheetName(doc: Doc, pack: PackId, name: string, self: SheetId | null): void {
  if (!name.trim()) throw new OpError("A sheet needs a name");
  const lower = name.toLowerCase();
  for (const s of doc.sheets.values())
    if (s.id !== self && s.pack === pack && s.name.toLowerCase() === lower) throw new OpError(`There is already a sheet called ${s.name} in this pack`);
}

function checkPackName(doc: Doc, name: string): void {
  if (!name.trim()) throw new OpError("A pack needs a name");
  for (const p of doc.packs.values()) if (p.name === name) throw new OpError(`There is already a pack called ${name}`);
}
