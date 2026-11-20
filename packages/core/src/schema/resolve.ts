// Check a schema's meaning and build the lookups everything else uses (DESIGN §5).
//
// Resolution never throws on a bad schema. It reports issues and still returns
// whatever it could resolve, so a schema editor can show every problem at once.

import type { EnumDef, FieldDef, FieldType, Id, Schema, StructDef, TraitDef, TypeDef, UnionDef } from "./model.ts";
import { formatType, isValidName } from "./model.ts";
import type { SchemaIssue } from "./yaml.ts";

export interface ResolvedField {
  def: FieldDef;
  /** The type or trait that declares it. */
  from: string;
}

export interface ResolvedType {
  def: TypeDef;
  /** Trait fields first (depth-first, in include order), then the type's own. */
  fields: ResolvedField[];
  fieldByName: Map<string, ResolvedField>;
  /** Every trait it includes, directly or through other traits. */
  traits: Set<string>;
}

export interface ResolvedSchema {
  schema: Schema;
  types: Map<string, ResolvedType>;
  traits: Map<string, TraitDef>;
  structs: Map<string, StructDef>;
  unions: Map<string, UnionDef>;
  enums: Map<string, EnumDef>;
  issues: SchemaIssue[];
}

type Kind = "type" | "trait" | "struct" | "union" | "enum";

export function resolveSchema(schema: Schema): ResolvedSchema {
  const issues: SchemaIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  const out: ResolvedSchema = {
    schema,
    types: new Map(),
    traits: new Map(),
    structs: new Map(),
    unions: new Map(),
    enums: new Map(),
    issues,
  };

  // ---- names and IDs: one namespace for every named thing, one for every ID.
  const kindOf = new Map<string, Kind>();
  const ids = new Map<Id, string>();
  const claimId = (id: Id, path: string) => {
    const prev = ids.get(id);
    if (prev !== undefined) issue(path, `ID "${id}" is already used by ${prev}`);
    else ids.set(id, path);
  };
  const declare = (kind: Kind, plural: string, def: { id: Id; name: string }) => {
    const path = `${plural}.${def.name}`;
    claimId(def.id, path);
    if (!isValidName(def.name)) issue(path, `"${def.name}" isn't a valid name: use letters, digits and _, not starting with a digit`);
    const prev = kindOf.get(def.name);
    if (prev) {
      issue(path, `The name "${def.name}" is already used by a ${prev}`);
      return false;
    }
    kindOf.set(def.name, kind);
    return true;
  };
  for (const e of schema.enums) if (declare("enum", "enums", e)) out.enums.set(e.name, e);
  for (const t of schema.traits) if (declare("trait", "traits", t)) out.traits.set(t.name, t);
  for (const s of schema.structs) if (declare("struct", "structs", s)) out.structs.set(s.name, s);
  for (const u of schema.unions) if (declare("union", "unions", u)) out.unions.set(u.name, u);
  for (const t of schema.types) declare("type", "types", t);

  // ---- enums
  for (const e of schema.enums) {
    const seen = new Set<string>();
    if (!e.members.length) issue(`enums.${e.name}`, "An enum needs at least one member");
    for (const m of e.members) {
      if (m.name === "" || m.name !== m.name.trim() || m.name.includes(","))
        issue(`enums.${e.name}.members`, `"${m.name}" isn't a valid member name: no commas or surrounding spaces`);
      if (seen.has(m.name)) issue(`enums.${e.name}.members`, `"${m.name}" is listed twice`);
      seen.add(m.name);
    }
  }

  // ---- fields, wherever they are declared
  const checkFields = (fields: FieldDef[], path: string) => {
    const seen = new Set<string>();
    for (const f of fields) {
      const p = `${path}.fields.${f.name}`;
      claimId(f.id, p);
      if (!isValidName(f.name)) issue(p, `"${f.name}" isn't a valid field name: use letters, digits and _, not starting with a digit`);
      if (seen.has(f.name)) issue(p, `Field "${f.name}" is declared twice`);
      seen.add(f.name);
      checkType(f.type, p);
      checkConstraints(f, p);
    }
  };
  const checkType = (t: FieldType, p: string): void => {
    const want = (name: string, kind: Kind, label: string) => {
      const k = kindOf.get(name);
      if (k === undefined) issue(`${p}.type`, `Unknown ${label} "${name}"`);
      else if (k !== kind) issue(`${p}.type`, `"${name}" is a ${k}, not a ${label}`);
    };
    switch (t.kind) {
      case "enum":
        return want(t.name, "enum", "enum");
      case "struct":
        return want(t.name, "struct", "struct");
      case "union":
        return want(t.name, "union", "union");
      case "list":
        return checkType(t.of, p);
      case "ref":
        if (t.targets === "any") return;
        for (const name of t.targets) {
          const k = kindOf.get(name);
          if (k === undefined) issue(`${p}.type`, `Unknown type or trait "${name}"`);
          else if (k !== "type" && k !== "trait") issue(`${p}.type`, `"${name}" is a ${k}; refs point at types or traits`);
          else if (k === "type" && schema.types.find((x) => x.name === name)?.singleton)
            issue(`${p}.type`, `"${name}" is a singleton, and refs can't point at singletons`);
        }
        return;
      default:
        return;
    }
  };
  const checkConstraints = (f: FieldDef, p: string) => {
    const k = f.type.kind;
    const elem = k === "list" ? (f.type as { of: FieldType }).of : f.type;
    const misplaced = (key: string, allowed: string) => issue(`${p}.${key}`, `"${key}" only applies to ${allowed}, not ${formatType(f.type)}`);
    const ordered = ["int", "float", "datetime", "duration"];
    if (f.min !== undefined && !ordered.includes(k)) misplaced("min", "int, float, datetime and duration fields");
    if (f.max !== undefined && !ordered.includes(k)) misplaced("max", "int, float, datetime and duration fields");
    if (typeof f.min === "number" && typeof f.max === "number" && f.min > f.max) issue(p, `min (${f.min}) is greater than max (${f.max})`);
    if ((k === "int" || k === "float") && ((f.min !== undefined && typeof f.min !== "number") || (f.max !== undefined && typeof f.max !== "number")))
      issue(p, "min and max must be numbers here");
    if (f.finite !== undefined && k !== "float") misplaced("finite", "float fields");
    for (const key of ["minLength", "maxLength", "pattern", "nonEmpty"] as const) if (f[key] !== undefined && k !== "string") misplaced(key, "string fields");
    for (const key of ["minItems", "maxItems", "unique"] as const) if (f[key] !== undefined && k !== "list") misplaced(key, "list fields");
    if (f.reach !== undefined && elem.kind !== "ref") misplaced("reach", "ref and list<ref> fields");
    if (f.jsonSchema !== undefined && k !== "json") misplaced("jsonSchema", "json fields");
    if (f.pattern !== undefined)
      try {
        new RegExp(f.pattern, "u");
      } catch (e) {
        issue(`${p}.pattern`, `Not a valid regular expression: ${(e as Error).message}`);
      }
    for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
      const v = f[key];
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) issue(`${p}.${key}`, `"${key}" must be a whole number, 0 or more`);
    }
    if (f.required && f.default !== undefined) issue(p, "A field can't be both required and have a default");
    if (f.default !== undefined) {
      const d = f.default;
      const bad = (what: string) => issue(`${p}.default`, `The default must be ${what}`);
      if (["list", "struct", "union", "json"].includes(k)) issue(`${p}.default`, `${formatType(f.type)} fields can't have a default`);
      else if (k === "int" && !(typeof d === "number" && Number.isInteger(d))) bad("a whole number");
      else if (k === "float" && typeof d !== "number") bad("a number");
      else if (k === "bool" && typeof d !== "boolean") bad("true or false");
      else if (["string", "ref", "datetime", "duration"].includes(k) && typeof d !== "string") bad("text");
      else if (k === "enum") {
        const e = out.enums.get((f.type as { name: string }).name);
        if (e && !e.members.some((m) => m.name === d)) bad(`a member of ${e.name}`);
      }
    }
  };
  for (const t of schema.traits) checkFields(t.fields, `traits.${t.name}`);
  for (const s of schema.structs) checkFields(s.fields, `structs.${s.name}`);
  for (const t of schema.types) checkFields(t.fields, `types.${t.name}`);

  // ---- unions
  for (const u of schema.unions) {
    const p = `unions.${u.name}`;
    if (!isValidName(u.discriminator)) issue(`${p}.discriminator`, `"${u.discriminator}" isn't a valid field name`);
    if (!u.variants.length) issue(`${p}.variants`, "A union needs at least one variant");
    const seen = new Set<string>();
    for (const v of u.variants) {
      if (seen.has(v)) issue(`${p}.variants`, `"${v}" is listed twice`);
      seen.add(v);
      const k = kindOf.get(v);
      if (k === undefined) issue(`${p}.variants`, `Unknown struct "${v}"`);
      else if (k !== "struct") issue(`${p}.variants`, `"${v}" is a ${k}; a union's variants are structs`);
      else if (out.structs.get(v)!.fields.some((f) => f.name === u.discriminator))
        issue(`${p}.variants`, `Struct "${v}" has a field named "${u.discriminator}", which is this union's discriminator`);
    }
  }

  // ---- traits: includes must exist and must not form a cycle
  const includes = (path: string, list: string[]) => {
    for (const name of list) {
      const k = kindOf.get(name);
      if (k === undefined) issue(`${path}.traits`, `Unknown trait "${name}"`);
      else if (k !== "trait") issue(`${path}.traits`, `"${name}" is a ${k}, not a trait`);
    }
    if (new Set(list).size !== list.length) issue(`${path}.traits`, "A trait is listed twice");
  };
  for (const t of schema.traits) includes(`traits.${t.name}`, t.traits);
  for (const t of schema.types) includes(`types.${t.name}`, t.traits);
  const inCycle = new Set<string>();
  {
    const state = new Map<string, "visiting" | "done">();
    const visit = (name: string, stack: string[]) => {
      const t = out.traits.get(name);
      if (!t) return;
      if (state.get(name) === "done") return;
      if (state.get(name) === "visiting") {
        const cycle = [...stack.slice(stack.indexOf(name)), name];
        if (!cycle.some((c) => inCycle.has(c))) issue(`traits.${name}.traits`, `Traits include each other in a cycle: ${cycle.join(" → ")}`);
        cycle.forEach((c) => inCycle.add(c));
        return;
      }
      state.set(name, "visiting");
      for (const inc of t.traits) visit(inc, [...stack, name]);
      state.set(name, "done");
    };
    for (const t of schema.traits) visit(t.name, []);
  }

  // ---- types: flatten traits, check collisions, singleton rules
  const flatten = (owner: string, path: string, traitNames: string[], own: FieldDef[]): Omit<ResolvedType, "def"> => {
    const fields: ResolvedField[] = [];
    const byName = new Map<string, ResolvedField>();
    const traits = new Set<string>();
    const add = (def: FieldDef, from: string) => {
      const prev = byName.get(def.name);
      if (prev) {
        if (prev.def.id !== def.id) issue(path, `Field "${def.name}" comes from both ${prev.from} and ${from}`);
        return;
      }
      const f = { def, from };
      fields.push(f);
      byName.set(def.name, f);
    };
    const walk = (name: string) => {
      const t = out.traits.get(name);
      if (!t || traits.has(name) || inCycle.has(name)) return;
      traits.add(name); // diamonds: a trait reached twice contributes its fields once
      t.traits.forEach(walk);
      t.fields.forEach((f) => add(f, `trait ${name}`));
    };
    traitNames.forEach(walk);
    own.forEach((f) => add(f, owner));
    return { fields, fieldByName: byName, traits };
  };
  for (const t of schema.types) {
    const path = `types.${t.name}`;
    if (kindOf.get(t.name) !== "type") continue; // name clash, already reported
    if (t.pack !== undefined && !t.singleton) issue(`${path}.pack`, '"pack" only applies to singletons; other types live wherever their rows are');
    if (t.singleton && t.pack !== undefined && t.pack === "") issue(`${path}.pack`, "Name the pack");
    out.types.set(t.name, { def: t, ...flatten(t.name, path, t.traits, t.fields) });
  }
  // A trait's own flattened set must also be collision-free, even if no type uses it yet.
  for (const t of schema.traits) if (!inCycle.has(t.name)) flatten(`trait ${t.name}`, `traits.${t.name}`, t.traits, t.fields);

  // ---- rules
  for (const r of schema.rules) {
    const p = `rules.${r.id}`;
    claimId(r.id, p);
    if (r.type !== undefined) {
      const k = kindOf.get(r.type);
      if (k !== "type" && k !== "trait") issue(`${p}.type`, `Unknown type or trait "${r.type}"`);
    }
  }
  return out;
}

/** Does an entity of this type satisfy a ref target list? */
export function refAccepts(schema: ResolvedSchema, targets: string[] | "any", typeName: string): boolean {
  const t = schema.types.get(typeName);
  if (!t || t.def.singleton) return false;
  if (targets === "any") return true;
  return targets.some((name) => name === typeName || t.traits.has(name));
}
