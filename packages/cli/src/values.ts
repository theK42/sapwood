// Values typed on the command line: `field=value` assignments and `--where` conditions.

import { ApiError, whereFilter, type EntityJson, type FieldDef, type FieldType, type JsonValue, type ResolvedSchema } from "@thek42/sapwood-core";

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

/** A `--where` condition (core's parseWhere), with a mistake reported as a usage error. */
export function parseWhere(cond: string): (e: EntityJson) => boolean {
  try {
    return whereFilter(cond);
  } catch (e) {
    if (e instanceof ApiError) throw new UsageError(`${e.message} in --where`);
    throw e;
  }
}
