// The validation pipeline (DESIGN §8.4 step 3, §5.7):
//   parse → presence and constraints → global ID uniqueness → refs → pack reach → custom rules.
//
// Inactive (commented-out) rows are skipped by every step except one: a ref that points
// at an inactive entity is an error (§6.2).

import type { PackId } from "../formula/model.ts";
import { numberToCol } from "../formula/parse.ts";
import { display, isErr, scalar, toBool, type Value } from "../formula/values.ts";
import type { FieldDef, FieldType } from "../schema/model.ts";
import { refAccepts } from "../schema/resolve.ts";
import type { Entity, FieldEntry, Issue, Location, Project, Projection, SingletonEntry } from "./project.ts";
import { datetime, duration, Ref, type FieldValue } from "./values.ts";

export interface Validation {
  projection: Projection;
  issues: Issue[];
  errors: number;
  warnings: number;
}

interface RefUse {
  ref: Ref;
  targets: string[] | "any";
  reach?: "descendants";
  /** The pack the reference lives in: the entity's, or the singleton's. */
  from: PackId;
  field: string;
  at: Location;
}

export function validate(project: Project): Validation {
  const projection = project.project();
  const issues: Issue[] = [];
  for (const i of project.schema.issues) issues.push({ level: "error", code: "schema", message: `${i.path}: ${i.message}` });
  issues.push(...projection.issues);
  const refs: RefUse[] = [];
  const active = projection.entities.filter((e) => e.active);

  // ---- presence and constraints
  for (const e of active) {
    const t = project.schema.types.get(e.type)!;
    for (const f of t.fields) {
      const entry = e.fields.get(f.def.name);
      const at = entry?.cells[0] ?? e.at;
      checkField(project, f.def, entry, at, e.pack, e.type, issues, refs);
    }
  }

  // ---- singletons: one active entry per field, in the singleton's pack, required fields present
  const byField = new Map<string, SingletonEntry[]>();
  for (const s of projection.singletons) {
    if (!s.active) continue;
    const k = `${s.type}.${s.path.join(".")}`;
    byField.set(k, [...(byField.get(k) ?? []), s]);
  }
  for (const [k, entries] of byField)
    if (entries.length > 1)
      for (const s of entries) issues.push({ level: "error", code: "singleton.duplicate", message: `${k} has ${entries.length} active entries; keep one, or comment the others out`, at: colA(project, s.at) });
  for (const [name, t] of project.schema.types) {
    if (!t.def.singleton) continue;
    const pack = t.def.pack ?? project.wb.root;
    const mine = projection.singletons.filter((s) => s.active && s.type === name);
    for (const s of mine) {
      const sheetPack = project.wb.sheet(s.at.sheet).pack;
      if (sheetPack !== pack)
        issues.push({ level: "error", code: "singleton.pack", message: `${name} lives in pack ${pack}; this entry is on a sheet in ${sheetPack}`, at: colA(project, s.at) });
      if ((byField.get(`${name}.${s.path.join(".")}`)?.length ?? 0) > 1) continue;
      const entry: FieldEntry = { field: s.field, cells: [], formula: s.formula };
      if (s.value !== undefined) entry.value = s.value;
      if (s.invalid) entry.invalid = true;
      checkField(project, s.field, entry, { ...s.at, ...(colB(project, s.at) ?? {}) }, pack, name, issues, refs, s.path.join("."));
    }
    // Required top-level fields with no entry at all (sub-fields of split structs count as an entry).
    for (const f of t.fields)
      if (f.def.required && !mine.some((s) => s.path[0] === f.def.name))
        issues.push({ level: "error", code: "field.required", message: `${name}.${f.def.name} is required, but has no entry` });
  }

  // ---- IDs: present, globally unique (case-insensitive, Q3)
  const byId = new Map<string, Entity[]>();
  for (const e of projection.entities) if (e.id !== null) byId.set(e.id.toLowerCase(), [...(byId.get(e.id.toLowerCase()) ?? []), e]);
  for (const e of active) {
    const at = { ...e.at, ...(colB(project, e.at) ?? {}) };
    if (e.id === null) {
      if (!projection.issues.some((i) => i.at?.row === e.at.row && i.code.startsWith("id.")))
        issues.push({ level: "error", code: "id.missing", message: `This ${e.type} has no ID`, at });
      continue;
    }
    const same = byId.get(e.id.toLowerCase())!.filter((x) => x.active);
    if (same.length > 1) {
      const others = same.filter((x) => x !== e).map((x) => `${x.type} on ${project.wb.sheet(x.at.sheet).name}`);
      const exact = same.every((x) => x.id === e.id);
      issues.push({ level: "error", code: "id.duplicate", message: `ID "${e.id}" is also used by ${others.join(", ")}${exact ? "" : " (IDs are unique regardless of case)"}`, at });
    }
    const f = formulaText(project, at);
    if (f && /\b(ROW|COLUMN)\s*\(/i.test(f))
      issues.push({ level: "warning", code: "id.positional", message: "This ID uses ROW() or COLUMN(): moving the row renames the entity", at });
  }

  // ---- refs and pack reach (§5.3, §7.2)
  for (const u of refs) {
    const list = byId.get(u.ref.id.toLowerCase()) ?? [];
    const exact = list.filter((x) => x.id === u.ref.id);
    const target = exact.find((x) => x.active) ?? exact[0];
    if (!target) {
      const near = list[0];
      issues.push({ level: "error", code: "ref.missing", message: `${u.field}: no entity "${u.ref.id}"${near ? ` (IDs are case-sensitive: did you mean "${near.id}"?)` : ""}`, at: u.at });
      continue;
    }
    if (!target.active) {
      issues.push({ level: "error", code: "ref.inactive", message: `${u.field}: "${u.ref.id}" is commented out`, at: u.at });
      continue;
    }
    if (!refAccepts(project.schema, u.targets, target.type)) {
      const want = u.targets === "any" ? "an entity" : u.targets.join(" or ");
      issues.push({ level: "error", code: "ref.type", message: `${u.field}: "${u.ref.id}" is a ${target.type}, not ${want}`, at: u.at });
      continue;
    }
    if (!reachable(project, u.from, target.pack, u.reach))
      issues.push({
        level: "error",
        code: "ref.reach",
        message: `${u.field}: "${u.ref.id}" is in pack ${target.pack}, which ${u.from} can't reach. Refs may point at their own pack or its ancestors${u.reach ? " and descendants" : ""}`,
        at: u.at,
      });
  }

  // ---- custom rules (§5.7)
  const unique = (e: Entity) => e.id !== null && byId.get(e.id.toLowerCase())!.filter((x) => x.active).length === 1;
  for (const r of project.schema.schema.rules) {
    const run = (entity: Entity | null) => {
      let v: Value;
      try {
        v = project.engine.evalRule(r.expr, entity?.id ?? null);
      } catch (err) {
        v = null;
        issues.push({ level: "error", code: "rule.invalid", message: `Rule ${r.id}: ${(err as Error).message}`, ...(entity ? { at: entity.at } : {}) });
        return;
      }
      const b = toBool(scalar(v));
      if (isErr(b)) {
        const why = isErr(v) ? `${v.code}${v.detail ? " " + v.detail : ""}` : `got ${display(v)}`;
        issues.push({ level: "error", code: "rule.error", message: `Rule ${r.id} couldn't be checked: ${why}`, ...(entity ? { at: entity.at } : {}) });
      } else if (!b) issues.push({ level: r.severity, code: "rule", message: r.message, ...(entity ? { at: entity.at } : {}) });
    };
    if (r.type === undefined) {
      run(null);
      continue;
    }
    const target = r.type;
    for (const e of active)
      if ((e.type === target || project.schema.types.get(e.type)!.traits.has(target)) && unique(e)) run(e);
  }

  return {
    projection,
    issues,
    errors: issues.filter((i) => i.level === "error").length,
    warnings: issues.filter((i) => i.level === "warning").length,
  };
}

/** Own pack or an ancestor; descendants too when the field allows it. */
function reachable(project: Project, from: PackId, to: PackId, reach?: "descendants"): boolean {
  if (project.wb.canReach(from, to)) return true;
  return reach === "descendants" && project.wb.canReach(to, from);
}

function checkField(
  project: Project,
  def: FieldDef,
  entry: FieldEntry | undefined,
  at: Location,
  pack: PackId,
  owner: string,
  issues: Issue[],
  refs: RefUse[],
  label = def.name,
): void {
  if (entry?.invalid) return; // the parse error is already reported
  if (entry?.value === undefined) {
    if (def.required)
      issues.push({
        level: "error",
        code: "field.required",
        message: entry ? `${label} is required` : `${label} is required, but this sheet's ${owner} layout has no column for it`,
        at,
      });
    return;
  }
  checkValue(project, def, def.type, entry.value, label, at, pack, issues, refs);
}

function checkValue(
  project: Project,
  def: FieldDef,
  type: FieldType,
  v: FieldValue,
  label: string,
  at: Location,
  pack: PackId,
  issues: Issue[],
  refs: RefUse[],
): void {
  const bad = (message: string) => issues.push({ level: "error", code: "field.constraint", message: `${label}: ${message}`, at });
  switch (type.kind) {
    case "string": {
      const s = v as string;
      if (def.nonEmpty && s.trim() === "") bad("must not be empty");
      if (def.minLength !== undefined && [...s].length < def.minLength) bad(`must be at least ${def.minLength} characters`);
      if (def.maxLength !== undefined && [...s].length > def.maxLength) bad(`must be at most ${def.maxLength} characters`);
      if (def.pattern !== undefined && !new RegExp(def.pattern, "u").test(s)) bad(`must match ${def.pattern}`);
      return;
    }
    case "int":
    case "float": {
      const n = v as number;
      if (!Number.isFinite(n)) {
        if (type.kind === "int" || def.finite !== false) bad("must be a finite number");
        return;
      }
      if (typeof def.min === "number" && n < def.min) bad(`must be at least ${def.min}`);
      if (typeof def.max === "number" && n > def.max) bad(`must be at most ${def.max}`);
      return;
    }
    case "datetime":
    case "duration": {
      const parse = type.kind === "datetime" ? datetime : duration;
      const asNum = (x: FieldValue) => (type.kind === "datetime" ? Date.parse(x as string) : (x as number));
      for (const [key, cmp] of [["min", -1], ["max", 1]] as const) {
        const raw = def[key];
        if (raw === undefined) continue;
        const lim = typeof raw === "number" ? { ok: true as const, value: raw } : parse(raw);
        if (!lim.ok) continue; // reported as a schema problem in a later slice
        const limit = asNum(lim.value);
        if (Math.sign(asNum(v) - limit) === cmp) bad(`must be ${key === "min" ? "at or after" : "at or before"} ${raw}`);
      }
      return;
    }
    case "ref":
      refs.push({ ref: v as Ref, targets: type.targets, ...(def.reach ? { reach: def.reach } : {}), from: pack, field: label, at });
      return;
    case "list": {
      const items = v as FieldValue[];
      if (def.minItems !== undefined && items.length < def.minItems) bad(`needs at least ${def.minItems} item${def.minItems === 1 ? "" : "s"}`);
      if (def.maxItems !== undefined && items.length > def.maxItems) bad(`allows at most ${def.maxItems} item${def.maxItems === 1 ? "" : "s"}`);
      if (def.unique) {
        const seen = new Set<string>();
        for (const x of items) {
          const k = JSON.stringify(x instanceof Ref ? { $ref: x.id } : x);
          if (seen.has(k)) bad(`has ${x instanceof Ref ? `"${x.id}"` : k} twice, but must be unique`);
          seen.add(k);
        }
      }
      items.forEach((x, i) => checkValue(project, def, type.of, x, `${label}[${i}]`, at, pack, issues, refs));
      return;
    }
    case "struct":
    case "union": {
      const obj = v as { [k: string]: FieldValue };
      let fields: FieldDef[];
      if (type.kind === "struct") fields = project.schema.structs.get(type.name)?.fields ?? [];
      else {
        const u = project.schema.unions.get(type.name);
        fields = project.schema.structs.get(obj[u?.discriminator ?? "kind"] as string)?.fields ?? [];
      }
      for (const f of fields) {
        const sub = obj[f.name];
        const p = `${label}.${f.name}`;
        if (sub === undefined) {
          if (f.required) issues.push({ level: "error", code: "field.required", message: `${p} is required`, at });
          continue;
        }
        checkValue(project, f, f.type, sub, p, at, pack, issues, refs);
      }
      return;
    }
    default:
      return; // bool, enum and json are fully checked by parsing
  }
}

const colA = (project: Project, at: Location): Location => ({ ...at, col: project.wb.sheet(at.sheet).cols.idAt(1) });

/** The column-B cell of a row, as a location. */
function colB(project: Project, at: Location): { col: string } | null {
  const cols = project.wb.sheet(at.sheet).cols;
  return cols.length >= 2 ? { col: cols.idAt(2) } : null;
}

function formulaText(project: Project, at: Location): string | null {
  if (!at.col) return null;
  const s = project.wb.sheet(at.sheet);
  const r = s.rows.posOf(at.row);
  const c = s.cols.posOf(at.col);
  if (r === null || c === null) return null;
  return project.engine.formula(at.sheet, `${numberToCol(c)}${r}`);
}
