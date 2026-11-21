// What a cell holds, in the stored form ops carry (DESIGN §8.1): nothing, a literal, a
// formula bound against stable IDs, or formula text that didn't parse or bind. The
// stored form never depends on where rows and columns are, so ops replay and rebase
// without rewriting formula text.

import type { Expr } from "./bind.ts";
import type { ErrorCode } from "./parse.ts";

export type Literal = string | number | boolean;

export type Content =
  | null
  | { v: Literal }
  | { f: Expr }
  /** Formula text that failed to parse or bind, kept as typed, with the error it shows. */
  | { bad: string; code: ErrorCode; message: string };

/** A canonical string for a content, for comparing contents and keying conflicts. */
export function contentKey(c: Content): string {
  return c === null ? "" : stableJson(c);
}

/** Equal contents: the same as comparing contentKey()s, without building them. */
export function sameContent(a: Content, b: Content): boolean {
  return sameJson(a, b);
}

function sameJson(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  const xo = x !== null && typeof x === "object";
  const yo = y !== null && typeof y === "object";
  // Primitives compare as stableJson writes them (NaN and undefined write as null).
  if (!xo || !yo) return !xo && !yo && (JSON.stringify(x) ?? "null") === (JSON.stringify(y) ?? "null");
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  if (Array.isArray(x)) {
    const ys = y as unknown[];
    return x.length === ys.length && x.every((v, i) => sameJson(v, ys[i]));
  }
  const o = x as Record<string, unknown>;
  const p = y as Record<string, unknown>;
  const ok = Object.keys(o).filter((k) => o[k] !== undefined);
  const pk = Object.keys(p).filter((k) => p[k] !== undefined);
  return ok.length === pk.length && ok.every((k) => k in p && sameJson(o[k], p[k]));
}

/** JSON with object keys sorted, so equal values give equal strings. */
export function stableJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map(stableJson).join(",")}]`;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}
