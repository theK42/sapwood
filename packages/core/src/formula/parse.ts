// Formula text -> raw AST. References here are still positional (A1);
// bind.ts turns them into stable row/column IDs.

export type ErrorCode =
  | "#NULL!"
  | "#DIV/0!"
  | "#VALUE!"
  | "#REF!"
  | "#NAME?"
  | "#NUM!"
  | "#N/A"
  | "#CYCLE!"
  | "#REACH!"
  | "#ERROR!";

export const ERROR_CODES: readonly ErrorCode[] = [
  "#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#CYCLE!", "#REACH!", "#ERROR!",
];

/** A sheet as written in the formula: bare `Weapon` or qualified `root/Weapon`. */
export interface SheetText {
  pack: string | null;
  sheet: string;
}

/** One end of a reference. `row`/`col` are 1-based positions; null means "whole column/row". */
export interface A1Point {
  row: number | null;
  col: number | null;
  rowAbs: boolean;
  colAbs: boolean;
}

export type BinOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export type RawExpr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: ErrorCode }
  | { k: "ref"; sheet: SheetText | null; a: A1Point }
  | { k: "range"; sheet: SheetText | null; a: A1Point; b: A1Point }
  | { k: "name"; name: string }
  | { k: "call"; fn: string; args: RawExpr[] }
  | { k: "bin"; op: BinOp; l: RawExpr; r: RawExpr }
  | { k: "neg"; e: RawExpr }
  | { k: "pct"; e: RawExpr }
  | { k: "field"; e: RawExpr; field: string };

export class FormulaSyntaxError extends Error {
  override name = "FormulaSyntaxError";
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`${message} (at ${pos})`);
    this.pos = pos;
  }
}

// ---------------------------------------------------------------- lexer

type Tok =
  | { t: "num"; v: number; p: number }
  | { t: "str"; v: string; p: number }
  | { t: "sheet"; v: string; p: number } // 'quoted name' (only valid before `!`)
  | { t: "ident"; v: string; p: number }
  | { t: "err"; v: ErrorCode; p: number }
  | { t: "op"; v: string; p: number }
  | { t: "eof"; p: number };

const OPS = ["<=", ">=", "<>", "+", "-", "*", "/", "^", "&", "=", "<", ">", "%", "(", ")", ",", ":", "!", "."];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const p = i;
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[0]), p });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new FormulaSyntaxError("Unterminated string", p);
        const d = src[i]!;
        if (d === c) {
          if (src[i + 1] === c) {
            s += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += d;
        i++;
      }
      out.push(c === '"' ? { t: "str", v: s, p } : { t: "sheet", v: s, p });
      continue;
    }
    if (c === "#") {
      const code = ERROR_CODES.find((e) => src.startsWith(e, i));
      if (!code) throw new FormulaSyntaxError("Unknown error literal", p);
      out.push({ t: "err", v: code, p });
      i += code.length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      out.push({ t: "ident", v: m[0], p });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaSyntaxError(`Unexpected character '${c}'`, p);
    out.push({ t: "op", v: op, p });
    i += op.length;
  }
  out.push({ t: "eof", p: src.length });
  return out;
}

// ---------------------------------------------------------------- A1 helpers

export function colToNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function numberToCol(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)$/;
const COL_RE = /^(\$?)([A-Za-z]{1,3})$/;
const MAX_COL = 16384; // XFD, as in Excel

function asCell(id: string): A1Point | null {
  const m = CELL_RE.exec(id);
  if (!m) return null;
  const col = colToNumber(m[2]!);
  const row = Number(m[4]);
  if (col > MAX_COL || row < 1) return null;
  return { col, row, colAbs: m[1] === "$", rowAbs: m[3] === "$" };
}

function asCol(id: string): A1Point | null {
  const m = COL_RE.exec(id);
  if (!m) return null;
  const col = colToNumber(m[2]!);
  if (col > MAX_COL) return null;
  return { col, row: null, colAbs: m[1] === "$", rowAbs: false };
}

// ---------------------------------------------------------------- parser

export interface ParseOptions {
  /**
   * "cell": A1 references are recognised (normal sheet formulas).
   * "rule": no grid context, so every identifier is a name (`cooldown`, `hp1`).
   */
  mode?: "cell" | "rule";
}

/** Parse formula text. A leading `=` is optional. */
export function parseFormula(src: string, opts: ParseOptions = {}): RawExpr {
  const text = src.startsWith("=") ? src.slice(1) : src;
  const offset = src.length - text.length;
  const toks = lex(text);
  const rule = opts.mode === "rule";
  let i = 0;

  const peek = (): Tok => toks[i]!;
  const next = (): Tok => toks[i++]!;
  const isOp = (v: string, tok: Tok = peek()): boolean => tok.t === "op" && tok.v === v;
  const fail = (msg: string, tok: Tok = peek()): never => {
    throw new FormulaSyntaxError(msg, tok.p + offset);
  };
  const expectOp = (v: string): void => {
    if (!isOp(v)) fail(`Expected '${v}'`);
    i++;
  };

  // Excel precedence, loosest first. Unary minus binds tighter than ^ (-2^2 = 4).
  const levels: BinOp[][] = [["=", "<>", "<", ">", "<=", ">="], ["&"], ["+", "-"], ["*", "/"], ["^"]];

  function binary(level: number): RawExpr {
    if (level === levels.length) return unary();
    let l = binary(level + 1);
    for (;;) {
      const tok = peek();
      if (tok.t !== "op" || !(levels[level] as string[]).includes(tok.v)) return l;
      i++;
      const r = binary(level + 1);
      l = { k: "bin", op: tok.v as BinOp, l, r };
    }
  }

  function unary(): RawExpr {
    if (isOp("-")) {
      i++;
      return { k: "neg", e: unary() };
    }
    if (isOp("+")) {
      i++;
      return unary();
    }
    return postfix();
  }

  function postfix(): RawExpr {
    let e = primary();
    for (;;) {
      if (isOp("%")) {
        i++;
        e = { k: "pct", e };
      } else if (isOp(".")) {
        i++;
        const f = next();
        if (f.t !== "ident") fail("Expected field name after '.'", f);
        e = { k: "field", e, field: (f as { v: string }).v };
      } else return e;
    }
  }

  /** Parse what follows an optional `Sheet!` prefix: a cell, a cell range, or a column range. */
  function reference(sheet: SheetText | null): RawExpr {
    const tok = next();
    if (tok.t !== "ident" && tok.t !== "num") fail("Expected a cell reference", tok);
    const text = tok.t === "ident" ? tok.v : String((tok as { v: number }).v);
    const a = asCell(text) ?? asCol(text) ?? asRowOnly(tok, true);
    if (!a) return fail(`'${text}' is not a cell reference`, tok);
    if (isOp(":")) {
      i++;
      const t2 = next();
      const text2 = t2.t === "ident" ? t2.v : t2.t === "num" ? String(t2.v) : "";
      const b = asCell(text2) ?? asCol(text2) ?? asRowOnly(t2, false);
      if (!b) return fail("Expected the end of a range", t2);
      if ((a.row === null) !== (b.row === null) || (a.col === null) !== (b.col === null)) {
        fail("Mismatched range ends", t2);
      }
      return { k: "range", sheet, a, b };
    }
    if (a.row === null || a.col === null) fail("Whole-column and whole-row references need a range (A:A, 3:3)", tok);
    return { k: "ref", sheet, a };
  }

  function asRowOnly(tok: Tok, start: boolean): A1Point | null {
    // `3:5` whole-row range; the number token has been consumed already.
    if (tok.t !== "num" || !Number.isInteger(tok.v) || tok.v < 1 || (start && !isOp(":"))) return null;
    return { row: tok.v, col: null, rowAbs: false, colAbs: false };
  }

  function primary(): RawExpr {
    const tok = peek();
    switch (tok.t) {
      case "num":
        if (!rule && isOp(":", toks[i + 1])) return reference(null); // 3:5
        i++;
        return { k: "num", v: tok.v };
      case "str":
        i++;
        return { k: "str", v: tok.v };
      case "err":
        i++;
        return { k: "err", v: tok.v };
      case "sheet": {
        i++;
        expectOp("!");
        return reference(splitSheet(tok.v));
      }
      case "ident": {
        const nt = toks[i + 1]!;
        if (isOp("(", nt)) {
          i += 2;
          const args: RawExpr[] = [];
          if (!isOp(")")) {
            for (;;) {
              args.push(binary(0));
              if (isOp(",")) {
                i++;
                continue;
              }
              break;
            }
          }
          expectOp(")");
          return { k: "call", fn: tok.v.toUpperCase(), args };
        }
        if (!rule && isOp("!", nt)) {
          i += 2;
          return reference({ pack: null, sheet: tok.v });
        }
        const upper = tok.v.toUpperCase();
        if (upper === "TRUE" || upper === "FALSE") {
          i++;
          return { k: "bool", v: upper === "TRUE" };
        }
        if (!rule && (asCell(tok.v) || (asCol(tok.v) && isOp(":", nt)))) return reference(null);
        i++;
        return { k: "name", name: tok.v };
      }
      case "op":
        if (tok.v === "(") {
          i++;
          const e = binary(0);
          expectOp(")");
          return e;
        }
        return fail(`Unexpected '${tok.v}'`);
      case "eof":
        return fail("Unexpected end of formula");
    }
  }

  const e = binary(0);
  if (peek().t !== "eof") fail("Unexpected trailing input");
  return e;
}

function splitSheet(s: string): SheetText {
  const slash = s.lastIndexOf("/");
  return slash < 0 ? { pack: null, sheet: s } : { pack: s.slice(0, slash), sheet: s.slice(slash + 1) };
}
