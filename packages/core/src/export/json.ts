// JSON export (DESIGN §10): one file per pack plus a manifest.
//
// Deterministic: the same project state gives byte-identical files. Types and entity
// IDs are sorted, fields follow schema order, and nothing depends on the clock (the
// caller supplies `exportedAt`). Only active entities and computed values are exported;
// scratch never is. Blank optional fields are omitted, and blank fields with a default
// export the default.

import type { PackId } from "../formula/model.ts";
import type { FieldDef, FieldType } from "../schema/model.ts";
import { parseCell, Json, Ref, type FieldValue } from "../project/values.ts";
import type { Entity, Project } from "../project/project.ts";
import { validate, type Validation } from "../project/validate.ts";
import { sha256 } from "./sha256.ts";

export interface ExportOptions {
  branch?: string;
  commit?: string;
  schemaVersion?: string;
  /** ISO time to stamp the manifest with. Omitted from the manifest when absent. */
  exportedAt?: string;
  /** How refs are written (§10.2): `{ type, id }` objects (default) or bare IDs. */
  refs?: "object" | "id";
  /** Export even with validation errors; the manifest says so. */
  allowInvalid?: boolean;
}

export interface ExportFile {
  path: string;
  content: string;
}

export class ExportRefused extends Error {
  readonly validation: Validation;
  constructor(validation: Validation) {
    super(`Export refused: ${validation.errors} validation error${validation.errors === 1 ? "" : "s"}. Fix them, or export with allowInvalid.`);
    this.validation = validation;
  }
}

type JsonOut = null | boolean | number | string | JsonOut[] | { [k: string]: JsonOut };

export function exportJson(project: Project, opts: ExportOptions = {}): ExportFile[] {
  const v = validate(project);
  if (v.errors > 0 && !opts.allowInvalid) throw new ExportRefused(v);
  const schema = project.schema;
  const refsAs = opts.refs ?? "object";

  // Ref targets' types, for `{ type, id }`. IDs are unique once validation passes.
  const typeOf = new Map<string, string>();
  for (const e of v.projection.entities) if (e.active && e.id !== null && !typeOf.has(e.id)) typeOf.set(e.id, e.type);

  const out = (type: FieldType, x: FieldValue): JsonOut => {
    if (x instanceof Ref) return refsAs === "id" ? x.id : { type: typeOf.get(x.id) ?? null, id: x.id };
    if (x instanceof Json) return x.value as JsonOut;
    switch (type.kind) {
      case "list":
        return (x as FieldValue[]).map((el) => out(type.of, el));
      case "struct":
        return struct(schema.structs.get(type.name)?.fields ?? [], x as Record<string, FieldValue>, null);
      case "union": {
        const u = schema.unions.get(type.name)!;
        const o = x as Record<string, FieldValue>;
        const variant = o[u.discriminator] as string;
        return struct(schema.structs.get(variant)?.fields ?? [], o, { key: u.discriminator, value: variant });
      }
      default:
        return x as JsonOut;
    }
  };
  // Struct and union fields: schema order, the discriminator first, defaults applied.
  const struct = (fields: FieldDef[], o: Record<string, FieldValue>, tag: { key: string; value: string } | null): JsonOut => {
    const res: { [k: string]: JsonOut } = {};
    if (tag) res[tag.key] = tag.value;
    for (const f of fields) {
      const val = o[f.name] ?? defaultOf(f);
      if (val !== undefined) res[f.name] = out(f.type, val);
    }
    return res;
  };
  const defaultOf = (f: FieldDef): FieldValue | undefined => {
    if (f.default === undefined) return undefined;
    const r = parseCell(schema, f.type, f.default, false);
    return r?.ok ? r.value : undefined;
  };

  // ---- entities by pack, then type, then ID
  const packs = new Map<PackId, Map<string, Map<string, JsonOut>>>();
  for (const p of project.wb.packs.keys()) packs.set(p, new Map());
  for (const e of v.projection.entities) {
    if (!e.active || e.id === null) continue;
    const byType = packs.get(e.pack)!;
    if (!byType.has(e.type)) byType.set(e.type, new Map());
    byType.get(e.type)!.set(e.id, entityJson(e));
  }
  function entityJson(e: Entity): JsonOut {
    const t = schema.types.get(e.type)!;
    const res: { [k: string]: JsonOut } = {};
    for (const f of t.fields) {
      const val = e.fields.get(f.def.name)?.value ?? defaultOf(f.def);
      if (val !== undefined) res[f.def.name] = out(f.def.type, val);
    }
    return res;
  }

  // ---- singletons, into their pack; a singleton with no entries is omitted (§10.1)
  const singletons = new Map<PackId, Map<string, JsonOut>>();
  for (const [name, t] of schema.types) {
    if (!t.def.singleton) continue;
    const entries = v.projection.singletons.filter((s) => s.active && s.type === name && s.value !== undefined);
    if (!entries.length) continue;
    // Rebuild the nested value: `.reviveCost.amount` rows become { reviveCost: { amount } }.
    const raw: Record<string, FieldValue> = {};
    for (const s of entries) {
      let o = raw as Record<string, FieldValue>;
      for (const k of s.path.slice(0, -1)) o = (o[k] ??= {}) as Record<string, FieldValue>;
      o[s.path[s.path.length - 1]!] = s.value!;
    }
    const res: { [k: string]: JsonOut } = {};
    for (const f of t.fields) {
      const val = raw[f.def.name] ?? defaultOf(f.def);
      if (val !== undefined) res[f.def.name] = out(f.def.type, val);
    }
    const pack = t.def.pack ?? project.wb.root;
    if (!singletons.has(pack)) singletons.set(pack, new Map());
    singletons.get(pack)!.set(name, res);
  }

  // ---- files, packs in tree order (parents first, siblings by name)
  const files: ExportFile[] = [];
  const listed: { name: string; parent: string | null; file: string; sha256: string }[] = [];
  for (const pack of treeOrder(project)) {
    const p = project.wb.packs.get(pack)!;
    const doc: { [k: string]: JsonOut } = { pack: p.name, parent: p.parent };
    if (opts.commit !== undefined) doc.commit = opts.commit;
    doc.types = sorted(packs.get(pack)!, (byId) => sorted(byId, (x) => x));
    const s = singletons.get(pack);
    if (s) doc.singletons = sorted(s, (x) => x);
    const content = JSON.stringify(doc, null, 2) + "\n";
    const file = `${p.name}.json`;
    files.push({ path: file, content });
    listed.push({ name: p.name, parent: p.parent, file, sha256: sha256(content) });
  }
  const manifest: { [k: string]: JsonOut } = {};
  if (opts.branch !== undefined) manifest.branch = opts.branch;
  if (opts.commit !== undefined) manifest.commit = opts.commit;
  if (opts.exportedAt !== undefined) manifest.exportedAt = opts.exportedAt;
  if (opts.schemaVersion !== undefined) manifest.schemaVersion = opts.schemaVersion;
  if (v.errors > 0) manifest.invalid = { errors: v.errors };
  manifest.packs = listed;
  files.unshift({ path: "manifest.json", content: JSON.stringify(manifest, null, 2) + "\n" });
  return files;
}

/** A map as a JSON object with keys in code-point order (stable everywhere, unlike locale order). */
function sorted<V>(m: Map<string, V>, f: (v: V) => JsonOut): { [k: string]: JsonOut } {
  const res: { [k: string]: JsonOut } = {};
  for (const k of [...m.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) res[k] = f(m.get(k)!);
  return res;
}

function treeOrder(project: Project): PackId[] {
  const kids = new Map<PackId | null, PackId[]>();
  for (const p of project.wb.packs.values()) kids.set(p.parent, [...(kids.get(p.parent) ?? []), p.id]);
  const out: PackId[] = [];
  const walk = (id: PackId) => {
    out.push(id);
    for (const k of (kids.get(id) ?? []).sort()) walk(k);
  };
  walk(project.wb.root);
  return out;
}
