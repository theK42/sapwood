// Row classification (DESIGN §6.2): what column A says a row is.

import type { ResolvedSchema } from "../schema/resolve.ts";

export type RowClass =
  | { kind: "scratch" }
  | { kind: "comment" }
  /** A row of an entity type. Inactive when commented out (`#Weapon`). */
  | { kind: "entity"; type: string; active: boolean }
  /** A singleton block header (`GameConfig`, `#GameConfig`). */
  | { kind: "header"; type: string; active: boolean }
  /**
   * A singleton field row: `.field` (in a block; `type` is null until the block is known)
   * or `GameConfig.field` (qualified). `path` is the field name, then struct sub-fields.
   */
  | { kind: "field"; type: string | null; path: string[]; active: boolean }
  | { kind: "error"; message: string };

const PATH = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

/** Classify the text in column A. A formula in column A is reported by the caller. */
export function classify(schema: ResolvedSchema, a: string): RowClass {
  const text = a.trim();
  if (text === "") return { kind: "scratch" };
  const active = !text.startsWith("#");
  // `#Weapon` is a commented-out row; `# Weapon …` (with a space) is a comment.
  const body = active ? text : text.slice(1);

  if (body.startsWith(".")) {
    const path = body.slice(1);
    if (PATH.test(path)) return { kind: "field", type: null, path: path.split("."), active };
    return active ? { kind: "error", message: `"${text}" isn't a field row: write .field or .field.sub` } : { kind: "comment" };
  }
  if (PATH.test(body)) {
    const [name, ...path] = body.split(".");
    const t = schema.types.get(name!);
    if (t && path.length === 0) return t.def.singleton ? { kind: "header", type: name!, active } : { kind: "entity", type: name!, active };
    if (t?.def.singleton) return { kind: "field", type: name!, path, active };
    if (t) return active ? { kind: "error", message: `${name} isn't a singleton, so "${text}" isn't a field row` } : { kind: "comment" };
  }
  if (!active) return { kind: "comment" }; // `#` + anything else
  return { kind: "error", message: unknownType(schema, body) };
}

function unknownType(schema: ResolvedSchema, text: string): string {
  const name = text.split(".")[0]!;
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const t of schema.types.keys()) {
    if (t.toLowerCase() === lower) return `Unknown type "${name}" (types are case-sensitive: did you mean "${t}"?)`;
    const d = distance(lower, t.toLowerCase());
    if (d < bestD) (bestD = d), (best = t);
  }
  const hint = best !== null && bestD <= Math.max(1, Math.floor(name.length / 4)) ? ` Did you mean "${best}"?` : "";
  return `Unknown type "${name}". Put # in front to make this a comment row.${hint}`;
}

/** Levenshtein distance, for "did you mean" hints. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}
