// Entity and cell history, as the history panel shows it (DESIGN §8.7): what a commit
// changed in an entity, field by field, and the fields to write to put an entity back as it
// was at a commit. Apart from React, so it's tested in Node.

import type { EntityJson, JsonValue, ResolvedSchema } from "@thek42/sapwood-core";

export interface FieldChange {
  field: string;
  before: string | null;
  after: string | null;
}

const META = ["$id", "$pack", "$sheet", "$active"];

/** A value as the panel shows it: a formula as its text (and value), JSON otherwise. */
export function shown(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ("$formula" in o) return `${String(o.$formula)} (${o.$value === null ? "blank" : JSON.stringify(o.$value)})`;
    if ("$invalid" in o) return `${String(o.$invalid)} (doesn't read)`;
  }
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** What changed between two versions of an entity: where it is and its ID first, then its fields. */
export function entityDiff(before: EntityJson | null, after: EntityJson | null): FieldChange[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => k !== "$type" && k !== "$keepHere");
  keys.sort((x, y) => {
    const i = META.indexOf(x), j = META.indexOf(y);
    return (i < 0 ? 99 : i) - (j < 0 ? 99 : j);
  });
  const out: FieldChange[] = [];
  for (const k of keys) {
    const x = k === "$active" ? (before ? (b[k] ? "active" : "commented out") : null) : shown(b[k]);
    const y = k === "$active" ? (after ? (a[k] ? "active" : "commented out") : null) : shown(a[k]);
    if (x !== y) out.push({ field: k.replace(/^\$/, ""), before: x, after: y });
  }
  return out;
}

/**
 * The fields to write (with `set`, or `create` if it's gone) to put an entity back as it was:
 * every field the type has now, blank where it was blank then; formulas as formulas; its
 * commented-out state. A value that didn't read then is left as it is now, and named.
 */
export function restoreFields(schema: ResolvedSchema, was: EntityJson): { fields: Record<string, JsonValue>; skipped: string[] } {
  const t = schema.types.get(was.$type);
  const fields: Record<string, JsonValue> = { $active: was.$active };
  const skipped: string[] = [];
  for (const f of t?.fields ?? []) {
    const v = (was as Record<string, unknown>)[f.def.name];
    if (v !== null && typeof v === "object" && !Array.isArray(v) && "$invalid" in v) skipped.push(f.def.name);
    else if (v !== null && typeof v === "object" && !Array.isArray(v) && "$formula" in v) fields[f.def.name] = { $formula: (v as { $formula: string }).$formula };
    else fields[f.def.name] = (v ?? null) as JsonValue;
  }
  return { fields, skipped };
}
