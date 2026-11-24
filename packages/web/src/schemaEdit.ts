// Edits to a working copy of the schema, for the schema editor's forms (DESIGN §5.8). Each
// returns a new schema; the page writes it as YAML, and the preview and Apply take it from
// there. Renaming a definition renames the references to it in the schema too (field types,
// trait lists, union variants, rules' types), as the YAML must still read; enum members
// likewise in fields' defaults. A new item has no ID: reading the YAML gives it one.

import type { EnumDef, FieldDef, FieldType, Schema, StructDef, TraitDef, TypeDef, UnionDef } from "@thek42/sapwood-core";

export type Section = "types" | "traits" | "structs" | "unions" | "enums";
export type Def = TypeDef | TraitDef | StructDef | UnionDef | EnumDef;
/** Definitions that have fields. */
export type WithFields = "types" | "traits" | "structs";

export const SECTIONS: { key: Section; one: string; many: string }[] = [
  { key: "types", one: "type", many: "Types" },
  { key: "traits", one: "trait", many: "Traits" },
  { key: "structs", one: "struct", many: "Structs" },
  { key: "unions", one: "union", many: "Unions" },
  { key: "enums", one: "enum", many: "Enums" },
];

export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const copy = (s: Schema): Schema => structuredClone(s);
const list = (s: Schema, section: Section): Def[] => s[section] as Def[];

export function defOf(s: Schema, section: Section, id: string): Def | undefined {
  return list(s, section).find((d) => d.id === id);
}

/** A field type with every name in it passed through `f` (enum, struct, union and ref targets). */
function mapType(t: FieldType, f: (kind: "enum" | "struct" | "union" | "ref", name: string) => string): FieldType {
  switch (t.kind) {
    case "enum":
    case "struct":
    case "union":
      return { ...t, name: f(t.kind, t.name) };
    case "ref":
      return t.targets === "any" ? t : { kind: "ref", targets: t.targets.map((n) => f("ref", n)) };
    case "list":
      return { kind: "list", of: mapType(t.of, f) };
    default:
      return t;
  }
}

/** Every field of every definition with fields. */
function allFields(s: Schema): FieldDef[] {
  return [...s.types, ...s.traits, ...s.structs].flatMap((d) => d.fields);
}

export function addDef(s: Schema, section: Section, name: string): Schema {
  const n = copy(s);
  const base = { id: "", name };
  const def: Def =
    section === "types" || section === "traits" ? { ...base, traits: [], fields: [] }
    : section === "structs" ? { ...base, fields: [] }
    : section === "unions" ? { ...base, discriminator: "kind", variants: [] }
    : { ...base, members: [] };
  (n[section] as Def[]).push(def);
  return n;
}

export function removeDef(s: Schema, section: Section, id: string): Schema {
  const n = copy(s);
  (n[section] as Def[]) = list(n, section).filter((d) => d.id !== id);
  return n;
}

/** Rename a definition, and the schema's references to it. */
export function renameDef(s: Schema, section: Section, id: string, to: string): Schema {
  const n = copy(s);
  const d = defOf(n, section, id);
  if (!d || d.name === to) return s;
  const from = d.name;
  d.name = to;
  const kind = section === "enums" ? "enum" : section === "structs" ? "struct" : section === "unions" ? "union" : "ref";
  for (const f of allFields(n)) f.type = mapType(f.type, (k, name) => (name === from && (k === kind || (k === "ref" && kind === "ref")) ? to : name));
  if (section === "traits") for (const t of [...n.types, ...n.traits]) t.traits = t.traits.map((x) => (x === from ? to : x));
  if (section === "structs") for (const u of n.unions) u.variants = u.variants.map((x) => (x === from ? to : x));
  if (section === "types" || section === "traits") for (const r of n.rules) if (r.type === from) r.type = to;
  return n;
}

/** Set properties of a definition (not its name or fields); undefined takes one out. */
export function setDef(s: Schema, section: Section, id: string, patch: Record<string, unknown>): Schema {
  const n = copy(s);
  const d = defOf(n, section, id) as unknown as Record<string, unknown> | undefined;
  if (!d) return s;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete d[k];
    else d[k] = v;
  }
  return n;
}

/** Rename an enum's member, and fields' defaults of that enum that name it. */
export function renameMember(s: Schema, enumId: string, from: string, to: string): Schema {
  const n = copy(s);
  const e = n.enums.find((x) => x.id === enumId);
  if (!e) return s;
  e.members = e.members.map((m) => (m.name === from ? { ...m, name: to } : m));
  const enumOf = (t: FieldType): string | null => (t.kind === "enum" ? t.name : null);
  for (const f of allFields(n)) if (enumOf(f.type) === e.name && f.default === from) f.default = to;
  return n;
}

export function fieldsOf(s: Schema, section: WithFields, id: string): FieldDef[] {
  return (defOf(s, section, id) as TypeDef | TraitDef | StructDef | undefined)?.fields ?? [];
}

export function addField(s: Schema, section: WithFields, id: string, name: string, type: FieldType): Schema {
  const n = copy(s);
  const d = defOf(n, section, id) as TypeDef | TraitDef | StructDef | undefined;
  d?.fields.push({ id: "", name, type });
  return n;
}

export function removeField(s: Schema, section: WithFields, id: string, fieldId: string): Schema {
  const n = copy(s);
  const d = defOf(n, section, id) as TypeDef | TraitDef | StructDef | undefined;
  if (d) d.fields = d.fields.filter((f) => f.id !== fieldId);
  return n;
}

/** Set a field's properties (its name too); undefined takes one out. */
export function setField(s: Schema, section: WithFields, id: string, fieldId: string, patch: Partial<Record<keyof FieldDef, unknown>>): Schema {
  const n = copy(s);
  const f = (defOf(n, section, id) as TypeDef | TraitDef | StructDef | undefined)?.fields.find((x) => x.id === fieldId) as unknown as Record<string, unknown> | undefined;
  if (!f) return s;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete f[k];
    else f[k] = v;
  }
  // A field is required, or has a default, not both (§5.3).
  if (patch.required === true) delete f.default;
  if (patch.default !== undefined) delete f.required;
  return n;
}

/** The constraints that apply to a field type (§5.3), as the form offers them. */
export function constraintsFor(t: FieldType): (keyof FieldDef)[] {
  switch (t.kind) {
    case "string":
      return ["minLength", "maxLength", "pattern", "nonEmpty"];
    case "int":
      return ["min", "max"];
    case "float":
      return ["min", "max", "finite"];
    case "datetime":
    case "duration":
      return ["min", "max"];
    case "ref":
      return ["reach"];
    case "list":
      return ["minItems", "maxItems", "unique", ...(t.of.kind === "ref" ? (["reach"] as const) : [])];
    default:
      return [];
  }
}

// ------------------------------------------------------------ rules (§5.7)

/** A new rule, for a type or trait (or, with none, global): it flags nothing until its expression says what. */
export function addRule(s: Schema, type: string | undefined): Schema {
  const n = copy(s);
  n.rules.push({ id: "", ...(type ? { type } : {}), severity: "warning", expr: "=TRUE", message: "Describe what's wrong" });
  return n;
}

export function removeRule(s: Schema, id: string): Schema {
  const n = copy(s);
  n.rules = n.rules.filter((r) => r.id !== id);
  return n;
}

/** Set a rule's type (undefined: global), severity, expression or message. */
export function setRule(s: Schema, id: string, patch: Partial<Record<"type" | "severity" | "expr" | "message", string | undefined>>): Schema {
  const n = copy(s);
  const r = n.rules.find((x) => x.id === id) as unknown as Record<string, unknown> | undefined;
  if (!r) return s;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete r[k];
    else r[k] = v;
  }
  return n;
}
