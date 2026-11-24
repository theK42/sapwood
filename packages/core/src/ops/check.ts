// Ops from outside (a browser, over HTTP), checked for shape before anything applies them.
// applyOp trusts its input: an op with a missing field could fail halfway through, or a
// formula with a made-up node could reach the engine. checkOps refuses anything that isn't
// exactly an Op, with the place it went wrong, and copies only the fields an Op has.
//
// Schema ops aren't taken here: schema changes come as YAML (Sapwood.applySchema), which
// checks them as a schema.

import type { Content } from "../formula/content.ts";
import type { BoundPoint, Expr } from "../formula/bind.ts";
import { ERROR_CODES, type BinOp, type ErrorCode } from "../formula/parse.ts";
import type { Layout, LayoutColumn } from "../project/layout.ts";
import { OpError, type Format } from "./doc.ts";
import type { Op } from "./ops.ts";

/** Op kinds that change the schema. */
export const SCHEMA_OP_KINDS: ReadonlySet<Op["kind"]> = new Set(["addSchema", "removeSchema", "setSchema", "renameType", "renameField", "renameEnumMember"]);
/** Op kinds that make, remove or rename packs: a Developer's (DESIGN §11.2). */
export const PACK_OP_KINDS: ReadonlySet<Op["kind"]> = new Set(["createPack", "removePack", "renamePack", "setPackParent"]);

const MAX_DEPTH = 200;
const BIN_OPS: ReadonlySet<string> = new Set<BinOp>(["+", "-", "*", "/", "^", "&", "=", "<>", "<", ">", "<=", ">="]);
const ERRORS: ReadonlySet<string> = new Set<string>(ERROR_CODES);

type Obj = Record<string, unknown>;

class At {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  in(k: string | number): At {
    return new At(typeof k === "number" ? `${this.path}[${k}]` : `${this.path}.${k}`);
  }
}

function fail(at: At, what: string): never {
  throw new OpError(`${at.path}: ${what}`);
}

function obj(x: unknown, at: At): Obj {
  if (x === null || typeof x !== "object" || Array.isArray(x)) fail(at, "expected an object");
  return x as Obj;
}
function str(o: Obj, k: string, at: At): string {
  const v = o[k];
  if (typeof v !== "string" || v === "") fail(at.in(k), "expected a non-empty string");
  return v;
}
function strOrNull(o: Obj, k: string, at: At): string | null {
  return o[k] === null ? null : str(o, k, at);
}
function bool(o: Obj, k: string, at: At): boolean {
  const v = o[k];
  if (typeof v !== "boolean") fail(at.in(k), "expected true or false");
  return v;
}
function oneOf<T extends string>(o: Obj, k: string, xs: readonly T[], at: At): T {
  const v = o[k];
  if (!xs.includes(v as T)) fail(at.in(k), `expected one of ${xs.join(", ")}`);
  return v as T;
}
function ids(o: Obj, k: string, at: At): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.length === 0) fail(at.in(k), "expected a non-empty list of IDs");
  return v.map((x, i) => {
    if (typeof x !== "string" || x === "") fail(at.in(k).in(i), "expected an ID");
    return x;
  });
}

function point(x: unknown, at: At): BoundPoint {
  const o = obj(x, at);
  const row = o.row === null ? null : str(o, "row", at);
  const col = o.col === null ? null : str(o, "col", at);
  return { row, col, rowAbs: bool(o, "rowAbs", at), colAbs: bool(o, "colAbs", at) };
}

function expr(x: unknown, at: At, depth: number): Expr {
  if (depth > MAX_DEPTH) fail(at, "formula nested too deeply");
  const o = obj(x, at);
  const sub = (k: string) => expr(o[k], at.in(k), depth + 1);
  switch (o.k) {
    case "num":
      if (typeof o.v !== "number" || !Number.isFinite(o.v)) fail(at.in("v"), "expected a finite number");
      return { k: "num", v: o.v };
    case "str":
      if (typeof o.v !== "string") fail(at.in("v"), "expected a string");
      return { k: "str", v: o.v };
    case "bool":
      return { k: "bool", v: bool(o, "v", at) };
    case "err":
      if (!ERRORS.has(o.v as string)) fail(at.in("v"), "expected an error code");
      return { k: "err", v: o.v as ErrorCode };
    case "ref":
      return { k: "ref", sheet: str(o, "sheet", at), explicit: bool(o, "explicit", at), p: point(o.p, at.in("p")) };
    case "range":
      return { k: "range", sheet: str(o, "sheet", at), explicit: bool(o, "explicit", at), a: point(o.a, at.in("a")), b: point(o.b, at.in("b")) };
    case "name":
      return { k: "name", name: str(o, "name", at) };
    case "call": {
      const fn = str(o, "fn", at);
      if (!Array.isArray(o.args)) fail(at.in("args"), "expected a list");
      return { k: "call", fn, args: o.args.map((a, i) => expr(a, at.in("args").in(i), depth + 1)) };
    }
    case "bin":
      if (!BIN_OPS.has(o.op as string)) fail(at.in("op"), "expected an operator");
      return { k: "bin", op: o.op as BinOp, l: sub("l"), r: sub("r") };
    case "neg":
      return { k: "neg", e: sub("e") };
    case "pct":
      return { k: "pct", e: sub("e") };
    case "field":
      return { k: "field", e: sub("e"), field: str(o, "field", at) };
    default:
      return fail(at.in("k"), "expected a formula node");
  }
}

function content(x: unknown, at: At): Content {
  if (x === null) return null;
  const o = obj(x, at);
  if ("v" in o) {
    const v = o.v;
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return { v };
    return fail(at.in("v"), "expected text, a finite number, or true or false");
  }
  if ("f" in o) return { f: expr(o.f, at.in("f"), 0) };
  if ("bad" in o) {
    if (typeof o.bad !== "string" || typeof o.message !== "string" || !ERRORS.has(o.code as string)) fail(at, "expected { bad, code, message }");
    return { bad: o.bad, code: o.code as ErrorCode, message: o.message };
  }
  return fail(at, "expected null, { v }, { f } or { bad, code, message }");
}

function format(x: unknown, at: At): Format | null {
  if (x === null) return null;
  const o = obj(x, at);
  const f: Format = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== "string" && typeof v !== "boolean" && !(typeof v === "number" && Number.isFinite(v))) fail(at.in(k), "expected text, a number, or true or false");
    f[k] = v;
  }
  return f;
}

function layout(x: unknown, at: At): Layout | null {
  if (x === null) return null;
  if (!Array.isArray(x)) return fail(at, "expected a list of columns, or null");
  return x.map((c, i) => {
    const a = at.in(i);
    const o = obj(c, a);
    if (!Array.isArray(o.path) || o.path.some((p) => typeof p !== "string" || p === "")) fail(a.in("path"), "expected a list of field IDs");
    const col: LayoutColumn = { col: str(o, "col", a), field: str(o, "field", a), path: [...(o.path as string[])] };
    if (o.index !== undefined) {
      if (!Number.isInteger(o.index) || (o.index as number) < 0) fail(a.in("index"), "expected a whole number, 0 or more");
      col.index = o.index as number;
    }
    return col;
  });
}

function op(x: unknown, at: At): Op {
  const o = obj(x, at);
  const kind = o.kind;
  const sheet = () => str(o, "sheet", at);
  const axis = () => oneOf(o, "axis", ["row", "col"] as const, at);
  const hidden = () => {
    if (o.hidden === undefined) return {};
    if (o.hidden !== true) fail(at.in("hidden"), "expected true, or nothing");
    return { hidden: true as const };
  };
  switch (kind) {
    case "setCell":
      return { kind, sheet: sheet(), row: str(o, "row", at), col: str(o, "col", at), content: content(o.content, at.in("content")), ...hidden() };
    case "setFormat":
      return { kind, sheet: sheet(), row: str(o, "row", at), col: str(o, "col", at), format: format(o.format, at.in("format")), ...hidden() };
    case "insert":
    case "move":
      return { kind, sheet: sheet(), axis: axis(), after: strOrNull(o, "after", at), ids: ids(o, "ids", at) };
    case "delete":
    case "purge":
    case "restore":
      return { kind, sheet: sheet(), axis: axis(), ids: ids(o, "ids", at) };
    case "createSheet":
      return { kind, sheet: sheet(), name: str(o, "name", at), pack: str(o, "pack", at), sheetKind: oneOf(o, "sheetKind", ["data", "scratch"] as const, at) };
    case "removeSheet":
      return { kind, sheet: sheet() };
    case "renameSheet":
      return { kind, sheet: sheet(), name: str(o, "name", at) };
    case "setSheetPack":
      return { kind, sheet: sheet(), pack: str(o, "pack", at) };
    case "setLayout":
      return { kind, sheet: sheet(), type: str(o, "type", at), layout: layout(o.layout, at.in("layout")) };
    case "createPack":
      return { kind, pack: str(o, "pack", at), name: str(o, "name", at), parent: str(o, "parent", at) };
    case "removePack":
      return { kind, pack: str(o, "pack", at) };
    case "renamePack":
      return { kind, pack: str(o, "pack", at), name: str(o, "name", at) };
    case "setPackParent":
      return { kind, pack: str(o, "pack", at), parent: str(o, "parent", at) };
    case "renameId":
      return { kind, from: str(o, "from", at), to: str(o, "to", at) };
    default:
      if (SCHEMA_OP_KINDS.has(kind as Op["kind"])) return fail(at.in("kind"), `${String(kind)} changes the schema: send the schema as YAML instead`);
      return fail(at.in("kind"), "not an op");
  }
}

/** The ops in `x`, checked and copied; an OpError naming the first thing wrong otherwise. */
export function checkOps(x: unknown): Op[] {
  if (!Array.isArray(x)) throw new OpError("ops: expected a list of ops");
  return x.map((o, i) => op(o, new At(`ops[${i}]`)));
}
