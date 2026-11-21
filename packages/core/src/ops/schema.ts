// Schema ops (DESIGN §5.9, §8.1): plain changes to the schema, against stable IDs.
//
// The schema is a tree of nodes, each with a stable ID: the definitions in each section
// (types, traits, structs, unions, enums, rules), and the fields of types, traits and
// structs. Three plain ops cover every change:
//
//  - addSchema: add a definition to a section, or a field to its owner, after a sibling;
//  - removeSchema: remove one (a definition goes with its fields);
//  - setSchema: set or clear one property of one node (`name`, `type`, `min`, `members`…).
//
// Schemas are values: an op builds a new schema and never changes the old one, so a
// resolved schema can be cached per schema object.
//
// Schema ops never write cells. They change how cells are read (§5.9): a field whose
// type changes is re-read under the new type, a removed field's cells become scratch.
// The renames that do rewrite cells are the intent ops in rename.ts.

import { stableJson } from "../formula/content.ts";
import type { FieldType, Id, Schema } from "../schema/model.ts";
import { OpError } from "./doc.ts";

export const SECTIONS = ["enums", "traits", "structs", "unions", "types", "rules"] as const;
export type Section = (typeof SECTIONS)[number];

/** A definition or a field, as it is in the schema. */
export type SchemaDef = { id: Id; [key: string]: unknown };

/** Where a node lives: a section, or the type, trait or struct whose field it is. */
export type SchemaParent = Section | Id;

export interface SchemaNode {
  id: Id;
  parent: SchemaParent;
  def: SchemaDef;
}

/** Sections whose definitions have fields. */
const WITH_FIELDS: readonly Section[] = ["traits", "structs", "types"];
export const isSection = (p: SchemaParent): p is Section => (SECTIONS as readonly string[]).includes(p);

/** Properties that hold lists of names. Concurrent changes to them merge item by item (see mergeList). */
export const LIST_KEYS: ReadonlySet<string> = new Set(["members", "traits", "variants"]);

const nodeCache = new WeakMap<Schema, Map<Id, SchemaNode>>();

/** Every node by ID. The first one wins if the schema (as authored) repeats an ID; resolve reports it. */
export function schemaNodes(schema: Schema): Map<Id, SchemaNode> {
  let nodes = nodeCache.get(schema);
  if (nodes) return nodes;
  nodes = new Map();
  for (const section of SECTIONS)
    for (const d of schema[section] as unknown as SchemaDef[]) {
      if (!nodes.has(d.id)) nodes.set(d.id, { id: d.id, parent: section, def: d });
      if (WITH_FIELDS.includes(section))
        for (const f of d.fields as SchemaDef[]) if (!nodes.has(f.id)) nodes.set(f.id, { id: f.id, parent: d.id, def: f });
    }
  nodeCache.set(schema, nodes);
  return nodes;
}

/** The nodes under a parent, in order. */
export function siblings(schema: Schema, parent: SchemaParent): SchemaDef[] {
  if (isSection(parent)) return schema[parent] as unknown as SchemaDef[];
  return (schemaNodes(schema).get(parent)?.def.fields as SchemaDef[] | undefined) ?? [];
}

/** A node's own properties: everything but its ID and fields. */
export function propsOf(def: SchemaDef): Record<string, unknown> {
  const { id: _id, fields: _fields, ...rest } = def;
  return rest;
}

/** The node and every node under it (a definition's fields). */
export function subtreeIds(def: SchemaDef): Id[] {
  return [def.id, ...((def.fields as SchemaDef[] | undefined) ?? []).map((f) => f.id)];
}

function replaceSiblings(schema: Schema, parent: SchemaParent, f: (list: SchemaDef[]) => SchemaDef[]): Schema {
  if (isSection(parent)) return { ...schema, [parent]: f(schema[parent] as unknown as SchemaDef[]) };
  const owner = schemaNodes(schema).get(parent)!;
  const section = owner.parent as Section;
  return {
    ...schema,
    [section]: (schema[section] as unknown as SchemaDef[]).map((d) => (d.id === parent ? { ...d, fields: f(d.fields as SchemaDef[]) } : d)),
  };
}

/** Fill in the parts every definition of a section has, so a resolver can read it. */
function normalize(parent: SchemaParent, def: SchemaDef): SchemaDef {
  const d = structuredClone(def);
  if (!isSection(parent)) return d;
  if (parent === "types" || parent === "traits") d.traits ??= [];
  if (WITH_FIELDS.includes(parent)) d.fields ??= [];
  if (parent === "unions") (d.variants ??= [], (d.discriminator ??= "kind"));
  if (parent === "enums") d.members ??= [];
  return d;
}

export function addNode(schema: Schema, parent: SchemaParent, def: SchemaDef, after: Id | null): Schema {
  const nodes = schemaNodes(schema);
  if (!isSection(parent)) {
    const owner = nodes.get(parent);
    if (!owner || !isSection(owner.parent) || !WITH_FIELDS.includes(owner.parent)) throw new OpError(`addSchema: ${parent} can't have fields`);
  } else if (!WITH_FIELDS.includes(parent) && def.fields !== undefined) throw new OpError(`addSchema: ${parent} have no fields`);
  if (typeof def.id !== "string" || def.id === "") throw new OpError("addSchema: a schema node needs an ID");
  const d = normalize(parent, def);
  const ids = isSection(parent) ? subtreeIds(d) : [d.id];
  if (!isSection(parent) && d.fields !== undefined) throw new OpError("addSchema: a field has no fields");
  if (new Set(ids).size !== ids.length) throw new OpError("addSchema: an ID is listed twice");
  for (const id of ids) if (nodes.has(id)) throw new OpError(`addSchema: ${id} already exists`);
  const list = siblings(schema, parent);
  const i = after === null ? -1 : list.findIndex((x) => x.id === after);
  if (after !== null && i < 0) throw new OpError(`addSchema: no ${after} under ${parent}`);
  return replaceSiblings(schema, parent, (l) => [...l.slice(0, i + 1), d, ...l.slice(i + 1)]);
}

export function removeNode(schema: Schema, id: Id): { schema: Schema; parent: SchemaParent; def: SchemaDef; after: Id | null } {
  const node = schemaNodes(schema).get(id);
  if (!node) throw new OpError(`removeSchema: no ${id}`);
  const list = siblings(schema, node.parent);
  const i = list.indexOf(node.def);
  return {
    schema: replaceSiblings(schema, node.parent, (l) => l.filter((x) => x !== node.def)),
    parent: node.parent,
    def: node.def,
    after: i > 0 ? list[i - 1]!.id : null,
  };
}

/** Set (or, with `value` undefined, clear) one property. Returns the previous value. */
export function setNodeProp(schema: Schema, id: Id, key: string, value: unknown): { schema: Schema; prev: unknown } {
  const node = schemaNodes(schema).get(id);
  if (!node) throw new OpError(`setSchema: no ${id}`);
  if (key === "id" || key === "fields") throw new OpError(`setSchema: "${key}" isn't a property; use addSchema and removeSchema`);
  const prev = node.def[key];
  if (stableJson(prev) === stableJson(value)) return { schema, prev };
  const def: SchemaDef = { ...node.def };
  if (value === undefined) delete def[key];
  else def[key] = structuredClone(value);
  return { schema: replaceSiblings(schema, node.parent, (l) => l.map((x) => (x === node.def ? def : x))), prev };
}

/** A definition (not a field or rule) by name, with its section. */
export function defByName(schema: Schema, name: string): { section: Section; def: SchemaDef } | null {
  for (const section of SECTIONS) {
    if (section === "rules") continue;
    const def = (schema[section] as unknown as SchemaDef[]).find((d) => d.name === name);
    if (def) return { section, def };
  }
  return null;
}

// ------------------------------------------------------------ names of definitions in the schema

/** A field type with each definition name it mentions passed through `f`. Unchanged parts stay the same objects. */
export function mapTypeNames(t: FieldType, f: (name: string) => string): FieldType {
  switch (t.kind) {
    case "ref": {
      if (t.targets === "any") return t;
      const targets = t.targets.map(f);
      return targets.every((x, i) => x === (t.targets as string[])[i]) ? t : { ...t, targets };
    }
    case "enum":
    case "struct":
    case "union": {
      const name = f(t.name);
      return name === t.name ? t : { ...t, name };
    }
    case "list": {
      const of = mapTypeNames(t.of, f);
      return of === t.of ? t : { ...t, of };
    }
    default:
      return t;
  }
}

/**
 * A schema value with each definition name it mentions passed through `f`: a whole node
 * (key null) or one property of a node under `parent`. Names are in field types, a
 * type's or trait's traits, a union's variants and a rule's type.
 */
export function mapDefNames(parent: SchemaParent, key: string | null, value: unknown, f: (name: string) => string): unknown {
  const names = (x: unknown) => (Array.isArray(x) ? x.map((n) => (typeof n === "string" ? f(n) : n)) : x);
  const field = !isSection(parent);
  if (key !== null) {
    if (key === "type" && field && value && typeof value === "object") return mapTypeNames(value as FieldType, f);
    if (key === "type" && parent === "rules" && typeof value === "string") return f(value);
    if ((key === "traits" && (parent === "types" || parent === "traits")) || (key === "variants" && parent === "unions")) return names(value);
    return value;
  }
  const def = { ...(value as SchemaDef) };
  if (field) return def.type && typeof def.type === "object" ? { ...def, type: mapTypeNames(def.type as FieldType, f) } : def;
  for (const k of ["type", "traits", "variants"]) if (k in def) def[k] = mapDefNames(parent, k, def[k], f);
  if (Array.isArray(def.fields)) def.fields = (def.fields as SchemaDef[]).map((x) => mapDefNames(def.id, null, x, f));
  return def;
}

// ------------------------------------------------------------ merging name lists

const itemKey = (x: unknown): string => (typeof x === "string" ? x : String((x as { name?: unknown })?.name));

/**
 * Carry one change to a list of names (enum members, traits, union variants) from the
 * list it was made against (`was`) to the list as it is now (`now`), item by item:
 * items it removed go, items it added are put after the nearest item that preceded
 * them (after any the other side added there, as for rows), and items it changed (a
 * member's description) take the new value. So two tasks adding enum members both keep theirs. A change that only reorders applies when `now`
 * still has the same items as `was`. Items in `keep` (ones the other side added, when a
 * task removes something it had added itself) are never removed.
 */
export function mergeList(was: readonly unknown[], next: readonly unknown[], now: readonly unknown[], keep: ReadonlySet<string> = new Set()): unknown[] {
  const wasKeys = new Map(was.map((x) => [itemKey(x), x]));
  const nextKeys = new Set(next.map(itemKey));
  const sameItems = was.length === next.length && next.every((x) => wasKeys.has(itemKey(x)));
  if (sameItems && was.length === now.length && now.every((x) => wasKeys.has(itemKey(x)))) {
    // A pure reorder (or description change) against an unchanged set of items.
    const nowByKey = new Map(now.map((x) => [itemKey(x), x]));
    return next.map((x) => (stableJson(x) !== stableJson(wasKeys.get(itemKey(x))) ? x : nowByKey.get(itemKey(x))));
  }
  const out = now.filter((x) => !wasKeys.has(itemKey(x)) || nextKeys.has(itemKey(x)) || keep.has(itemKey(x)));
  next.forEach((x, i) => {
    const k = itemKey(x);
    const at = out.findIndex((y) => itemKey(y) === k);
    if (at >= 0) {
      if (wasKeys.has(k) && stableJson(x) !== stableJson(wasKeys.get(k))) out[at] = x;
      return;
    }
    if (wasKeys.has(k)) return; // the other side removed it: stays removed
    let j = i - 1;
    let pos = -1;
    for (; j >= 0; j--) {
      pos = out.findIndex((y) => itemKey(y) === itemKey(next[j]));
      if (pos >= 0) break;
    }
    // Past items the other side added here, so the earlier-landed side comes first (�8.5).
    while (pos + 1 < out.length && !wasKeys.has(itemKey(out[pos + 1])) && !nextKeys.has(itemKey(out[pos + 1]))) pos++;
    out.splice(pos + 1, 0, x);
  });
  return out;
}
