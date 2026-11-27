// Editing several entities at once (DESIGN §9.3): the entity page's selection as one form.
// Each field shows the value they share, or that they differ and how; setting it writes it to
// every one of them as one change, except where a formula computes it (left as it is). Apart
// from React, so it's tested in Node.

import type { Entity, FieldDef, JsonValue, Patch, Project } from "@thek42/sapwood-core";
import { formOf } from "./form.ts";

export interface MultiField {
  def: FieldDef;
  /** The value every one of them has (undefined: all blank); only when `same`. */
  value: unknown;
  same: boolean;
  /** The different values, each once, in the order first met (undefined for blank). */
  values: unknown[];
  /** IDs of those where a formula computes it: a write leaves them alone. */
  computed: string[];
  /** How many of them have an issue on this field. */
  withIssues: number;
}

export interface MultiForm {
  /** The type when they're all one type, else null (only the fields of one type are shown). */
  type: string | null;
  entities: Entity[];
  fields: MultiField[];
  /** How many are commented out, and how many marked "don't suggest moving". */
  inactive: number;
  kept: number;
  /** Errors and warnings across them, on any field or the row. */
  errors: number;
  warnings: number;
}

/** A value's identity for comparing: JSON with keys in order. */
export function canon(v: unknown): string {
  if (v === undefined) return "";
  return JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x,
  );
}

export function multiFormOf(project: Project, entities: Entity[]): MultiForm {
  const types = new Set(entities.map((e) => e.type));
  const type = types.size === 1 ? [...types][0]! : null;
  const forms = entities.map((e) => formOf(project, e));
  const fields: MultiField[] = [];
  if (type !== null)
    forms[0]?.fields.forEach((f0, i) => {
      const seen = new Map<string, unknown>();
      const computed: string[] = [];
      let withIssues = 0;
      forms.forEach((form) => {
        const f = form.fields[i]!;
        const k = canon(f.value);
        if (!seen.has(k)) seen.set(k, f.value);
        if (f.formula !== null && form.entity.id !== null) computed.push(form.entity.id);
        if (f.issues.length) withIssues++;
      });
      const values = [...seen.values()];
      fields.push({ def: f0.def, value: values.length === 1 ? values[0] : undefined, same: values.length === 1, values, computed, withIssues });
    });
  let errors = 0;
  let warnings = 0;
  for (const form of forms)
    for (const i of [...form.rowIssues, ...form.fields.flatMap((f) => f.issues)]) {
      if (i.level === "error") errors++;
      else warnings++;
    }
  const kept = entities.filter((e) => project.doc.sheets.get(e.at.sheet)?.rowFlags.get(e.at.row)?.has("keepHere")).length;
  return { type, entities, fields, inactive: entities.filter((e) => !e.active).length, kept, errors, warnings };
}

/** The patches that set one field to a value on each of them (by ID), but those a formula computes. */
export function setAll(entities: Entity[], field: string, value: unknown, computed: readonly string[] = []): Patch[] {
  const skip = new Set(computed);
  return entities
    .filter((e) => e.id !== null && !skip.has(e.id))
    .map((e) => ({ op: "set", id: e.id!, fields: { [field]: value === undefined ? null : (value as JsonValue) } }) as Patch);
}

/** The patches that comment out (or uncomment) each of them, or set their "don't suggest moving" mark. */
export function markAll(entities: Entity[], what: "active" | "keepHere", on: boolean): Patch[] {
  return entities
    .filter((e) => e.id !== null && (what === "keepHere" || e.active !== on))
    .map((e) => ({ op: "set", id: e.id!, fields: { [what === "active" ? "$active" : "$keepHere"]: on } }) as Patch);
}

/** A short list of the different values: "10, 20, 35 and 2 more"; blank as "blank". */
export function differing(values: unknown[], show: (v: unknown) => string, max = 3): string {
  // "and 1 more" says less than the one it hides.
  const shown = values.slice(0, values.length === max + 1 ? max + 1 : max).map((v) => (v === undefined ? "blank" : show(v)));
  const more = values.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
}
