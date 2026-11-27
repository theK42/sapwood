// Raw (A1) AST <-> bound AST (stable IDs). The bound AST is what gets stored;
// formula text is only ever produced by `render`.

import type { A1Point, BinOp, ErrorCode, RawExpr, SheetText } from "./parse.ts";
import { FormulaSyntaxError, numberToCol, parseFormula } from "./parse.ts";
import type { ColId, PackId, RowId, SheetId, Workbook } from "./model.ts";

export interface BoundPoint {
  row: RowId | null; // null = whole column
  col: ColId | null; // null = whole row
  rowAbs: boolean;
  colAbs: boolean;
}

export type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: ErrorCode }
  | { k: "ref"; sheet: SheetId; explicit: boolean; p: BoundPoint }
  | { k: "range"; sheet: SheetId; explicit: boolean; a: BoundPoint; b: BoundPoint }
  | { k: "name"; name: string }
  | { k: "call"; fn: string; args: Expr[] }
  | { k: "bin"; op: BinOp; l: Expr; r: Expr }
  | { k: "neg"; e: Expr }
  | { k: "pct"; e: Expr }
  | { k: "field"; e: Expr; field: string };

export class BindError extends Error {
  override name = "BindError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Host {
  wb: Workbook;
  sheet: SheetId;
}

export function bind(raw: RawExpr, host: Host): Expr {
  const { wb } = host;
  const sheetOf = (st: { pack: string | null; sheet: string } | null): SheetId => {
    if (st === null) return host.sheet;
    const hostPack = wb.sheet(host.sheet).pack;
    const s = wb.resolveSheet(hostPack, st.pack, st.sheet);
    const shown = st.pack === null ? st.sheet : `${st.pack}/${st.sheet}`;
    if (!s) throw new BindError("#REF!", `No sheet '${shown}' reachable from pack '${wb.packName(hostPack)}'`);
    if (!wb.canReach(hostPack, s.pack)) {
      throw new BindError("#REACH!", `Pack '${wb.packName(hostPack)}' cannot read sheet '${shown}' (pack '${wb.packName(s.pack)}' is not itself or an ancestor)`);
    }
    return s.id;
  };

  const point = (sheet: SheetId, a: A1Point): BoundPoint => {
    const s = wb.sheet(sheet);
    return {
      row: a.row === null ? null : s.rows.idAt(a.row),
      col: a.col === null ? null : s.cols.idAt(a.col),
      rowAbs: a.rowAbs,
      colAbs: a.colAbs,
    };
  };

  const go = (e: RawExpr): Expr => {
    switch (e.k) {
      case "num":
      case "str":
      case "bool":
      case "err":
      case "name":
        return e;
      case "ref": {
        const sheet = sheetOf(e.sheet);
        return { k: "ref", sheet, explicit: e.sheet !== null, p: point(sheet, e.a) };
      }
      case "range": {
        const sheet = sheetOf(e.sheet);
        return { k: "range", sheet, explicit: e.sheet !== null, a: point(sheet, e.a), b: point(sheet, e.b) };
      }
      case "call":
        return { k: "call", fn: e.fn, args: e.args.map(go) };
      case "bin":
        return { k: "bin", op: e.op, l: go(e.l), r: go(e.r) };
      case "neg":
      case "pct":
        return { k: e.k, e: go(e.e) };
      case "field":
        return { k: "field", e: go(e.e), field: e.field };
    }
  };
  return go(raw);
}

// ---------------------------------------------------------------- render

const PREC: Record<BinOp, number> = {
  "=": 0, "<>": 0, "<": 0, ">": 0, "<=": 0, ">=": 0, "&": 1, "+": 2, "-": 2, "*": 3, "/": 3, "^": 4,
};

/** Render a bound formula as A1 text, as seen from `host`. */
export function render(e: Expr, host: Host): string {
  return "=" + renderExpr(e, host, -1);
}

function renderExpr(e: Expr, host: Host, outer: number): string {
  switch (e.k) {
    case "num":
      return String(e.v);
    case "str":
      return `"${e.v.replaceAll('"', '""')}"`;
    case "bool":
      return e.v ? "TRUE" : "FALSE";
    case "err":
      return e.v;
    case "name":
      return e.name;
    case "ref": {
      const p = renderPoint(host, e.sheet, e.p);
      return p === null ? "#REF!" : sheetPrefix(host, e.sheet, e.explicit) + p;
    }
    case "range": {
      if (!host.wb.sheets.has(e.sheet)) return "#REF!"; // its sheet was removed
      const s = host.wb.sheet(e.sheet);
      // A deleted corner is drawn at the edge of the surviving span.
      const rows = e.a.row === null || e.b.row === null ? null : s.rows.span(e.a.row, e.b.row);
      const cols = e.a.col === null || e.b.col === null ? null : s.cols.span(e.a.col, e.b.col);
      if ((e.a.row !== null && !rows) || (e.a.col !== null && !cols)) return "#REF!";
      const pt = (row: number | undefined, col: number | undefined, abs: BoundPoint): string =>
        (col === undefined ? "" : (abs.colAbs ? "$" : "") + numberToCol(col)) +
        (row === undefined ? "" : (abs.rowAbs ? "$" : "") + String(row));
      return (
        sheetPrefix(host, e.sheet, e.explicit) +
        pt(rows?.from, cols?.from, e.a) +
        ":" +
        pt(rows?.to, cols?.to, e.b)
      );
    }
    case "call":
      return `${e.fn}(${e.args.map((a) => renderExpr(a, host, -1)).join(", ")})`;
    case "bin": {
      const p = PREC[e.op];
      // Left-associative: the right operand needs parens at equal precedence.
      const s = `${renderExpr(e.l, host, p - 0.5)}${e.op}${renderExpr(e.r, host, p)}`;
      return p <= outer ? `(${s})` : s;
    }
    case "neg":
      return `-${renderExpr(e.e, host, 5)}`;
    case "pct":
      return `${renderExpr(e.e, host, 6)}%`;
    case "field":
      return `${renderExpr(e.e, host, 6)}.${e.field}`;
  }
}

function renderPoint(host: Host, sheet: SheetId, p: BoundPoint): string | null {
  if (!host.wb.sheets.has(sheet)) return null; // its sheet was removed
  const s = host.wb.sheet(sheet);
  const row = p.row === null ? null : s.rows.posOf(p.row);
  const col = p.col === null ? null : s.cols.posOf(p.col);
  if ((p.row !== null && row === null) || (p.col !== null && col === null)) return null;
  return (col === null ? "" : (p.colAbs ? "$" : "") + numberToCol(col)) + (row === null ? "" : (p.rowAbs ? "$" : "") + String(row));
}

function sheetPrefix(host: Host, sheet: SheetId, explicit: boolean): string {
  if (sheet === host.sheet && !explicit) return "";
  const { wb } = host;
  const target = wb.sheet(sheet);
  const hostPack: PackId = wb.sheet(host.sheet).pack;
  // Bare name if it still resolves to the same sheet from here, otherwise qualify.
  const bare = wb.resolveSheet(hostPack, null, target.name)?.id === sheet;
  const name = bare ? target.name : `${wb.packName(target.pack)}/${target.name}`;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[A-Za-z]{1,3}[0-9]+$/.test(name)
    ? `${name}!`
    : `'${name.replaceAll("'", "''")}'!`;
}

// ---------------------------------------------------------------- copy/fill

/** Shift relative references by a row/column offset (copy-paste and fill semantics). */
export function shift(e: RawExpr, dRow: number, dCol: number): RawExpr {
  const pt = (a: A1Point): A1Point => {
    const row = a.row === null || a.rowAbs ? a.row : a.row + dRow;
    const col = a.col === null || a.colAbs ? a.col : a.col + dCol;
    if ((row !== null && row < 1) || (col !== null && col < 1)) throw new BindError("#REF!", "Reference moved off the grid");
    return { ...a, row, col };
  };
  switch (e.k) {
    case "ref":
      return { ...e, a: pt(e.a) };
    case "range":
      return { ...e, a: pt(e.a), b: pt(e.b) };
    case "call":
      return { ...e, args: e.args.map((x) => shift(x, dRow, dCol)) };
    case "bin":
      return { ...e, l: shift(e.l, dRow, dCol), r: shift(e.r, dRow, dCol) };
    case "neg":
    case "pct":
    case "field":
      return { ...e, e: shift(e.e, dRow, dCol) };
    default:
      return e;
  }
}

// ---------------------------------------------------------------- formula text, moved

/**
 * Formula text typed at one cell, as it reads moved `dRow` rows and `dCol` columns (copy and
 * paste, fill): relative references follow, absolute ones stay, as in Excel and Sheets. A
 * reference moved off the grid makes the formula `=#REF!`. Text that isn't a formula, or
 * doesn't parse, is unchanged.
 */
export function moveFormula(input: string, dRow: number, dCol: number): string {
  if (!input.startsWith("=") || input.length < 2) return input;
  try {
    return "=" + renderRaw(shift(parseFormula(input), dRow, dCol), null);
  } catch (e) {
    if (e instanceof BindError) return "=#REF!";
    if (e instanceof FormulaSyntaxError) return input;
    throw e;
  }
}

/**
 * Formula text typed at (`row`, `col`), 1-based, in relative R1C1 form (`=R[0]C[-2]*2`), as
 * Google Sheets writes it to the clipboard. Text that isn't a formula, or doesn't parse, is null.
 */
export function formulaR1C1(input: string, row: number, col: number): string | null {
  if (!input.startsWith("=") || input.length < 2) return null;
  try {
    return "=" + renderRaw(parseFormula(input), { row, col });
  } catch (e) {
    if (e instanceof FormulaSyntaxError) return null;
    throw e;
  }
}

/** A parsed formula as text: A1, or relative R1C1 from `at`. */
function renderRaw(e: RawExpr, at: { row: number; col: number } | null, outer = -1): string {
  const sub = (x: RawExpr, o: number) => renderRaw(x, at, o);
  switch (e.k) {
    case "num":
      return String(e.v);
    case "str":
      return `"${e.v.replaceAll('"', '""')}"`;
    case "bool":
      return e.v ? "TRUE" : "FALSE";
    case "err":
      return e.v;
    case "name":
      return e.name;
    case "ref":
      return sheetText(e.sheet) + point(e.a, at);
    case "range":
      return sheetText(e.sheet) + point(e.a, at) + ":" + point(e.b, at);
    case "call":
      return `${e.fn}(${e.args.map((a) => sub(a, -1)).join(", ")})`;
    case "bin": {
      const p = PREC[e.op];
      const s = `${sub(e.l, p - 0.5)}${e.op}${sub(e.r, p)}`;
      return p <= outer ? `(${s})` : s;
    }
    case "neg":
      return `-${sub(e.e, 5)}`;
    case "pct":
      return `${sub(e.e, 6)}%`;
    case "field":
      return `${sub(e.e, 6)}.${e.field}`;
  }
}

function point(p: A1Point, at: { row: number; col: number } | null): string {
  if (at === null) return (p.col === null ? "" : (p.colAbs ? "$" : "") + numberToCol(p.col)) + (p.row === null ? "" : (p.rowAbs ? "$" : "") + String(p.row));
  const r = p.row === null ? "" : p.rowAbs ? `R${p.row}` : `R[${p.row - at.row}]`;
  const c = p.col === null ? "" : p.colAbs ? `C${p.col}` : `C[${p.col - at.col}]`;
  return r + c;
}

function sheetText(s: SheetText | null): string {
  if (s === null) return "";
  const name = s.pack === null ? s.sheet : `${s.pack}/${s.sheet}`;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[A-Za-z]{1,3}[0-9]+$/.test(name) ? `${name}!` : `'${name.replaceAll("'", "''")}'!`;
}
