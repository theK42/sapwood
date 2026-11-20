import type { ErrorCode } from "./parse.ts";

export class FError {
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  constructor(code: ErrorCode, detail?: string) {
    this.code = code;
    this.detail = detail;
  }
  toString(): string {
    return this.code;
  }
}

const SHARED = new Map<ErrorCode, FError>();
/** Shared error instance (no detail) - avoids allocating on hot paths. */
export function err(code: ErrorCode): FError {
  let e = SHARED.get(code);
  if (!e) SHARED.set(code, (e = new FError(code)));
  return e;
}

/** null is a blank cell. */
export type Scalar = number | string | boolean | null | FError;

export interface ArrayValue {
  kind: "array";
  rows: Scalar[][];
}

export interface EntityValue {
  kind: "entity";
  id: string;
}

export type Value = Scalar | ArrayValue | EntityValue;

export const isErr = (v: unknown): v is FError => v instanceof FError;
export const isArray = (v: Value): v is ArrayValue => typeof v === "object" && v !== null && !isErr(v) && v.kind === "array";
export const isEntity = (v: Value): v is EntityValue => typeof v === "object" && v !== null && !isErr(v) && v.kind === "entity";

export function column(values: Scalar[]): ArrayValue {
  return { kind: "array", rows: values.map((v) => [v]) };
}

/** Collapse to a scalar (top-left of an array; Excel's implicit intersection is out of scope). */
export function scalar(v: Value): Scalar {
  if (isArray(v)) return v.rows[0]?.[0] ?? null;
  if (isEntity(v)) return err("#VALUE!");
  return v;
}

export function toNumber(v: Value): number | FError {
  const s = scalar(v);
  if (s === null) return 0;
  if (typeof s === "number") return s;
  if (typeof s === "boolean") return s ? 1 : 0;
  if (typeof s === "string") {
    const t = s.trim();
    if (t === "") return err("#VALUE!");
    const n = Number(t);
    return Number.isFinite(n) ? n : err("#VALUE!");
  }
  return s;
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Excel shows up to 15 significant digits.
  return String(Number(n.toPrecision(15)));
}

export function toText(v: Value): string | FError {
  const s = scalar(v);
  if (s === null) return "";
  if (typeof s === "string") return s;
  if (typeof s === "number") return formatNumber(s);
  if (typeof s === "boolean") return s ? "TRUE" : "FALSE";
  return s;
}

export function toBool(v: Value): boolean | FError {
  const s = scalar(v);
  if (s === null) return false;
  if (typeof s === "boolean") return s;
  if (typeof s === "number") return s !== 0;
  if (typeof s === "string") {
    const u = s.toUpperCase();
    if (u === "TRUE") return true;
    if (u === "FALSE") return false;
    return err("#VALUE!");
  }
  return s;
}

/** Excel ordering: numbers < text < booleans; text compares case-insensitively; blank acts as 0/""/FALSE. */
export function compare(a: Scalar, b: Scalar): number | FError {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  const rank = (x: number | string | boolean): number => (typeof x === "number" ? 0 : typeof x === "string" ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "string") {
    const x = a.toLowerCase();
    const y = (b as string).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
}

/** Display form of a value, as a grid cell would show it. */
export function display(v: Value): string {
  if (isEntity(v)) return `ENTITY("${v.id}")`;
  const t = toText(v);
  return isErr(t) ? t.code : t;
}
