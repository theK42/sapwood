// Diffing two schemas into schema ops (`sapwood schema apply`, DESIGN §5.8).
//
// Nodes are matched by stable ID. The ops come in three groups, each computed against the
// schema the previous groups leave:
//
//  1. removals: nodes that are gone, or that moved to another section or owner (they are
//     added again in their new place);
//  2. renames, as the intent ops that rewrite cells (renameType, renameField,
//     renameEnumMember). A rename's target name may be held by another node being renamed
//     (a swap): that one goes through a temporary name first;
//  3. additions and property changes, in schema order.
//
// Reordering has no op yet, so an order change is reported, not applied.

import { stableJson } from "../formula/content.ts";
import type { EnumMember, Id, Schema } from "../schema/model.ts";
import type { Op } from "./ops.ts";
import { isSection, propsOf, schemaNodes, SECTIONS, type SchemaDef, type SchemaParent } from "./schema.ts";

const WITH_FIELDS = new Set<SchemaParent>(["traits", "structs", "types"]);

/** Nodes of `cur` that `next` doesn't have in the same place. A definition's fields go with it. */
export function schemaRemovals(cur: Schema, next: Schema): Op[] {
  const a = schemaNodes(cur);
  const b = schemaNodes(next);
  const stays = (id: Id) => {
    const n = a.get(id)!;
    return b.get(id)?.parent === n.parent;
  };
  const ops: Op[] = [];
  for (const [id, n] of a) {
    if (stays(id)) continue;
    if (!isSection(n.parent) && !stays(n.parent)) continue; // removed with its owner
    ops.push({ kind: "removeSchema", id });
  }
  return ops;
}

interface Rename {
  id: Id;
  /** Names must be unique within a scope: all definitions, or one owner's fields. */
  scope: string;
  from: string;
  to: string;
}

/** The renames taking `cur`'s names to `next`'s, for nodes in the same place in both. */
export function schemaRenames(cur: Schema, next: Schema): Op[] {
  const a = schemaNodes(cur);
  const list: Rename[] = [];
  for (const [id, n] of schemaNodes(next)) {
    const o = a.get(id);
    if (!o || o.parent !== n.parent || n.parent === "rules" || o.def.name === n.def.name) continue;
    list.push({ id, scope: isSection(n.parent) ? "" : n.parent, from: o.def.name as string, to: n.def.name as string });
  }
  // Names now taken, per scope.
  const taken = new Map<string, Map<string, Id>>();
  for (const [id, n] of a) {
    if (n.parent === "rules") continue;
    const scope = isSection(n.parent) ? "" : n.parent;
    if (!taken.has(scope)) taken.set(scope, new Map());
    taken.get(scope)!.set(n.def.name as string, id);
  }
  const ops: Op[] = [];
  const rename = (r: Rename, to: string) => {
    const names = taken.get(r.scope)!;
    names.delete(r.from);
    names.set(to, r.id);
    ops.push(r.scope === "" ? { kind: "renameType", id: r.id, name: to } : { kind: "renameField", id: r.id, name: to });
    r.from = to;
  };
  let pending = list;
  let temp = 0;
  while (pending.length) {
    const free = pending.filter((r) => !taken.get(r.scope)!.has(r.to));
    if (free.length) {
      for (const r of free) rename(r, r.to);
      pending = pending.filter((r) => !free.includes(r));
      continue;
    }
    // Every target is held. Held by a node being renamed: move that one aside. Held by
    // anything else: the rename stays, and fails with the op's own message.
    const holder = pending.find((r) => pending.some((x) => x !== r && x.scope === r.scope && x.from === r.to));
    if (!holder) {
      for (const r of pending) rename(r, r.to);
      break;
    }
    const blocker = pending.find((x) => x.scope === holder.scope && x.from === holder.to)!;
    let name: string;
    do name = `${blocker.from}_renaming${++temp}`;
    while (taken.get(blocker.scope)!.has(name));
    rename(blocker, name);
  }

  // Enum members have no IDs, so they're matched by name. With the same number of members,
  // one whose name changed in place, from a name the new list doesn't have to one the old
  // list didn't, is a rename. Any other change to the list (members added, removed or
  // reordered) is a plain change to `members`: so a rename to a name the enum had (`ice` to
  // `frost`, then `fire` to `ice`) reads as a removal and an addition.
  for (const e of next.enums) {
    const o = a.get(e.id);
    if (o?.parent !== "enums") continue;
    const was = (o.def.members as EnumMember[]).map((m) => m.name);
    const now = e.members.map((m) => m.name);
    if (was.length !== now.length) continue;
    for (let i = 0; i < was.length; i++)
      if (was[i] !== now[i] && !now.includes(was[i]!) && !was.includes(now[i]!)) ops.push({ kind: "renameEnumMember", enum: e.id, from: was[i]!, to: now[i]! });
  }
  return ops;
}

/**
 * Additions and property changes taking `cur` to `next`, where every node `next` shares
 * with `cur` is in the same place and has the same name (after removals and renames).
 * `notes` lists order changes, which aren't applied.
 */
export function schemaChanges(cur: Schema, next: Schema): { ops: Op[]; notes: string[] } {
  const a = schemaNodes(cur);
  const ops: Op[] = [];
  const notes: string[] = [];
  const setOps = (was: SchemaDef, now: SchemaDef) => {
    const p = propsOf(was);
    const q = propsOf(now);
    for (const key of new Set([...Object.keys(p), ...Object.keys(q)])) {
      if (stableJson(p[key]) === stableJson(q[key])) continue;
      ops.push(q[key] === undefined ? { kind: "setSchema", id: now.id, key } : { kind: "setSchema", id: now.id, key, value: structuredClone(q[key]) });
    }
  };
  const order = (what: string, was: SchemaDef[], now: SchemaDef[]) => {
    const kept = new Set(now.map((d) => d.id));
    const before = was.filter((d) => kept.has(d.id)).map((d) => d.id);
    const ids = new Set(before);
    const after = now.filter((d) => ids.has(d.id)).map((d) => d.id);
    if (before.join("\n") !== after.join("\n")) notes.push(`The order of ${what} changed; reordering isn't applied yet, so the old order stays`);
  };
  const label = (d: SchemaDef, section: string) => (section === "rules" ? `rule ${d.id}` : String(d.name));
  for (const section of SECTIONS) {
    const list = next[section] as unknown as SchemaDef[];
    list.forEach((d, i) => {
      const after = i ? list[i - 1]!.id : null;
      const o = a.get(d.id);
      if (!o) {
        ops.push({ kind: "addSchema", parent: section, def: structuredClone(d), after });
        return;
      }
      setOps(o.def, d);
      if (!WITH_FIELDS.has(section)) return;
      const fields = d.fields as SchemaDef[];
      fields.forEach((f, j) => {
        const of = a.get(f.id);
        if (!of) ops.push({ kind: "addSchema", parent: d.id, def: structuredClone(f), after: j ? fields[j - 1]!.id : null });
        else setOps(of.def, f);
      });
      order(`${label(d, section)}'s fields`, o.def.fields as SchemaDef[], fields);
    });
    order(section, cur[section] as unknown as SchemaDef[], list);
  }
  return { ops, notes };
}
