// Rebase a task's ops ("mine") onto a branch head that has moved on ("theirs"). Both
// sequences were written against the same base. This is S3's algorithm on the real
// document; docs/spikes/S3-op-rebase.md has the reasoning.
//
// Conflicts are decided on each side's net effect, a three-way comparison of base,
// mine and theirs, so writing a cell and then writing it back is not a change. The
// rebased ops are then produced op by op against the head, so a task keeps its own
// history (undo, per-op blame):
//
//  - Cell writes on cells theirs also changed are dropped, then re-added as a fix-up
//    only where a conflict is resolved for mine.
//  - Inserts and moves keep their anchor row. Rows theirs placed at the same anchor
//    stay first: the earlier-landed side goes first (DESIGN §8.5).
//  - renameId is an intent op (§8.2). It is re-run against the head, so it also
//    rewrites references theirs added.
//  - Formats are last-write-wins, and mine lands last.
//  - Sheet, pack and layout ops are last-write-wins too. One that no longer applies
//    (say, a sheet name theirs took) is dropped and reported as an `op` conflict.
//  - Schema ops work like cells and rows, on schema nodes by stable ID: one property
//    changed differently by both sides conflicts, and so does a definition or field one
//    side removed and the other changed. Lists of names (enum members, traits, union
//    variants) merge item by item instead, so two tasks adding members keep both.
//    Fields added at the same place keep the earlier-landed side first. renameType,
//    renameField and renameEnumMember are intent ops, re-run on the head.

import { contentKey, stableJson, type Content } from "../formula/content.ts";
import type { SheetId } from "../formula/model.ts";
import {
  axisOf, cellKey, cloneDoc, hasId, isLive, splitCellKey,
  type Axis, type Doc, type Format, type SheetDoc,
} from "./doc.ts";
import { applyOp, OpError, type Op } from "./ops.ts";
import type { Id } from "../schema/model.ts";
import { isSection, LIST_KEYS, mapDefNames, mergeList, propsOf, schemaNodes, siblings, subtreeIds, type SchemaParent } from "./schema.ts";

export type Side = "mine" | "theirs";

export type Conflict =
  | { kind: "cell"; sheet: SheetId; row: string; col: string; base: Content; mine: Content; theirs: Content }
  | { kind: "deleted"; sheet: SheetId; axis: Axis; id: string; deletedBy: Side }
  | { kind: "move"; sheet: SheetId; axis: Axis; id: string; mine: string | null; theirs: string | null }
  | { kind: "rename"; from: string; mine: string; theirs: string }
  /** Both sides set one property of a schema node (a field's type, a type's name�) differently. */
  | { kind: "schema"; id: Id; key: string; base: unknown; mine: unknown; theirs: unknown }
  /** One side removed a schema definition or field that the other changed (or added fields to). */
  | { kind: "schemaDeleted"; id: Id; deletedBy: Side }
  /** Both sides renamed the same enum member to different names. */
  | { kind: "enumRename"; enum: Id; from: string; mine: string; theirs: string }
  /** One of mine's ops no longer applies on the head. It is dropped. */
  | { kind: "op"; op: Op; message: string };

export type Resolve = (c: Conflict) => Side;

/** What one side's ops did, relative to the base. */
export interface Analysis {
  final: Doc;
  /** Net cell changes: `${sheet}/${row}|${col}` -> final content. */
  cells: Map<string, Content>;
  formats: Map<string, Format | null>;
  /** `${sheet}/${axis}/${id}` for base rows and columns that are gone (deleted or purged). */
  deleted: Set<string>;
  /** Base rows and columns with a net cell change, or that were moved. */
  edited: Set<string>;
  /** Moved base rows and columns -> the anchor of their last move. */
  moved: Map<string, string | null>;
  /** Every row or column placed by an insert or move -> the anchor it was placed at. */
  placed: Map<string, string | null>;
  /** Base ID -> what it was finally renamed to. */
  renames: Map<string, string>;
  /** Net changes to properties of base schema nodes: `${id}#${key}` -> final value (undefined: cleared). */
  schema: Map<string, unknown>;
  /** Base schema nodes that are gone. */
  schemaDeleted: Set<Id>;
  /** Schema nodes with a net change of their own or to their fields (added ones included). */
  schemaEdited: Set<Id>;
  /** Schema nodes added -> the sibling they were added after. */
  schemaPlaced: Map<Id, Id | null>;
  /** `${enum}/${base member}` -> what it was finally renamed to. */
  enumRenames: Map<string, string>;
}

const axisKey = (sheet: SheetId, axis: Axis, id: string) => `${sheet}/${axis}/${id}`;
const cellAt = (sheet: SheetId, row: string, col: string) => `${sheet}/${cellKey(row, col)}`;
const splitAt = (k: string): [SheetId, string] => {
  const i = k.indexOf("/");
  return [k.slice(0, i), k.slice(i + 1)];
};
const START = "^"; // the anchor "before everything"

export function analyze(base: Doc, ops: readonly Op[]): Analysis {
  const final = cloneDoc(base);
  const moved = new Map<string, string | null>();
  const placed = new Map<string, string | null>();
  const renames = new Map<string, string>(); // current name -> base name
  const enumRenames = new Map<string, string>(); // `${enum}/${current}` -> base member
  const schemaPlaced = new Map<Id, Id | null>();
  for (const op of ops) {
    if (op.kind === "addSchema") schemaPlaced.set(op.def.id, op.after);
    if (op.kind === "renameEnumMember") {
      const origin = enumRenames.get(`${op.enum}/${op.from}`) ?? op.from;
      enumRenames.delete(`${op.enum}/${op.from}`);
      enumRenames.set(`${op.enum}/${op.to}`, origin);
    }
    if (op.kind === "move" || op.kind === "insert") {
      const b = base.sheets.get(op.sheet);
      for (const id of op.ids) {
        placed.set(axisKey(op.sheet, op.axis, id), op.after);
        if (op.kind === "move" && b && hasId(axisOf(b, op.axis), id)) moved.set(axisKey(op.sheet, op.axis, id), op.after);
      }
    }
    if (op.kind === "renameId") {
      const origin = renames.get(op.from) ?? op.from;
      renames.delete(op.from);
      renames.set(op.to, origin);
    }
    applyOp(final, op);
  }

  const cells = new Map<string, Content>();
  const formats = new Map<string, Format | null>();
  const deleted = new Set<string>();
  const edited = new Set<string>();
  for (const [id, b] of base.sheets) {
    const f = final.sheets.get(id);
    if (!f) continue;
    for (const axis of ["row", "col"] as const)
      for (const x of axisOf(b, axis).order)
        if (!axisOf(b, axis).dead.has(x) && !isLive(axisOf(f, axis), x)) deleted.add(axisKey(id, axis, x));
    for (const k of new Set([...b.cells.keys(), ...f.cells.keys()])) {
      const v = f.cells.get(k) ?? null;
      if (contentKey(v) === contentKey(b.cells.get(k) ?? null)) continue;
      cells.set(`${id}/${k}`, v);
      const [r, c] = splitCellKey(k);
      edited.add(axisKey(id, "row", r));
      edited.add(axisKey(id, "col", c));
    }
    for (const k of new Set([...b.formats.keys(), ...f.formats.keys()])) {
      const v = f.formats.get(k) ?? null;
      if (stableJson(v) !== stableJson(b.formats.get(k) ?? null)) formats.set(`${id}/${k}`, v);
    }
  }
  for (const k of moved.keys()) edited.add(k);
  const finalRenames = new Map<string, string>();
  for (const [to, from] of renames) if (to !== from) finalRenames.set(from, to);
  const finalEnumRenames = new Map<string, string>();
  for (const [k, from] of enumRenames) {
    const [e, to] = splitAt(k);
    if (to !== from) finalEnumRenames.set(`${e}/${from}`, to);
  }
  return { final, cells, formats, deleted, edited, moved, placed, renames: finalRenames, ...schemaDiff(base, final), schemaPlaced, enumRenames: finalEnumRenames };
}

/** What changed in the schema between two documents, node by node. */
function schemaDiff(base: Doc, final: Doc): Pick<Analysis, "schema" | "schemaDeleted" | "schemaEdited"> {
  const b = schemaNodes(base.schema);
  const f = schemaNodes(final.schema);
  const schema = new Map<string, unknown>();
  const schemaDeleted = new Set<Id>();
  const schemaEdited = new Set<Id>();
  const edit = (id: Id, parent: SchemaParent) => {
    schemaEdited.add(id);
    if (!isSection(parent)) schemaEdited.add(parent);
  };
  for (const [id, bn] of b) {
    const fn = f.get(id);
    if (!fn) {
      schemaDeleted.add(id);
      continue;
    }
    const bp = propsOf(bn.def);
    const fp = propsOf(fn.def);
    for (const k of new Set([...Object.keys(bp), ...Object.keys(fp)]))
      if (stableJson(bp[k]) !== stableJson(fp[k])) {
        schema.set(`${id}#${k}`, fp[k]);
        edit(id, bn.parent);
      }
  }
  for (const [id, fn] of f) if (!b.has(id) && !isSection(fn.parent)) edit(fn.parent, "types");
  return { schema, schemaDeleted, schemaEdited };
}

/** The conflicts of DESIGN §8.5, from both sides' net effects. Symmetric in the two sides. */
export function detect(mine: Analysis, theirs: Analysis, base: Doc): Conflict[] {
  const out: Conflict[] = [];
  const goneEither = (k: string) => mine.deleted.has(k) || theirs.deleted.has(k);

  for (const [k, m] of mine.cells) {
    const t = theirs.cells.get(k);
    if (t === undefined || contentKey(t) === contentKey(m)) continue;
    const [sh, rc] = splitAt(k);
    const [row, col] = splitCellKey(rc);
    if (goneEither(axisKey(sh, "row", row)) || goneEither(axisKey(sh, "col", col))) continue;
    out.push({ kind: "cell", sheet: sh, row, col, base: base.sheets.get(sh)?.cells.get(rc) ?? null, mine: m, theirs: t });
  }
  for (const [by, other, side] of [[theirs, mine, "theirs"], [mine, theirs, "mine"]] as const)
    for (const k of by.deleted) {
      if (other.deleted.has(k) || !other.edited.has(k)) continue;
      const [sh, axis, id] = k.split("/") as [string, Axis, string];
      out.push({ kind: "deleted", sheet: sh, axis, id, deletedBy: side });
    }
  for (const [k, m] of mine.moved) {
    if (!theirs.moved.has(k) || goneEither(k)) continue;
    const t = theirs.moved.get(k)!;
    if (t === m) continue;
    const [sh, axis, id] = k.split("/") as [string, Axis, string];
    out.push({ kind: "move", sheet: sh, axis, id, mine: m, theirs: t });
  }
  for (const [from, m] of mine.renames) {
    const t = theirs.renames.get(from);
    if (t !== undefined && t !== m) out.push({ kind: "rename", from, mine: m, theirs: t });
  }

  // Schema: properties, then removals against changes, then enum member renames.
  const nodes = schemaNodes(base.schema);
  const goneSchema = (id: Id) => mine.schemaDeleted.has(id) || theirs.schemaDeleted.has(id);
  for (const [k, m] of mine.schema) {
    if (!theirs.schema.has(k)) continue;
    const t = theirs.schema.get(k);
    const i = k.lastIndexOf("#");
    const id = k.slice(0, i);
    const key = k.slice(i + 1);
    if (LIST_KEYS.has(key) || stableJson(t) === stableJson(m) || goneSchema(id)) continue;
    out.push({ kind: "schema", id, key, base: nodes.get(id)!.def[key], mine: m, theirs: t });
  }
  for (const [by, other, side] of [[theirs, mine, "theirs"], [mine, theirs, "mine"]] as const)
    for (const id of by.schemaDeleted) {
      if (other.schemaDeleted.has(id) || !other.schemaEdited.has(id)) continue;
      const parent = nodes.get(id)!.parent;
      if (!isSection(parent) && by.schemaDeleted.has(parent)) continue; // reported on the definition
      out.push({ kind: "schemaDeleted", id, deletedBy: side });
    }
  for (const [k, m] of mine.enumRenames) {
    const t = theirs.enumRenames.get(k);
    if (t === undefined || t === m) continue;
    const [e, from] = splitAt(k);
    out.push({ kind: "enumRename", enum: e, from, mine: m, theirs: t });
  }
  return out;
}

/** A side-independent name for a conflict, for comparing detections. */
export function conflictId(c: Conflict, swap = false): string {
  const side = (s: Side): Side => (swap ? (s === "mine" ? "theirs" : "mine") : s);
  switch (c.kind) {
    case "cell":
      return `cell ${c.sheet}/${c.row}|${c.col}`;
    case "deleted":
      return `deleted ${c.sheet}/${c.axis}/${c.id} by ${side(c.deletedBy)}`;
    case "move":
      return `move ${c.sheet}/${c.axis}/${c.id}`;
    case "rename":
      return `rename ${c.from}`;
    case "schema":
      return `schema ${c.id}#${c.key}`;
    case "schemaDeleted":
      return `schemaDeleted ${c.id} by ${side(c.deletedBy)}`;
    case "enumRename":
      return `enumRename ${c.enum}/${c.from}`;
    case "op":
      return `op ${stableJson(c.op)}`;
  }
}

export interface RebaseResult {
  /** Mine, rewritten to apply on top of theirs. */
  ops: Op[];
  conflicts: Conflict[];
  /** The head with the rebased ops applied. */
  state: Doc;
}

/**
 * Rebase `mine` onto `theirs`; both were written against `base`. Each conflict is
 * settled by `resolve` (default: keep theirs, i.e. the head as landed).
 */
export function rebase(base: Doc, theirs: readonly Op[], mine: readonly Op[], resolve: Resolve = () => "theirs"): RebaseResult {
  const T = analyze(base, theirs);
  const M = analyze(base, mine);
  const conflicts = detect(M, T, base);
  const cur = cloneDoc(T.final);
  const out: Op[] = [];
  const emit = (op: Op) => {
    applyOp(cur, op);
    out.push(op);
  };
  const sheetOf = (id: SheetId): SheetDoc | undefined => cur.sheets.get(id);

  const noDelete = new Set<string>(); // rows and columns mine must not delete or purge
  const noMove = new Set<string>(); // ... or move
  const restore: { sheet: SheetId; axis: Axis; id: string }[] = [];
  const renameSwap = new Map<string, Op | null>(); // mine's renames: replaced or dropped
  const swapped = new Set<string>();
  const fixups: Extract<Conflict, { kind: "cell" }>[] = [];
  const schemaFixups: Extract<Conflict, { kind: "schema" }>[] = [];
  const schemaSide = new Map<string, Side>(); // `${id}#${key}` -> the side that won it
  const schemaKeep = new Set<Id>(); // schema nodes mine must not remove
  const schemaRestore: Id[] = []; // ... or must bring back
  const enumSwap = new Map<string, Op | null>();
  for (const c of conflicts) {
    const side = resolve(c);
    if (c.kind === "schema") {
      schemaFixups.push(side === "mine" ? c : { ...c, mine: c.theirs });
      schemaSide.set(`${c.id}#${c.key}`, side);
    } else if (c.kind === "schemaDeleted") {
      if (c.deletedBy === "theirs" && side === "mine") schemaRestore.push(c.id);
      if (c.deletedBy === "mine" && side === "theirs") for (const id of subtreeIds(schemaNodes(base.schema).get(c.id)!.def)) schemaKeep.add(id);
    } else if (c.kind === "enumRename")
      enumSwap.set(`${c.enum}/${c.from}`, side === "theirs" ? null : { kind: "renameEnumMember", enum: c.enum, from: c.theirs, to: c.mine });
    if (c.kind === "cell") fixups.push(side === "mine" ? c : { ...c, mine: c.theirs });
    else if (c.kind === "deleted") {
      if (c.deletedBy === "theirs" && side === "mine") restore.push(c);
      if (c.deletedBy === "mine" && side === "theirs") noDelete.add(axisKey(c.sheet, c.axis, c.id)); // keep the row
    } else if (c.kind === "move") {
      if (side === "theirs") noMove.add(axisKey(c.sheet, c.axis, c.id));
    } else if (c.kind === "rename") renameSwap.set(c.from, side === "theirs" ? null : { kind: "renameId", from: c.theirs, to: c.mine });
  }
  // Both moved it to the same place: nothing left for mine to do.
  for (const [k, m] of M.moved) if (T.moved.has(k) && T.moved.get(k) === m) noMove.add(k);

  // Rows theirs deleted that mine resolved to keep come back first, with their cells.
  for (const r of restore) {
    const s = sheetOf(r.sheet);
    if (s && axisOf(s, r.axis).dead.has(r.id)) emit({ kind: "restore", sheet: r.sheet, axis: r.axis, ids: [r.id] });
  }

  // Schema nodes theirs removed that mine resolved to keep come back as they were in the base.
  const curHas = (id: Id) => schemaNodes(cur.schema).has(id);
  const parentHere = (p: SchemaParent) => isSection(p) || curHas(p);
  const ctx = cloneDoc(base); // the document as mine saw it when writing each op
  for (const id of schemaRestore) {
    const n = schemaNodes(base.schema).get(id)!;
    if (!curHas(id) && parentHere(n.parent)) emit({ kind: "addSchema", parent: n.parent, def: n.def, after: placeSchema(cur, ctx, T, n.parent, before(base, n.parent, id)) });
  }
  const swappedSchema = new Set<string>();
  const mineRenamed = new Map<Id, "renameType" | "renameField">(); // replayed renames, by node
  const enumBase = new Map<string, string>(); // `${enum}/${mine's current}` -> base member
  // A definition name in one of mine's schema values names, as mine saw it, some
  // definition; on the head it is called whatever that one is called now (theirs may have
  // renamed it). Mine's own renames are re-run, so they need nothing here.
  const nowNamed = (parent: SchemaParent, key: string | null, value: unknown): unknown => {
    const ctxNames = new Map<string, Id>();
    for (const [id, n] of schemaNodes(ctx.schema)) if (isSection(n.parent) && n.parent !== "rules") ctxNames.set(n.def.name as string, id);
    const here = schemaNodes(cur.schema);
    return mapDefNames(parent, key, value, (name) => {
      const id = ctxNames.get(name);
      const now = id === undefined ? undefined : here.get(id)?.def.name;
      return typeof now === "string" ? now : name;
    });
  };
  const tryEmit = (op: Op) => {
    try {
      emit(op);
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      conflicts.push({ kind: "op", op, message: e.message });
    }
  };

  const live = (sheet: SheetId, row: string, col: string) => {
    const s = sheetOf(sheet);
    return !!s && isLive(s.rows, row) && isLive(s.cols, col);
  };
  const baseName = new Map<string, string>(); // mine's current name -> base name, for renames
  const mineMoved = new Set<string>(); // rows mine' really moved on the head
  const ctxMoved = new Set<string>(); // rows mine moved as written
  const place = (sh: SheetId, axis: Axis, after: string | null, moving: string[]) => {
    const at = anchor(cur, ctx, T, (k) => (T.moved.has(k) || ctxMoved.has(k)) && !mineMoved.has(k), sh, axis, after, moving);
    for (const id of moving) mineMoved.add(axisKey(sh, axis, id));
    return at;
  };
  for (const op of mine) {
    switch (op.kind) {
      case "setCell": {
        // Cells theirs changed are settled by the fix-ups, unless theirs deleted the row or
        // column and mine chose to keep it: then mine's writes apply as made.
        const restored = T.deleted.has(axisKey(op.sheet, "row", op.row)) || T.deleted.has(axisKey(op.sheet, "col", op.col));
        const k = cellAt(op.sheet, op.row, op.col);
        if (T.cells.has(k) && !(restored && M.cells.has(k))) break;
        if (live(op.sheet, op.row, op.col)) emit(op);
        break;
      }
      case "setFormat":
        // Last write wins, but only for a real change: a format set and then cleared must not wipe theirs.
        if (M.formats.has(cellAt(op.sheet, op.row, op.col)) && live(op.sheet, op.row, op.col)) emit(op);
        break;
      case "insert":
        if (sheetOf(op.sheet)) emit({ ...op, after: place(op.sheet, op.axis, op.after, []) });
        break;
      case "move": {
        const s = sheetOf(op.sheet);
        const ids = s ? op.ids.filter((id) => isLive(axisOf(s, op.axis), id) && !noMove.has(axisKey(op.sheet, op.axis, id))) : [];
        if (ids.length) emit({ ...op, ids, after: place(op.sheet, op.axis, op.after, ids) });
        break;
      }
      case "delete": {
        const s = sheetOf(op.sheet);
        const ids = s ? op.ids.filter((id) => isLive(axisOf(s, op.axis), id) && !noDelete.has(axisKey(op.sheet, op.axis, id))) : [];
        if (ids.length) emit({ ...op, ids });
        break;
      }
      case "purge": {
        const s = sheetOf(op.sheet);
        if (!s) break;
        const a = axisOf(s, op.axis);
        const present = op.ids.filter((id) => hasId(a, id) && !noDelete.has(axisKey(op.sheet, op.axis, id)));
        // Rows theirs wrote into can't be purged without losing data: delete them instead.
        const side = op.axis === "row" ? 0 : 1;
        const busy = (id: string) =>
          [...s.cells.keys(), ...s.formats.keys()].some((k) => splitCellKey(k)[side] === id) ||
          (op.axis === "col" && [...s.layouts.values()].some((l) => l.some((c) => c.col === id)));
        const purge = present.filter((id) => !busy(id) && !a.dead.has(id));
        const del = present.filter((id) => busy(id) && !a.dead.has(id));
        if (purge.length) emit({ ...op, ids: purge });
        if (del.length) emit({ kind: "delete", sheet: op.sheet, axis: op.axis, ids: del });
        break;
      }
      case "restore": {
        const s = sheetOf(op.sheet);
        const ids = s ? op.ids.filter((id) => axisOf(s, op.axis).dead.has(id)) : [];
        if (ids.length) emit({ ...op, ids });
        break;
      }
      case "renameId": {
        const origin = baseName.get(op.from) ?? op.from;
        baseName.delete(op.from);
        baseName.set(op.to, origin);
        const swap = renameSwap.get(origin);
        if (swap === undefined) emit(op);
        else if (swap !== null && !swapped.has(origin)) {
          emit(swap); // once for the whole chain a -> b -> c
          swapped.add(origin);
        }
        break;
      }
      case "setSchema": {
        // Gone on the head: theirs removed it (a conflict, if mine changed it).
        const now = schemaNodes(cur.schema).get(op.id);
        if (!now) break;
        if (LIST_KEYS.has(op.key)) {
          const was = schemaNodes(ctx.schema).get(op.id)?.def[op.key];
          // Mine removing an item it added itself mustn't take away the same item theirs added.
          const baseList = asList(schemaNodes(base.schema).get(op.id)?.def[op.key]).map(itemName);
          const theirsAdded = new Set(asList(schemaNodes(T.final.schema).get(op.id)?.def[op.key]).map(itemName).filter((k) => !baseList.includes(k)));
          const merged = mergeList(asList(was), asList(op.value), asList(now.def[op.key]), theirsAdded);
          if (stableJson(merged) !== stableJson(now.def[op.key] ?? [])) emit({ kind: "setSchema", id: op.id, key: op.key, value: merged });
          break;
        }
        if (T.schema.has(`${op.id}#${op.key}`)) break; // settled by the fix-ups
        if (!("value" in op)) emit(op);
        else emit({ ...op, value: nowNamed(now.parent, op.key, op.value) });
        break;
      }
      case "addSchema":
        if (parentHere(op.parent))
          tryEmit({ ...op, def: nowNamed(op.parent, null, op.def) as typeof op.def, after: placeSchema(cur, ctx, T, op.parent, op.after) });
        break;
      case "removeSchema":
        if (curHas(op.id) && !schemaKeep.has(op.id)) emit(op);
        break;
      case "renameType":
      case "renameField": {
        if (!curHas(op.id)) break;
        const k = `${op.id}#name`;
        const side = schemaSide.get(k);
        if (side === "theirs") break;
        if (side === "mine") {
          // Once, straight to mine's final name.
          if (swappedSchema.has(k)) break;
          swappedSchema.add(k);
          tryEmit({ ...op, name: M.schema.get(k) as string });
        } else {
          tryEmit(op);
          mineRenamed.set(op.id, op.kind);
        }
        break;
      }
      case "renameEnumMember": {
        const origin = enumBase.get(`${op.enum}/${op.from}`) ?? op.from;
        enumBase.delete(`${op.enum}/${op.from}`);
        enumBase.set(`${op.enum}/${op.to}`, origin);
        const swap = enumSwap.get(`${op.enum}/${origin}`);
        // A chain of mine's that ends where it began (fire -> x -> fire) changes nothing; if
        // theirs renamed that member, replaying it would only fail.
        if (!M.enumRenames.has(`${op.enum}/${origin}`) && T.enumRenames.has(`${op.enum}/${origin}`)) break;
        if (swap === undefined) tryEmit(op);
        else if (swap !== null && !swappedSchema.has(`${op.enum}/${origin}`)) {
          tryEmit(swap);
          swappedSchema.add(`${op.enum}/${origin}`);
        }
        break;
      }
      default:
        // Sheet, pack and layout ops: last write wins, if they still apply.
        tryEmit(op);
    }
    if (op.kind === "move") for (const id of op.ids) ctxMoved.add(axisKey(op.sheet, op.axis, id));
    applyOp(ctx, op);
  }

  // Settle conflicted cells explicitly: a re-run rename may have touched them.
  for (const c of fixups) {
    if (!live(c.sheet, c.row, c.col)) continue;
    const now = sheetOf(c.sheet)!.cells.get(cellKey(c.row, c.col)) ?? null;
    if (contentKey(now) !== contentKey(c.mine)) emit({ kind: "setCell", sheet: c.sheet, row: c.row, col: c.col, content: c.mine });
  }
  // Mine renamed something and back again (net, no rename), while theirs renamed it: the
  // replayed renames took theirs' name away, so it comes back, rewriting as a rename does.
  for (const [id, kind] of mineRenamed) {
    const k = `${id}#name`;
    const want = schemaNodes(T.final.schema).get(id)?.def.name;
    const now = schemaNodes(cur.schema).get(id)?.def.name;
    if (!M.schema.has(k) && T.schema.has(k) && typeof want === "string" && now !== undefined && now !== want) tryEmit({ kind, id, name: want });
  }
  for (const c of schemaFixups) {
    const n = schemaNodes(cur.schema).get(c.id);
    if (!n || stableJson(n.def[c.key]) === stableJson(c.mine)) continue;
    emit(c.mine === undefined ? { kind: "setSchema", id: c.id, key: c.key } : { kind: "setSchema", id: c.id, key: c.key, value: c.mine });
  }
  return { ops: out, conflicts, state: cur };
}

const asList = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const itemName = (x: unknown): string => (typeof x === "string" ? x : String((x as { name?: unknown })?.name));

/** The sibling before a schema node, in a document. */
function before(doc: Doc, parent: SchemaParent, id: Id): Id | null {
  const list = siblings(doc.schema, parent);
  const i = list.findIndex((d) => d.id === id);
  return i > 0 ? list[i - 1]!.id : null;
}

/**
 * Where a schema node added after `after` goes on the head: after the same sibling if it
 * is still there, else after the sibling before it as mine saw them. Then past nodes
 * theirs added at the same place, so the earlier-landed side comes first (�8.5).
 */
function placeSchema(cur: Doc, ctx: Doc, T: Analysis, parent: SchemaParent, after: Id | null): Id | null {
  const list = siblings(cur.schema, parent).map((d) => d.id);
  const ctxList = siblings(ctx.schema, parent).map((d) => d.id);
  let a = after;
  while (a !== null && !list.includes(a)) {
    const i = ctxList.indexOf(a);
    a = i > 0 ? ctxList[i - 1]! : null;
  }
  const skipped = new Set<string>([a ?? START]);
  let i = a === null ? -1 : list.indexOf(a);
  for (;;) {
    const next = list[i + 1];
    if (next === undefined || !T.schemaPlaced.has(next) || !skipped.has(T.schemaPlaced.get(next) ?? START)) break;
    skipped.add(next);
    i++;
  }
  return i < 0 ? null : list[i]!;
}

/**
 * Where an insert or move anchored after `after` goes on the head.
 *
 * - If the anchor is still where mine saw it, the rows go right after it.
 * - If it isn't (theirs moved it, or it's gone), they stay put: the anchor becomes its
 *   predecessor as mine saw the sheet, repeatedly. Following the moved anchor instead
 *   would make the result depend on which side landed first.
 * - On a data sheet, columns never go before A and B.
 * - Then they skip past rows theirs placed at the same spot (recursively), so the
 *   earlier-landed side comes first (DESIGN §8.5).
 */
function anchor(
  cur: Doc,
  ctx: Doc,
  T: Analysis,
  /** The row is not where mine saw it: theirs moved it, or mine's own move of it was dropped. */
  movedAway: (k: string) => boolean,
  sh: SheetId,
  axis: Axis,
  after: string | null,
  moving: string[],
): string | null {
  const s = cur.sheets.get(sh)!;
  const ord = axisOf(s, axis).order;
  const ctxSheet = ctx.sheets.get(sh);
  const ctxOrd = ctxSheet ? axisOf(ctxSheet, axis).order : [];
  const displaced = (id: string) => !hasId(axisOf(s, axis), id) || moving.includes(id) || movedAway(axisKey(sh, axis, id));
  let a = after;
  while (a !== null && displaced(a)) {
    const i = ctxOrd.indexOf(a);
    a = i > 0 ? ctxOrd[i - 1]! : null;
  }
  if (axis === "col" && s.kind === "data") {
    const sys = ord.filter((id) => !moving.includes(id)).slice(0, 2);
    if (sys.length && (a === null || sys.indexOf(a) === 0)) a = sys.at(-1)!;
  }
  const skipped = new Set<string>([a ?? START]);
  let i = a === null ? -1 : ord.indexOf(a);
  for (;;) {
    const next = ord[i + 1];
    if (next === undefined || moving.includes(next)) break;
    const k = axisKey(sh, axis, next);
    if (!T.placed.has(k) || !skipped.has(T.placed.get(k) ?? START)) break;
    skipped.add(next);
    i++;
  }
  return i < 0 ? null : ord[i]!;
}
