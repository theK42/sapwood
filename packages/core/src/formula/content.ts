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

export function sameContent(a: Content, b: Content): boolean {
  return contentKey(a) === contentKey(b);
}

/** JSON with object keys sorted, so equal values give equal strings. */
export function stableJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map(stableJson).join(",")}]`;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}
