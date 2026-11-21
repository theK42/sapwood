// Cell parsing (DESIGN §5.3): turn what a bound cell holds into a typed field value.
//
// A cell's value comes from the formula engine: a literal the user typed (already
// read as a number, boolean or text), or a formula result. Lists, structs, unions and
// json fields hold JSON text in one cell; their elements are parsed from JSON values.
//
// Parsing checks the shape only: "is this an int?". Constraints such as min, max and
// whether a ref's target exists are validation's job.

import { FError, formatNumber, isErr, type Scalar } from "../formula/values.ts";
import type { FieldDef, FieldType } from "../schema/model.ts";
import type { ResolvedSchema } from "../schema/resolve.ts";

/** A reference to an entity by ID. Kept distinct from text so export can shape it (§10.2). */
export class Ref {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

/** The value of a `json` field: any JSON, kept as is. */
export class Json {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

export type FieldValue = string | number | boolean | Ref | Json | FieldValue[] | { [field: string]: FieldValue };

export type Parsed = { ok: true; value: FieldValue } | { ok: false; message: string };

const ok = (value: FieldValue): Parsed => ({ ok: true, value });
const fail = (message: string): Parsed => ({ ok: false, message });

/**
 * Parse one bound cell. Returns undefined for a blank cell, which presence rules
 * (required / optional / default) deal with.
 */
export function parseCell(schema: ResolvedSchema, type: FieldType, v: Scalar, isFormula: boolean): Parsed | undefined {
  if (v === null || v === "") return undefined;
  if (isErr(v)) return fail(errorText(v));
  switch (type.kind) {
    case "string":
      return ok(typeof v === "string" ? v : typeof v === "number" ? formatNumber(v) : v ? "TRUE" : "FALSE");
    case "int":
    case "float":
      return number(type.kind, v);
    case "bool":
      return bool(v);
    case "enum":
      return enumMember(schema, type.name, v);
    case "ref":
      return typeof v === "string" ? ok(new Ref(v)) : fail(`Expected an ID, got ${show(v)}`);
    case "datetime":
      if (typeof v === "number") return isFormula ? ok(serialToIso(v)) : fail("Write a date as 2026-11-14 or 2026-11-14 18:00 (UTC)");
      return typeof v === "string" ? datetime(v) : fail(`Expected a date, got ${show(v)}`);
    case "duration":
      if (typeof v === "number") return isFormula ? ok(round(v * 86400)) : fail("Add a unit: 90s, 5m, 1d 2h 30m or PT1H30M");
      return typeof v === "string" ? duration(v) : fail(`Expected a duration, got ${show(v)}`);
    case "list":
    case "struct":
    case "union":
    case "json": {
      // One cell holds JSON (§6.4, §5.6): a list is `["BlasterBolt"]`, never a bare ID.
      const hint = type.kind === "list" ? ', such as ["a", "b"]' : "";
      if (typeof v !== "string") return type.kind === "json" ? ok(new Json(v)) : fail(`Expected JSON${hint}, got ${show(v)}`);
      const t = v.trim();
      let json: unknown;
      try {
        json = JSON.parse(t);
      } catch {
        return fail(`Not valid JSON${hint}: ${t.length > 40 ? t.slice(0, 40) + "…" : t}`);
      }
      return parseJson(schema, type, json);
    }
  }
}

/** Parse a JSON value as a field type: list elements, struct fields, union variants. */
export function parseJson(schema: ResolvedSchema, type: FieldType, j: unknown, path = ""): Parsed {
  const at = (p: string, r: Parsed): Parsed => (r.ok || !p ? r : fail(`${p}: ${r.message}`));
  switch (type.kind) {
    case "string":
      return typeof j === "string" ? ok(j) : at(path, fail(`Expected text, got ${showJson(j)}`));
    case "int":
    case "float":
      return typeof j === "number" ? at(path, number(type.kind, j)) : at(path, fail(`Expected a number, got ${showJson(j)}`));
    case "bool":
      return typeof j === "boolean" ? ok(j) : at(path, fail(`Expected true or false, got ${showJson(j)}`));
    case "enum":
      return typeof j === "string" ? at(path, enumMember(schema, type.name, j)) : at(path, fail(`Expected a member name, got ${showJson(j)}`));
    case "ref":
      return typeof j === "string" && j !== "" ? ok(new Ref(j)) : at(path, fail(`Expected an ID, got ${showJson(j)}`));
    case "datetime":
      return typeof j === "string" ? at(path, datetime(j)) : at(path, fail(`Expected a date, got ${showJson(j)}`));
    case "duration":
      if (typeof j === "number") return ok(j); // inside JSON, durations are seconds, as exported
      return typeof j === "string" ? at(path, duration(j)) : at(path, fail(`Expected a duration, got ${showJson(j)}`));
    case "json":
      return ok(new Json(j));
    case "list": {
      if (!Array.isArray(j)) return at(path, fail(`Expected a list, got ${showJson(j)}`));
      const out: FieldValue[] = [];
      for (const [i, x] of j.entries()) {
        const r = parseJson(schema, type.of, x, `${path}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out);
    }
    case "struct": {
      const s = schema.structs.get(type.name);
      if (!s) return fail(`Unknown struct ${type.name}`);
      return structFields(schema, s.fields, j, path, null);
    }
    case "union": {
      const u = schema.unions.get(type.name);
      if (!u) return fail(`Unknown union ${type.name}`);
      if (!isObj(j)) return at(path, fail(`Expected an object with "${u.discriminator}", got ${showJson(j)}`));
      const tag = j[u.discriminator];
      const variant = typeof tag === "string" ? u.variants.find((v) => v === tag) : undefined;
      if (!variant)
        return at(path, fail(`"${u.discriminator}" must be one of ${u.variants.join(", ")}${tag === undefined ? "" : `, not ${showJson(tag)}`}`));
      const s = schema.structs.get(variant);
      if (!s) return fail(`Unknown struct ${variant}, a variant of ${u.name}`); // the schema reports it too
      return structFields(schema, s.fields, j, path, { key: u.discriminator, value: variant });
    }
  }
}

function structFields(
  schema: ResolvedSchema,
  fields: FieldDef[],
  j: unknown,
  path: string,
  tag: { key: string; value: string } | null,
): Parsed {
  if (!isObj(j)) return fail(`${path ? path + ": " : ""}Expected an object, got ${showJson(j)}`);
  const out: { [k: string]: FieldValue } = {};
  if (tag) out[tag.key] = tag.value;
  const known = new Set(fields.map((f) => f.name));
  for (const k of Object.keys(j))
    if (k !== tag?.key && !known.has(k)) return fail(`${path ? path + ": " : ""}Unknown field "${k}"`);
  for (const f of fields) {
    const p = path ? `${path}.${f.name}` : f.name;
    const x = j[f.name];
    if (x === undefined || x === null) continue; // presence is validation's job
    const r = parseJson(schema, f.type, x, p);
    if (!r.ok) return r;
    out[f.name] = r.value;
  }
  return ok(out);
}

// ------------------------------------------------------------ scalars

function number(kind: "int" | "float", v: Scalar | number): Parsed {
  if (typeof v !== "number") return fail(`Expected a number, got ${show(v as Scalar)}`);
  if (!Number.isFinite(v)) return ok(v); // `finite` is a constraint, checked by validation
  if (kind === "int") {
    // An integral formula result counts (3.0 → 3); float noise from arithmetic is tolerated.
    const r = Math.round(v);
    if (Math.abs(v - r) > 1e-9) return fail(`Expected a whole number, got ${formatNumber(v)}`);
    if (!Number.isSafeInteger(r)) return fail(`${formatNumber(v)} is outside the int range (±2^53)`);
    return ok(r);
  }
  return ok(v);
}

const TRUE_WORDS = new Set(["true", "1", "yes"]);
const FALSE_WORDS = new Set(["false", "0", "no"]);

function bool(v: Scalar): Parsed {
  if (typeof v === "boolean") return ok(v);
  if (typeof v === "number" && (v === 0 || v === 1)) return ok(v === 1);
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (TRUE_WORDS.has(t)) return ok(true);
    if (FALSE_WORDS.has(t)) return ok(false);
  }
  return fail(`Expected TRUE or FALSE, got ${show(v)}`);
}

function enumMember(schema: ResolvedSchema, name: string, v: Scalar): Parsed {
  const e = schema.enums.get(name);
  if (!e) return fail(`Unknown enum ${name}`);
  const text = typeof v === "string" ? v : typeof v === "number" ? formatNumber(v) : String(v);
  if (e.members.some((m) => m.name === text)) return ok(text);
  const near = e.members.find((m) => m.name.toLowerCase() === text.toLowerCase());
  return fail(`"${text}" isn't a ${name}${near ? ` (did you mean "${near.name}"?)` : `: use ${e.members.map((m) => m.name).join(", ")}`}`);
}

// ------------------------------------------------------------ time (UTC everywhere, §5.3)

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Parse an ISO 8601 date or date-time; no offset means UTC. Returns the UTC ISO string. */
export function datetime(text: string): Parsed {
  const m = DATE_RE.exec(text.trim());
  if (!m) return fail(`"${text}" isn't a date: write 2026-11-14, 2026-11-14 18:00, or with an offset (+02:00)`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac, off] = m;
  const n = (x: string) => Number(x);
  let ms = Date.UTC(n(y!), n(mo!) - 1, n(d!), n(h), n(mi), n(s), frac ? Math.round(Number(frac) * 1000) : 0);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== n(y!) || check.getUTCMonth() !== n(mo!) - 1 || check.getUTCDate() !== n(d!) || n(h) > 23 || n(mi) > 59 || n(s) > 59)
    return fail(`"${text}" isn't a real date`);
  if (off && off.toUpperCase() !== "Z") {
    const sign = off[0] === "-" ? -1 : 1;
    const digits = off.slice(1).replace(":", "");
    ms -= sign * (n(digits.slice(0, 2)) * 60 + n(digits.slice(2))) * 60_000;
  }
  return ok(isoFromMs(ms));
}

const EPOCH_1900 = Date.UTC(1899, 11, 30); // spreadsheet serial day 0

/** A spreadsheet serial number (days since 1899-12-30) as a UTC ISO string. */
export function serialToIso(days: number): string {
  return isoFromMs(EPOCH_1900 + Math.round(days * 86_400_000));
}

/** A UTC ISO string as a spreadsheet serial number, for formulas (§5.3). */
export function isoToSerial(iso: string): number {
  return (Date.parse(iso) - EPOCH_1900) / 86_400_000;
}

function isoFromMs(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-11-14T18:00:00.000Z
  return iso.endsWith(".000Z") ? iso.slice(0, -5) + "Z" : iso;
}

const UNIT_SECONDS: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 };
const ISO_DURATION = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/** Parse `1d 2h 30m`, `90s`, `1.5h`, `250ms` or ISO 8601 `PT1H30M` into seconds. */
export function duration(text: string): Parsed {
  const t = text.trim();
  const iso = ISO_DURATION.exec(t);
  if (iso && t.length > 1 && !/T$/i.test(t)) {
    const [, w = "0", d = "0", h = "0", m = "0", s = "0"] = iso;
    return ok(round(Number(w) * 604800 + Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s)));
  }
  const parts = t.toLowerCase().match(/[+-]?\d+(?:\.\d+)?\s*(?:ms|w|d|h|m|s)/g);
  if (parts && parts.join("").replace(/\s/g, "") === t.toLowerCase().replace(/\s/g, "")) {
    let total = 0;
    for (const p of parts) {
      const [, num, unit] = /([+-]?\d+(?:\.\d+)?)\s*(ms|w|d|h|m|s)/.exec(p)!;
      total += Number(num) * UNIT_SECONDS[unit!]!;
    }
    return ok(round(total));
  }
  return fail(`"${text}" isn't a duration: write 90s, 5m, 1d 2h 30m or PT1H30M`);
}

// ------------------------------------------------------------ helpers

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function show(v: Scalar): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

function showJson(j: unknown): string {
  const s = JSON.stringify(j);
  return s === undefined ? String(j) : s.length > 40 ? s.slice(0, 40) + "…" : s;
}

function errorText(e: FError): string {
  return e.detail ? `${e.code} ${e.detail}` : e.code;
}
