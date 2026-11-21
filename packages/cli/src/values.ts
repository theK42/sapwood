// Values typed on the command line: `field=value` assignments and `--where` conditions.

import type { EntityJson, FieldDef, FieldType, JsonValue, ResolvedSchema } from "@thek42/sapwood-core";

/** A mistake in how the command was typed. */
export class UsageError extends Error {
  override name = "UsageError";
}

function tryJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * A value typed for a field. Blank clears it, `=…` is a formula, and the rest is read for
 * the field's type: a number or true/false for numbers and booleans, text for text, IDs,
 * enum members and dates, JSON (or a comma-separated list) for lists, JSON for structs,
 * unions and json. Quote text in JSON to keep it as typed: `name='"=not a formula"'`.
 * What doesn't fit the type is passed on as text, for the project to refuse with its own
 * message.
 */
export function parseValue(type: FieldType, text: string): JsonValue {
  if (text === "") return null;
  if (text.startsWith("=")) return { $formula: text };
  const json = tryJson(text);
  switch (type.kind) {
    case "int":
    case "float":
    case "duration":
      return typeof json === "number" ? json : text;
    case "bool": {
      const t = text.toLowerCase();
      return t === "true" ? true : t === "false" ? false : text;
    }
    case "string":
    case "enum":
    case "ref":
    case "datetime":
      return typeof json === "string" ? json : text;
    case "list":
      if (Array.isArray(json)) return json;
      return text.split(",").map((x) => parseValue(type.of, x.trim()));
    case "struct":
    case "union":
    case "json":
      if (json === undefined) throw new UsageError(`Expected JSON, such as {"amount": 5}, got ${text}`);
      return json;
  }
}

const isObject = (v: unknown): v is { [k: string]: JsonValue } => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Fields from `field=value` assignments, for an entity or singleton of `type` whose fields
 * are now `current`. `field.sub=value` sets one field of a struct and keeps the others.
 * `$id=…` renames, `$active=false` comments out.
 */
export function assignments(schema: ResolvedSchema, type: string, args: readonly string[], current: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  const t = schema.types.get(type);
  const fields: Record<string, JsonValue> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new UsageError(`Expected field=value, got ${arg}`);
    const path = arg.slice(0, eq).split(".");
    const text = arg.slice(eq + 1);
    const top = path[0]!;
    if (top.startsWith("$")) {
      if (path.length > 1) throw new UsageError(`${top} has no parts`);
      fields[top] = top === "$active" ? parseValue({ kind: "bool" }, text) : text;
      continue;
    }
    const f = t?.fieldByName.get(top)?.def;
    if (!f) {
      fields[top] = text; // the project says what's wrong
      continue;
    }
    if (path.length === 1) {
      fields[top] = parseValue(f.type, text);
      continue;
    }
    // `price.amount=5`: change one part of the struct, keeping the rest.
    const base = fields[top] ?? current[top];
    const root: { [k: string]: JsonValue } = isObject(base) && !("$formula" in base) ? structuredClone(base) : {};
    let o = root;
    let def: FieldDef = f;
    for (const [i, name] of path.slice(1).entries()) {
      const s = def.type.kind === "struct" ? schema.structs.get(def.type.name) : undefined;
      const sub = s?.fields.find((x) => x.name === name);
      if (!sub) throw new UsageError(`${path.slice(0, i + 1).join(".")} ${s ? `(${s.name}) has no field ${name}` : "isn't a struct"}`);
      def = sub;
      if (i === path.length - 2) o[name] = parseValue(sub.type, text);
      else {
        const next = o[name];
        o = o[name] = isObject(next) && !("$formula" in next) ? next : {};
      }
    }
    fields[top] = root;
  }
  return fields;
}

const OPS = ["!=", "<=", ">=", "=", "<", ">", "~"] as const;
type Cmp = (typeof OPS)[number];

/** The value at a dotted path of an entity, with formula fields read as their values. */
function at(e: EntityJson, path: string[]): JsonValue | undefined {
  let v: JsonValue | undefined = e;
  for (const k of path) {
    if (isObject(v) && "$formula" in v) v = v.$value;
    v = isObject(v) ? v[k] : undefined;
  }
  return isObject(v) && "$formula" in v ? v.$value : v;
}

/**
 * A `--where` condition: `field<op>value`, with `=`, `!=`, `<`, `<=`, `>`, `>=`, and `~`
 * (contains, ignoring case). A list matches `=` when it has the value. `field=` matches a
 * blank field. Numbers compare as numbers; other values as text, so ISO dates compare in
 * time order.
 */
export function parseWhere(cond: string): (e: EntityJson) => boolean {
  const m = /^\s*([$A-Za-z_][\w.]*)\s*(!=|<=|>=|=|<|>|~)(.*)$/.exec(cond);
  if (!m) throw new UsageError(`Expected field<op>value in --where, with one of ${OPS.join(" ")}: got ${cond}`);
  const path = m[1]!.split(".");
  const op = m[2] as Cmp;
  const text = m[3]!.trim();
  const num = text !== "" && Number.isFinite(Number(text)) ? Number(text) : null;
  const eq = (v: JsonValue | undefined): boolean => {
    if (v === undefined || v === null) return text === "";
    if (Array.isArray(v)) return v.some(eq);
    if (typeof v === "number") return num !== null && v === num;
    if (typeof v === "boolean") return String(v) === text.toLowerCase();
    if (typeof v === "string") return v === text;
    return JSON.stringify(v) === text;
  };
  const order = (v: JsonValue | undefined): number | null => {
    if (v === undefined || v === null || typeof v === "object") return null;
    if (typeof v === "number" && num !== null) return v - num;
    const s = String(v);
    return s < text ? -1 : s > text ? 1 : 0;
  };
  const contains = (v: JsonValue | undefined): boolean => {
    if (v === undefined || v === null) return false;
    if (Array.isArray(v)) return v.some(contains);
    return (typeof v === "string" ? v : JSON.stringify(v)).toLowerCase().includes(text.toLowerCase());
  };
  return (e) => {
    const v = at(e, path);
    switch (op) {
      case "=":
        return eq(v);
      case "!=":
        return !eq(v);
      case "~":
        return contains(v);
      default: {
        const d = order(v);
        if (d === null) return false;
        return op === "<" ? d < 0 : op === "<=" ? d <= 0 : op === ">" ? d > 0 : d >= 0;
      }
    }
  };
}
