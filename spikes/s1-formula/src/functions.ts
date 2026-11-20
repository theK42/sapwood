// Function library. Every function receives unevaluated argument expressions and
// evaluates what it needs through ctx, so lazy functions (IF, IFERROR) and
// reference-sensitive ones (SUM ignores text in ranges but coerces literals) need no
// special casing in the evaluator.

import type { Expr } from "./bind.ts";
import {
  type ArrayValue, type EntityValue, type FError, type Scalar, type Value,
  column, compare, err, isArray, isErr, scalar, toBool, toNumber, toText,
} from "./values.ts";

export interface Ctx {
  eval(e: Expr): Value;
  entity(id: string): EntityValue | FError;
  entityField(id: string, field: string): Value;
  entitiesOfType(type: string): string[] | FError;
  /** 1-based position of a reference, or of the formula's own cell when `e` is undefined. */
  position(e: Expr | undefined): { row: number; col: number } | FError;
}

export type Fn = (args: Expr[], ctx: Ctx) => Value;

const isRefExpr = (e: Expr): boolean => e.k === "ref" || e.k === "range";

function arity(args: Expr[], min: number, max = min): FError | null {
  return args.length < min || args.length > max ? err("#VALUE!") : null;
}

/** Numbers from aggregate arguments: literals are coerced, references keep numbers only. */
function numbers(args: Expr[], ctx: Ctx, out: number[]): FError | null {
  for (const a of args) {
    const v = ctx.eval(a);
    if (isArray(v)) {
      for (const row of v.rows) for (const x of row) {
        if (isErr(x)) return x;
        if (typeof x === "number") out.push(x);
      }
    } else if (isRefExpr(a)) {
      if (isErr(v)) return v;
      if (typeof v === "number") out.push(v);
    } else {
      const n = toNumber(v);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return null;
}

function all(args: Expr[], ctx: Ctx): Scalar[] {
  const out: Scalar[] = [];
  for (const a of args) {
    const v = ctx.eval(a);
    if (isArray(v)) for (const row of v.rows) out.push(...row);
    else out.push(scalar(v));
  }
  return out;
}

function asArray(v: Value): ArrayValue {
  return isArray(v) ? v : { kind: "array", rows: [[scalar(v)]] };
}

const num1 = (f: (x: number) => number): Fn => (args, ctx) => {
  const bad = arity(args, 1);
  if (bad) return bad;
  const x = toNumber(ctx.eval(args[0]!));
  if (isErr(x)) return x;
  const r = f(x);
  return Number.isFinite(r) ? r : err("#NUM!");
};

const text1 = (f: (s: string) => Value): Fn => (args, ctx) => {
  const bad = arity(args, 1);
  if (bad) return bad;
  const s = toText(ctx.eval(args[0]!));
  return isErr(s) ? s : f(s);
};

function roundTo(x: number, digits: number, mode: "half" | "up" | "down"): number {
  const f = 10 ** digits;
  const y = Math.abs(x) * f;
  // Nudge by an epsilon so 2.675 rounds as Excel does, not as binary floats do.
  const r = mode === "half" ? Math.round(y + 1e-9) : mode === "up" ? Math.ceil(y - 1e-9) : Math.floor(y + 1e-9);
  return (Math.sign(x) * r) / f;
}

const round = (mode: "half" | "up" | "down"): Fn => (args, ctx) => {
  const bad = arity(args, 1, 2);
  if (bad) return bad;
  const x = toNumber(ctx.eval(args[0]!));
  const d = args[1] ? toNumber(ctx.eval(args[1])) : 0;
  if (isErr(x)) return x;
  if (isErr(d)) return d;
  return roundTo(x, Math.trunc(d), mode);
};

/** Criteria as used by COUNTIF/SUMIF: ">5", "<>x", "=x", "x". Wildcards are not in the spike. */
function criterion(c: Scalar): (v: Scalar) => boolean {
  if (typeof c === "string") {
    const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(c)!;
    const op = m[1] ?? "=";
    const rhsText = m[2]!;
    const n = rhsText.trim() === "" ? NaN : Number(rhsText);
    const rhs: Scalar = Number.isFinite(n) ? n : rhsText;
    return (v) => {
      if (rhs === "" && op === "=") return v === null || v === "";
      if (typeof rhs === "number" && typeof v !== "number") return op === "<>";
      const r = compare(v, rhs);
      if (isErr(r)) return false;
      switch (op) {
        case "=": return r === 0;
        case "<>": return r !== 0;
        case "<": return r < 0;
        case ">": return r > 0;
        case "<=": return r <= 0;
        default: return r >= 0;
      }
    };
  }
  return (v) => compare(v, c) === 0 && typeof v === typeof c;
}

/** Exact match position (1-based) in a flat list, or 0. */
function findExact(list: Scalar[], key: Scalar): number {
  for (let i = 0; i < list.length; i++) if (compare(list[i]!, key) === 0 && list[i] !== null) return i + 1;
  return 0;
}

/** Approximate match: last position whose value <= key, in an ascending list. */
function findApprox(list: Scalar[], key: Scalar): number {
  let lo = 0;
  let hi = list.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = compare(list[mid]!, key);
    if (isErr(c)) return 0;
    if (c <= 0) {
      best = mid + 1;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

const flat = (a: ArrayValue): Scalar[] =>
  a.rows.length === 1 ? a.rows[0]! : a.rows.map((r) => r[0] ?? null);

export const FUNCTIONS: Record<string, Fn> = {
  // ---------------------------------------------------------- math and aggregates
  SUM: (args, ctx) => {
    const xs: number[] = [];
    const e = numbers(args, ctx, xs);
    return e ?? xs.reduce((a, b) => a + b, 0);
  },
  PRODUCT: (args, ctx) => {
    const xs: number[] = [];
    const e = numbers(args, ctx, xs);
    return e ?? xs.reduce((a, b) => a * b, 1);
  },
  AVERAGE: (args, ctx) => {
    const xs: number[] = [];
    const e = numbers(args, ctx, xs);
    if (e) return e;
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : err("#DIV/0!");
  },
  MIN: (args, ctx) => {
    const xs: number[] = [];
    const e = numbers(args, ctx, xs);
    return e ?? (xs.length ? Math.min(...xs) : 0);
  },
  MAX: (args, ctx) => {
    const xs: number[] = [];
    const e = numbers(args, ctx, xs);
    return e ?? (xs.length ? Math.max(...xs) : 0);
  },
  COUNT: (args, ctx) => all(args, ctx).filter((v) => typeof v === "number").length,
  COUNTA: (args, ctx) => all(args, ctx).filter((v) => v !== null).length,
  COUNTBLANK: (args, ctx) => all(args, ctx).filter((v) => v === null || v === "").length,
  COUNTIF: (args, ctx) => {
    const bad = arity(args, 2);
    if (bad) return bad;
    const range = flat(asArray(ctx.eval(args[0]!)));
    const test = criterion(scalar(ctx.eval(args[1]!)));
    return range.filter(test).length;
  },
  SUMIF: (args, ctx) => {
    const bad = arity(args, 2, 3);
    if (bad) return bad;
    const range = flat(asArray(ctx.eval(args[0]!)));
    const test = criterion(scalar(ctx.eval(args[1]!)));
    const sums = args[2] ? flat(asArray(ctx.eval(args[2]))) : range;
    let total = 0;
    for (let i = 0; i < range.length; i++) {
      const s = sums[i];
      if (test(range[i]!) && typeof s === "number") total += s;
    }
    return total;
  },
  ABS: num1(Math.abs),
  SQRT: num1((x) => (x < 0 ? NaN : Math.sqrt(x))),
  INT: num1(Math.floor),
  EXP: num1(Math.exp),
  LN: num1((x) => (x <= 0 ? NaN : Math.log(x))),
  ROUND: round("half"),
  ROUNDUP: round("up"),
  ROUNDDOWN: round("down"),
  MOD: (args, ctx) => {
    const bad = arity(args, 2);
    if (bad) return bad;
    const a = toNumber(ctx.eval(args[0]!));
    const b = toNumber(ctx.eval(args[1]!));
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    if (b === 0) return err("#DIV/0!");
    return a - b * Math.floor(a / b); // sign follows divisor, as in Excel
  },
  POWER: (args, ctx) => {
    const bad = arity(args, 2);
    if (bad) return bad;
    const a = toNumber(ctx.eval(args[0]!));
    const b = toNumber(ctx.eval(args[1]!));
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    const r = a ** b;
    return Number.isFinite(r) ? r : err("#NUM!");
  },

  // ---------------------------------------------------------- logic
  IF: (args, ctx) => {
    const bad = arity(args, 2, 3);
    if (bad) return bad;
    const c = toBool(ctx.eval(args[0]!));
    if (isErr(c)) return c;
    if (c) return ctx.eval(args[1]!);
    return args[2] ? ctx.eval(args[2]) : false;
  },
  IFS: (args, ctx) => {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const c = toBool(ctx.eval(args[i]!));
      if (isErr(c)) return c;
      if (c) return ctx.eval(args[i + 1]!);
    }
    return err("#N/A");
  },
  IFERROR: (args, ctx) => {
    const bad = arity(args, 2);
    if (bad) return bad;
    const v = ctx.eval(args[0]!);
    return isErr(scalar(v)) ? ctx.eval(args[1]!) : v;
  },
  IFNA: (args, ctx) => {
    const bad = arity(args, 2);
    if (bad) return bad;
    const v = ctx.eval(args[0]!);
    const s = scalar(v);
    return isErr(s) && s.code === "#N/A" ? ctx.eval(args[1]!) : v;
  },
  AND: (args, ctx) => {
    let r = true;
    for (const v of all(args, ctx)) {
      if (v === null || typeof v === "string") continue;
      const b = toBool(v);
      if (isErr(b)) return b;
      r &&= b;
    }
    return r;
  },
  OR: (args, ctx) => {
    let r = false;
    for (const v of all(args, ctx)) {
      if (v === null || typeof v === "string") continue;
      const b = toBool(v);
      if (isErr(b)) return b;
      r ||= b;
    }
    return r;
  },
  NOT: (args, ctx) => {
    const bad = arity(args, 1);
    if (bad) return bad;
    const b = toBool(ctx.eval(args[0]!));
    return isErr(b) ? b : !b;
  },
  ISBLANK: (args, ctx) => scalar(ctx.eval(args[0]!)) === null,
  ISERROR: (args, ctx) => isErr(scalar(ctx.eval(args[0]!))),
  ISNUMBER: (args, ctx) => typeof scalar(ctx.eval(args[0]!)) === "number",
  ISTEXT: (args, ctx) => typeof scalar(ctx.eval(args[0]!)) === "string",

  // ---------------------------------------------------------- text
  CONCAT: (args, ctx) => {
    let s = "";
    for (const v of all(args, ctx)) {
      const t = toText(v);
      if (isErr(t)) return t;
      s += t;
    }
    return s;
  },
  CONCATENATE: (args, ctx) => FUNCTIONS.CONCAT!(args, ctx),
  LEN: text1((s) => s.length),
  UPPER: text1((s) => s.toUpperCase()),
  LOWER: text1((s) => s.toLowerCase()),
  TRIM: text1((s) => s.trim().replace(/ +/g, " ")),
  LEFT: (args, ctx) => {
    const s = toText(ctx.eval(args[0]!));
    const n = args[1] ? toNumber(ctx.eval(args[1])) : 1;
    if (isErr(s)) return s;
    if (isErr(n)) return n;
    return s.slice(0, Math.max(0, n));
  },
  RIGHT: (args, ctx) => {
    const s = toText(ctx.eval(args[0]!));
    const n = args[1] ? toNumber(ctx.eval(args[1])) : 1;
    if (isErr(s)) return s;
    if (isErr(n)) return n;
    return n <= 0 ? "" : s.slice(-n);
  },
  MID: (args, ctx) => {
    const bad = arity(args, 3);
    if (bad) return bad;
    const s = toText(ctx.eval(args[0]!));
    const start = toNumber(ctx.eval(args[1]!));
    const n = toNumber(ctx.eval(args[2]!));
    if (isErr(s)) return s;
    if (isErr(start)) return start;
    if (isErr(n)) return n;
    if (start < 1 || n < 0) return err("#VALUE!");
    return s.slice(start - 1, start - 1 + n);
  },

  // ---------------------------------------------------------- lookup
  ROW: (args, ctx) => {
    const p = ctx.position(args[0]);
    return isErr(p) ? p : p.row;
  },
  COLUMN: (args, ctx) => {
    const p = ctx.position(args[0]);
    return isErr(p) ? p : p.col;
  },
  ROWS: (args, ctx) => asArray(ctx.eval(args[0]!)).rows.length,
  COLUMNS: (args, ctx) => asArray(ctx.eval(args[0]!)).rows[0]?.length ?? 0,
  INDEX: (args, ctx) => {
    const bad = arity(args, 2, 3);
    if (bad) return bad;
    const a = asArray(ctx.eval(args[0]!));
    let r = toNumber(ctx.eval(args[1]!));
    let c = args[2] ? toNumber(ctx.eval(args[2])) : 1;
    if (isErr(r)) return r;
    if (isErr(c)) return c;
    if (a.rows.length === 1 && !args[2]) [r, c] = [1, r]; // INDEX(row_vector, n)
    const v = a.rows[r - 1]?.[c - 1];
    return v === undefined ? err("#REF!") : v;
  },
  MATCH: (args, ctx) => {
    const bad = arity(args, 2, 3);
    if (bad) return bad;
    const key = scalar(ctx.eval(args[0]!));
    const list = flat(asArray(ctx.eval(args[1]!)));
    const mode = args[2] ? toNumber(ctx.eval(args[2])) : 1;
    if (isErr(mode)) return mode;
    const i = mode === 0 ? findExact(list, key) : findApprox(list, key);
    return i ? i : err("#N/A");
  },
  VLOOKUP: (args, ctx) => {
    const bad = arity(args, 3, 4);
    if (bad) return bad;
    const key = scalar(ctx.eval(args[0]!));
    const table = asArray(ctx.eval(args[1]!));
    const col = toNumber(ctx.eval(args[2]!));
    const approx = args[3] ? toBool(ctx.eval(args[3])) : true;
    if (isErr(col)) return col;
    if (isErr(approx)) return approx;
    const first = table.rows.map((r) => r[0] ?? null);
    const i = approx ? findApprox(first, key) : findExact(first, key);
    if (!i) return err("#N/A");
    const v = table.rows[i - 1]![col - 1];
    return v === undefined ? err("#REF!") : v;
  },
  XLOOKUP: (args, ctx) => {
    const bad = arity(args, 3, 4);
    if (bad) return bad;
    const key = scalar(ctx.eval(args[0]!));
    const look = flat(asArray(ctx.eval(args[1]!)));
    const ret = flat(asArray(ctx.eval(args[2]!)));
    const i = findExact(look, key);
    if (!i) return args[3] ? ctx.eval(args[3]) : err("#N/A");
    return ret[i - 1] ?? err("#REF!");
  },

  // ---------------------------------------------------------- Sapwood
  ENTITY: (args, ctx) => {
    const bad = arity(args, 1);
    if (bad) return bad;
    const id = toText(ctx.eval(args[0]!));
    return isErr(id) ? id : ctx.entity(id);
  },
  /** ENTITIES("Type") -> column of IDs; ENTITIES("Type", "field") -> column of that field. */
  ENTITIES: (args, ctx) => {
    const bad = arity(args, 1, 2);
    if (bad) return bad;
    const type = toText(ctx.eval(args[0]!));
    const field = args[1] ? toText(ctx.eval(args[1])) : null;
    if (isErr(type)) return type;
    if (isErr(field)) return field;
    const ids = ctx.entitiesOfType(type);
    if (isErr(ids)) return ids;
    return column(ids.map((id) => (field === null ? id : scalar(ctx.entityField(id, field)))));
  },
  /**
   * REFS(refField, "otherField"): follow a ref or list<ref> field of the current entity
   * and return `otherField` of each target. Rule-only; the first argument is a field name.
   */
  REFS: (args, ctx) => {
    const bad = arity(args, 2);
    if (bad) return bad;
    const a0 = args[0]!;
    if (a0.k !== "name") return err("#VALUE!");
    const raw = scalar(ctx.eval(a0));
    const field = toText(ctx.eval(args[1]!));
    if (isErr(raw)) return raw;
    if (isErr(field)) return field;
    let ids: string[];
    if (raw === null || raw === "") ids = [];
    else if (typeof raw === "string" && raw.trimStart().startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return err("#VALUE!");
        ids = parsed.map(String);
      } catch {
        return err("#VALUE!");
      }
    } else ids = [String(raw)];
    return column(ids.map((id) => scalar(ctx.entityField(id, field))));
  },
};

export function callFunction(name: string, args: Expr[], ctx: Ctx): Value {
  const f = FUNCTIONS[name];
  return f ? f(args, ctx) : err("#NAME?");
}
