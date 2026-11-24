// The panel editor's model (DESIGN §5.6, §9.2), apart from React: which cells it edits, the
// summary such a cell shows in place of its JSON, a value's issues by where in it they are,
// and the values the form starts new parts with.
//
// Paths name a place in a value as validation's messages do: "" is the whole, then `.size`,
// `[0]`, so `[0].size.x` is the first shape's size's x.

import type { FieldDef, FieldType, Issue, ResolvedSchema } from "@thek42/sapwood-core";

/** A field as one cell holds it whole. */
export interface CellField {
  def: FieldDef;
  type: FieldType;
  /** How validation names it at the start of its messages: `shapes`, `cost.amount`. */
  label: string;
}

/** Whether a field is edited in the panel: structs, unions, json, and lists of those. */
export function inPanel(t: FieldType): boolean {
  if (t.kind === "list") return inPanel(t.of);
  return t.kind === "struct" || t.kind === "union" || t.kind === "json";
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const LONG = 80;

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12))));

/**
 * A short summary of a value, as a cell shows it: `Box size (2, 1)`; a list's items with `;`
 * between. Structs of numbers alone read as `(2, 1)`. Past 80 characters it ends in "…".
 */
export function summary(schema: ResolvedSchema, type: FieldType, value: unknown): string {
  const s = sum(schema, type, value);
  return s.length > LONG ? s.slice(0, LONG - 1) + "…" : s;
}

function sum(schema: ResolvedSchema, type: FieldType, v: unknown): string {
  if (v === undefined || v === null) return "";
  switch (type.kind) {
    case "list":
      return Array.isArray(v) ? (v.length ? v.map((x) => sum(schema, type.of, x)).join("; ") : "none") : raw(v);
    case "struct": {
      const s = schema.structs.get(type.name);
      return s && isObj(v) ? fields(schema, s.fields, v) : raw(v);
    }
    case "union": {
      const u = schema.unions.get(type.name);
      if (!u || !isObj(v)) return raw(v);
      const tag = v[u.discriminator];
      const s = typeof tag === "string" ? schema.structs.get(tag) : undefined;
      if (!s) return raw(v);
      const rest = fields(schema, s.fields, v);
      return rest ? `${tag} ${rest}` : String(tag);
    }
    case "json":
      return raw(v);
    default:
      return typeof v === "number" ? num(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "string" ? v : raw(v);
  }
}

function fields(schema: ResolvedSchema, defs: readonly FieldDef[], v: Obj): string {
  const set = defs.filter((f) => v[f.name] !== undefined && v[f.name] !== null);
  if (set.length >= 2 && set.every((f) => typeof v[f.name] === "number")) return `(${set.map((f) => num(v[f.name] as number)).join(", ")})`;
  return set.map((f) => `${f.name} ${sum(schema, f.type, v[f.name])}`).join(", ");
}

const raw = (v: unknown) => JSON.stringify(v) ?? "";

/**
 * A value's issues by path, from the issues on its cell. A message that starts with the
 * field's label is about the place it names next (`shapes[0].radius: must be at least 0`
 * is `[0].radius`); any other, such as a parse error, is about the whole ("").
 */
export function issuesByPath(issues: readonly Issue[], label: string): Map<string, Issue[]> {
  const out = new Map<string, Issue[]>();
  const add = (path: string, i: Issue) => out.set(path, [...(out.get(path) ?? []), i]);
  for (const i of issues) {
    if (!i.message.startsWith(label)) {
      add("", i);
      continue;
    }
    const rest = i.message.slice(label.length);
    // A parse error names its place after the label: `shapes: [1].size.x: Expected a number`.
    const parse = /^: ((?:\[\d+\]|[A-Za-z_]\w*)(?:\.[A-Za-z_]\w*|\[\d+\])*): ([\s\S]*)$/.exec(rest);
    if (parse) {
      add(parse[1]!.startsWith("[") ? parse[1]! : `.${parse[1]}`, { ...i, message: parse[2]! });
      continue;
    }
    const m =/^((?:\.[A-Za-z_]\w*|\[\d+\]|\["(?:[^"\\]|\\.)*"\])*)(?::\s*|\s+)([\s\S]*)$/.exec(rest);
    if (!m) add("", i);
    else add(m[1]!, { ...i, message: m[2]! });
  }
  return out;
}

/** A path one step in: a field of a struct, or an item of a list. */
export const pathIn = (path: string, step: string | number): string =>
  typeof step === "number" ? `${path}[${step}]` : /^[A-Za-z_]\w*$/.test(step) ? `${path}.${step}` : `${path}[${JSON.stringify(step)}]`;

/** What a new part of a value starts as: a list item added, a variant picked. */
export function blank(schema: ResolvedSchema, type: FieldType): unknown {
  switch (type.kind) {
    case "struct":
      return {};
    case "union": {
      const u = schema.unions.get(type.name);
      return u && u.variants[0] ? { [u.discriminator]: u.variants[0] } : {};
    }
    case "list":
      return [];
    case "int":
    case "float":
    case "duration":
      return 0;
    case "bool":
      return false;
    case "enum":
      return schema.enums.get(type.name)?.members[0]?.name ?? "";
    case "json":
      return null;
    default:
      return "";
  }
}

/**
 * Switch a union value to another variant: the discriminator changes, and fields the new
 * variant has by the same name are kept.
 */
export function switchVariant(schema: ResolvedSchema, unionName: string, v: unknown, variant: string): Obj {
  const u = schema.unions.get(unionName);
  const s = schema.structs.get(variant);
  const out: Obj = { [u?.discriminator ?? "kind"]: variant };
  if (isObj(v) && s) for (const f of s.fields) if (v[f.name] !== undefined) out[f.name] = v[f.name];
  return out;
}

/**
 * The value with its objects' keys in schema order (a union's discriminator first), keys the
 * schema doesn't know kept at the end, as the form writes it.
 */
export function ordered(schema: ResolvedSchema, type: FieldType, v: unknown): unknown {
  switch (type.kind) {
    case "list":
      return Array.isArray(v) ? v.map((x) => ordered(schema, type.of, x)) : v;
    case "struct":
    case "union": {
      if (!isObj(v)) return v;
      let defs: readonly FieldDef[] = [];
      const out: Obj = {};
      if (type.kind === "struct") defs = schema.structs.get(type.name)?.fields ?? [];
      else {
        const u = schema.unions.get(type.name);
        const tag = u ? v[u.discriminator] : undefined;
        if (u && tag !== undefined) out[u.discriminator] = tag;
        defs = (typeof tag === "string" ? schema.structs.get(tag)?.fields : undefined) ?? [];
      }
      for (const f of defs) if (v[f.name] !== undefined) out[f.name] = ordered(schema, f.type, v[f.name]);
      for (const [k, x] of Object.entries(v)) if (!(k in out)) out[k] = x;
      return out;
    }
    default:
      return v;
  }
}

/** The text the cell gets for a value: its JSON, or blank for none. */
export const cellText = (schema: ResolvedSchema, type: FieldType, v: unknown): string =>
  v === undefined ? "" : JSON.stringify(ordered(schema, type, v));
