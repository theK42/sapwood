// Query conditions in text: `field<op>value`, for the CLI's --where and the HTTP API.

import { ApiError, type EntityJson, type JsonValue } from "./sapwood.ts";

const isObject = (v: unknown): v is { [k: string]: JsonValue } => typeof v === "object" && v !== null && !Array.isArray(v);

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
 * A query condition in text, as the CLI and HTTP API take it: `field<op>value`, with `=`, `!=`, `<`, `<=`, `>`, `>=`, and `~`
 * (contains, ignoring case). A list matches `=` when it has the value. `field=` matches a
 * blank field. Numbers compare as numbers; other values as text, so ISO dates compare in
 * time order.
 */
export function whereFilter(cond: string): (e: EntityJson) => boolean {
  const m = /^\s*([$A-Za-z_][\w.]*)\s*(!=|<=|>=|=|<|>|~)(.*)$/.exec(cond);
  if (!m) throw new ApiError("bad-value", `Expected field<op>value, with one of ${OPS.join(" ")}: got ${cond}`);
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
