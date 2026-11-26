// The schema's text form (DESIGN §5.8): what `sapwood schema get` prints and
// `sapwood schema apply` reads.
//
// IDs are part of the text, so renaming something in the file is a rename, not a delete
// plus an add. Items written without an ID get a fresh one on parse. The writer is
// deterministic: the same schema always prints the same bytes.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  emptySchema,
  formatType,
  parseType,
  TypeSyntaxError,
  type EnumDef,
  type FieldDef,
  type Id,
  type RuleDef,
  type Schema,
  type StructDef,
  type TraitDef,
  type TypeDef,
  type UnionDef,
  type WizardDef,
  type WizardParam,
  type WizardRow,
  type WizardStep,
} from "./model.ts";

export interface SchemaIssue {
  /** Where, as a dotted path: `types.Weapon.fields.cooldown`. */
  path: string;
  message: string;
}

// ------------------------------------------------------------ parse

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const SECTIONS = ["enums", "traits", "structs", "unions", "types", "rules", "wizards"] as const;
const FIELD_KEYS = [
  "id", "type", "description", "required", "default", "min", "max", "finite", "minLength", "maxLength",
  "pattern", "nonEmpty", "minItems", "maxItems", "unique", "reach", "jsonSchema",
] as const;
const PREFIX = { enums: "e", traits: "tr", structs: "s", unions: "u", types: "t", rules: "r", wizards: "w", fields: "f" } as const;

export interface ParseOptions {
  /**
   * The schema the text was edited from (`schema apply`). An item written without an ID
   * takes the ID of the item of the same name in the same place there (a rule: the same
   * type and expression), unless the text gives that ID to something else; fresh IDs never
   * reuse one of its IDs.
   */
  existing?: Schema;
}

/** Parse schema YAML. Problems with the text itself are issues; the meaning is checked by `resolve`. */
export function parseSchema(text: string, opts: ParseOptions = {}): { schema: Schema; issues: SchemaIssue[] } {
  const issues: SchemaIssue[] = [];
  const schema = emptySchema();
  let doc: unknown;
  try {
    doc = parseYaml(text, { uniqueKeys: true }) ?? {};
  } catch (e) {
    return { schema, issues: [{ path: "", message: (e as Error).message }] };
  }
  if (!isObj(doc)) return { schema, issues: [{ path: "", message: "The schema must be a map of sections" }] };
  const issue = (path: string, message: string) => issues.push({ path, message });
  for (const k of Object.keys(doc)) if (!(SECTIONS as readonly string[]).includes(k)) issue(k, `Unknown section "${k}"`);

  // IDs given in the text are collected first, so fresh ones never collide with them.
  const inText = new Set<Id>();
  collectIds(doc, inText);
  const used = new Set<Id>(inText);
  const old = opts.existing;
  const oldIds = new Set<Id>();
  if (old)
    for (const k of SECTIONS)
      for (const d of old[k] as { id: Id; fields?: FieldDef[] }[]) {
        oldIds.add(d.id);
        for (const f of d.fields ?? []) oldIds.add(f.id);
      }
  const counters = new Map<string, number>();
  const fresh = (prefix: string): Id => {
    let n = counters.get(prefix) ?? 0;
    let id: Id;
    do id = `${prefix}${++n}`;
    while (used.has(id) || oldIds.has(id));
    counters.set(prefix, n);
    used.add(id);
    return id;
  };
  const priorDef = (k: (typeof SECTIONS)[number], name: string): Id | undefined => (old?.[k] as { id: Id; name?: string }[] | undefined)?.find((d) => d.name === name)?.id;
  const priorField = (owner: Id | undefined, name: string): Id | undefined => {
    if (!old || owner === undefined) return undefined;
    const d = [...old.types, ...old.traits, ...old.structs].find((x) => x.id === owner);
    return d?.fields.find((f) => f.name === name)?.id;
  };
  const idOf = (v: Obj, prefix: string, path: string, prior?: Id): Id => {
    if (v.id === undefined) {
      if (prior !== undefined && !used.has(prior)) {
        used.add(prior);
        return prior;
      }
      return fresh(prefix);
    }
    if (typeof v.id !== "string" || v.id === "") {
      issue(`${path}.id`, "An ID must be a non-empty string");
      return fresh(prefix);
    }
    return v.id;
  };
  const optString = (v: Obj, key: string, path: string): string | undefined => {
    if (v[key] === undefined) return undefined;
    if (typeof v[key] !== "string") issue(`${path}.${key}`, `"${key}" must be text`);
    return String(v[key]);
  };
  const names = (v: unknown, path: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      issue(path, "Expected a list of names");
      return [];
    }
    return v as string[];
  };
  const unknownKeys = (v: Obj, allowed: readonly string[], path: string) => {
    for (const k of Object.keys(v)) if (!allowed.includes(k)) issue(`${path}.${k}`, `Unknown property "${k}"`);
  };
  const section = (key: (typeof SECTIONS)[number]): [string, Obj, string][] => {
    const v = doc[key];
    if (v === undefined || v === null) return [];
    if (!isObj(v)) {
      issue(key, `"${key}" must be a map of names to definitions`);
      return [];
    }
    return Object.entries(v).map(([name, def]) => {
      const path = `${key}.${name}`;
      if (!isObj(def)) {
        issue(path, "Expected a map");
        return [name, {}, path];
      }
      return [name, def, path];
    });
  };

  const fields = (v: unknown, path: string, owner?: Id): FieldDef[] => {
    if (v === undefined || v === null) return [];
    if (!isObj(v)) {
      issue(path, "Fields must be a map of names to definitions");
      return [];
    }
    const out: FieldDef[] = [];
    for (const [name, raw] of Object.entries(v)) {
      const p = `${path}.${name}`;
      // Shorthand: `conditions: "list<union<Condition>>"`.
      const def: Obj = typeof raw === "string" ? { type: raw } : isObj(raw) ? raw : {};
      if (!isObj(raw) && typeof raw !== "string") issue(p, "Expected a type or a map");
      unknownKeys(def, FIELD_KEYS, p);
      const f: FieldDef = { id: idOf(def, PREFIX.fields, p, priorField(owner, name)), name, type: { kind: "string" } };
      if (typeof def.type !== "string") issue(`${p}.type`, "Every field needs a type");
      else
        try {
          f.type = parseType(def.type);
        } catch (e) {
          if (!(e instanceof TypeSyntaxError)) throw e;
          issue(`${p}.type`, e.message);
        }
      for (const key of FIELD_KEYS) {
        if (key === "id" || key === "type" || def[key] === undefined) continue;
        const val = def[key];
        const want: Record<string, string> = {
          description: "string", required: "boolean", finite: "boolean", nonEmpty: "boolean", unique: "boolean",
          minLength: "number", maxLength: "number", minItems: "number", maxItems: "number", pattern: "string",
        };
        if (want[key] && typeof val !== want[key]) {
          issue(`${p}.${key}`, `"${key}" must be a ${want[key] === "boolean" ? "true/false value" : want[key] === "number" ? "number" : "text"}`);
          continue;
        }
        if ((key === "min" || key === "max") && typeof val !== "number" && typeof val !== "string") {
          issue(`${p}.${key}`, `"${key}" must be a number, date or duration`);
          continue;
        }
        if (key === "default" && !["string", "number", "boolean"].includes(typeof val)) {
          issue(`${p}.default`, "A default must be a single value, written as it would be typed in a cell");
          continue;
        }
        if (key === "reach" && val !== "descendants") {
          issue(`${p}.reach`, 'The only allowed value is "descendants"');
          continue;
        }
        (f as unknown as Obj)[key] = val;
      }
      out.push(f);
    }
    return out;
  };

  for (const [name, v, path] of section("enums")) {
    unknownKeys(v, ["id", "description", "members"], path);
    const members: EnumDef["members"] = [];
    if (!Array.isArray(v.members)) issue(`${path}.members`, "An enum needs a list of members");
    else
      for (const [i, m] of (v.members as unknown[]).entries()) {
        if (typeof m === "string") members.push({ name: m });
        else if (isObj(m) && typeof m.name === "string")
          members.push(m.description === undefined ? { name: m.name } : { name: m.name, description: String(m.description) });
        else issue(`${path}.members.${i}`, "A member is a name, or { name, description }");
      }
    const e: EnumDef = { id: idOf(v, PREFIX.enums, path, priorDef("enums", name)), name, members };
    const d = optString(v, "description", path);
    if (d !== undefined) e.description = d;
    schema.enums.push(e);
  }
  for (const [name, v, path] of section("traits")) {
    unknownKeys(v, ["id", "description", "traits", "fields"], path);
    const id = idOf(v, PREFIX.traits, path, priorDef("traits", name));
    const t: TraitDef = { id, name, traits: names(v.traits, `${path}.traits`), fields: fields(v.fields, `${path}.fields`, id) };
    const d = optString(v, "description", path);
    if (d !== undefined) t.description = d;
    schema.traits.push(t);
  }
  for (const [name, v, path] of section("structs")) {
    unknownKeys(v, ["id", "description", "fields"], path);
    const id = idOf(v, PREFIX.structs, path, priorDef("structs", name));
    const s: StructDef = { id, name, fields: fields(v.fields, `${path}.fields`, id) };
    const d = optString(v, "description", path);
    if (d !== undefined) s.description = d;
    schema.structs.push(s);
  }
  for (const [name, v, path] of section("unions")) {
    unknownKeys(v, ["id", "description", "discriminator", "variants"], path);
    const u: UnionDef = {
      id: idOf(v, PREFIX.unions, path, priorDef("unions", name)),
      name,
      discriminator: optString(v, "discriminator", path) ?? "kind",
      variants: names(v.variants, `${path}.variants`),
    };
    const d = optString(v, "description", path);
    if (d !== undefined) u.description = d;
    schema.unions.push(u);
  }
  for (const [name, v, path] of section("types")) {
    unknownKeys(v, ["id", "description", "traits", "fields", "singleton", "pack"], path);
    const id = idOf(v, PREFIX.types, path, priorDef("types", name));
    const t: TypeDef = { id, name, traits: names(v.traits, `${path}.traits`), fields: fields(v.fields, `${path}.fields`, id) };
    const d = optString(v, "description", path);
    if (d !== undefined) t.description = d;
    if (v.singleton !== undefined) {
      if (typeof v.singleton !== "boolean") issue(`${path}.singleton`, '"singleton" must be true or false');
      else if (v.singleton) t.singleton = true;
    }
    const pack = optString(v, "pack", path);
    if (pack !== undefined) t.pack = pack;
    schema.types.push(t);
  }
  const rules = doc.rules;
  if (rules !== undefined && rules !== null) {
    if (!Array.isArray(rules)) issue("rules", "Rules must be a list");
    else
      for (const [i, v] of (rules as unknown[]).entries()) {
        const path = `rules.${i}`;
        if (!isObj(v)) {
          issue(path, "Expected a map");
          continue;
        }
        unknownKeys(v, ["id", "type", "severity", "expr", "message"], path);
        const severity = v.severity ?? "error";
        if (severity !== "error" && severity !== "warning") issue(`${path}.severity`, 'Severity is "error" or "warning"');
        if (typeof v.expr !== "string" || !v.expr.startsWith("=")) issue(`${path}.expr`, 'A rule needs an expression starting with "="');
        if (typeof v.message !== "string") issue(`${path}.message`, "A rule needs a message");
        const r: RuleDef = {
          id: idOf(v, PREFIX.rules, path, old?.rules.find((r) => r.expr === v.expr && r.type === v.type)?.id),
          severity: severity === "warning" ? "warning" : "error",
          expr: String(v.expr ?? ""),
          message: String(v.message ?? ""),
        };
        const type = optString(v, "type", path);
        if (type !== undefined) r.type = type;
        schema.rules.push(r);
      }
  }
  for (const [name, v, path] of section("wizards")) {
    unknownKeys(v, ["id", "title", "description", "params", "sheet", "position", "spacing", "steps", "rows"], path);
    const w: WizardDef = { id: idOf(v, PREFIX.wizards, path, priorDef("wizards", name)), name, params: {}, sheet: { name }, rows: [] };
    for (const key of ["title", "description"] as const) {
      const x = optString(v, key, path);
      if (x !== undefined) w[key] = x;
    }
    if (v.params !== undefined) {
      if (!isObj(v.params)) issue(`${path}.params`, "Parameters are a map of names to definitions");
      else
        for (const [p, def] of Object.entries(v.params)) {
          const d = typeof def === "string" ? { type: def } : def;
          if (!isObj(d) || typeof d.type !== "string") {
            issue(`${path}.params.${p}`, "A parameter needs a type");
            continue;
          }
          unknownKeys(d, ["type", "required", "default", "description", "pattern", "minItems", "maxItems"], `${path}.params.${p}`);
          w.params[p] = d as unknown as WizardParam;
        }
    }
    if (v.sheet !== undefined) {
      const sh = typeof v.sheet === "string" ? { name: v.sheet } : v.sheet;
      if (!isObj(sh) || typeof sh.name !== "string") issue(`${path}.sheet`, "The sheet is a name, or { name, pack, create }");
      else {
        unknownKeys(sh, ["name", "pack", "create"], `${path}.sheet`);
        w.sheet = { name: sh.name };
        if (typeof sh.pack === "string") w.sheet.pack = sh.pack;
        if (sh.create === true) w.sheet.create = true;
      }
    }
    if (v.position !== undefined) {
      if (v.position !== "end" && v.position !== "afterLastGroup" && v.position !== "cursor") issue(`${path}.position`, 'The position is "end", "afterLastGroup" or "cursor"');
      else w.position = v.position;
    }
    if (v.spacing !== undefined) {
      if (typeof v.spacing !== "number" || !Number.isInteger(v.spacing) || v.spacing < 0) issue(`${path}.spacing`, "Spacing is a number of blank rows");
      else w.spacing = v.spacing;
    }
    if (v.steps !== undefined) {
      if (!Array.isArray(v.steps)) issue(`${path}.steps`, "Steps are a list");
      else w.steps = (v.steps as unknown[]).filter((x, i) => isObj(x) || (issue(`${path}.steps.${i}`, "Expected a map"), false)) as WizardStep[];
    }
    if (!Array.isArray(v.rows)) issue(`${path}.rows`, "A wizard needs rows: a list of the entities it makes");
    else w.rows = (v.rows as unknown[]).filter((x, i) => isObj(x) || (issue(`${path}.rows.${i}`, "Expected a map"), false)) as WizardRow[];
    schema.wizards.push(w);
  }
  return { schema, issues };
}

function collectIds(v: unknown, out: Set<Id>): void {
  if (Array.isArray(v)) v.forEach((x) => collectIds(x, out));
  else if (isObj(v)) {
    if (typeof v.id === "string") out.add(v.id);
    // A wizard's rows and steps hold entity ID templates (`mail_{key}`), not schema IDs.
    for (const [k, x] of Object.entries(v)) if (k !== "rows" && k !== "steps" && k !== "params") collectIds(x, out);
  }
}

// ------------------------------------------------------------ write

/**
 * The schema as YAML text. Deterministic: `parseSchema(formatSchema(s))` gives `s` back. An item with an empty ID is written without one: reading it back gives it a new one (§5.8). */
export function formatSchema(s: Schema): string {
  const out: string[] = [];
  const block = (key: string, items: { name: string }[], body: (item: never) => string[]) => {
    if (!items.length) return;
    if (out.length) out.push("");
    out.push(`${key}:`);
    for (const item of items) out.push(...body(item as never));
  };
  block("enums", s.enums, (e: EnumDef) => {
    const simple = e.members.every((m) => m.description === undefined);
    if (simple && e.description === undefined) return [`  ${e.name}: { ${e.id ? `id: ${q(e.id)}, ` : ""}members: [${e.members.map((m) => q(m.name)).join(", ")}] }`];
    const lines = [`  ${e.name}:`, ...(e.id ? [`    id: ${q(e.id)}`] : [])];
    if (e.description !== undefined) lines.push(`    description: ${q(e.description)}`);
    lines.push("    members:");
    for (const m of e.members) lines.push(m.description === undefined ? `      - ${q(m.name)}` : `      - { name: ${q(m.name)}, description: ${q(m.description)} }`);
    return lines;
  });
  const withFields = (kind: string, extra: (x: never) => string[]) => (x: { name: string; id: Id; description?: string; fields: FieldDef[] }) => {
    const lines = [`  ${x.name}:`, ...(x.id ? [`    id: ${q(x.id)}`] : [])];
    if (x.description !== undefined) lines.push(`    description: ${q(x.description)}`);
    lines.push(...extra(x as never));
    if (x.fields.length) {
      lines.push("    fields:");
      const width = Math.max(...x.fields.map((f) => f.name.length)) + 1;
      for (const f of x.fields) lines.push(`      ${(f.name + ":").padEnd(width)} ${formatField(f)}`);
    }
    void kind;
    // Nothing under it (new, so no ID yet, and no fields): still a map.
    return lines.length === 1 ? [`  ${x.name}: {}`] : lines;
  };
  block("traits", s.traits, withFields("trait", (t: TraitDef) => (t.traits.length ? [`    traits: [${t.traits.map(q).join(", ")}]`] : [])));
  block("structs", s.structs, withFields("struct", () => []));
  block("unions", s.unions, (u: UnionDef) => {
    const parts = u.id ? [`id: ${q(u.id)}`] : [];
    if (u.discriminator !== "kind") parts.push(`discriminator: ${q(u.discriminator)}`);
    parts.push(`variants: [${u.variants.map(q).join(", ")}]`);
    if (u.description !== undefined) parts.push(`description: ${q(u.description)}`);
    return [`  ${u.name}: { ${parts.join(", ")} }`];
  });
  block(
    "types",
    s.types,
    withFields("type", (t: TypeDef) => {
      const lines: string[] = [];
      if (t.singleton) lines.push("    singleton: true");
      if (t.pack !== undefined) lines.push(`    pack: ${q(t.pack)}`);
      if (t.traits.length) lines.push(`    traits: [${t.traits.map(q).join(", ")}]`);
      return lines;
    }),
  );
  // Wizards: as written, under their ID (their parts are data, printed as YAML prints them).
  if (s.wizards.length) {
    if (out.length) out.push("");
    out.push("wizards:");
    for (const w of s.wizards) {
      const { id, name, ...body } = w;
      const lines = stringifyYaml({ ...(id ? { id } : {}), ...body }, { lineWidth: 0 }).trimEnd().split("\n");
      out.push(`  ${name}:`, ...lines.map((l) => `    ${l}`));
    }
  }
  if (s.rules.length) {
    if (out.length) out.push("");
    out.push("rules:");
    for (const r of s.rules) {
      const lines = [...(r.id ? [`id: ${q(r.id)}`] : []), ...(r.type !== undefined ? [`type: ${q(r.type)}`] : []), `severity: ${r.severity}`, `expr: ${q(r.expr)}`, `message: ${q(r.message)}`];
      out.push(`  - ${lines[0]}`, ...lines.slice(1).map((l) => `    ${l}`));
    }
  }
  return out.join("\n") + "\n";
}

function formatField(f: FieldDef): string {
  const parts = [...(f.id ? [`id: ${q(f.id)}`] : []), `type: ${q(formatType(f.type))}`];
  for (const key of FIELD_KEYS) {
    if (key === "id" || key === "type" || key === "description") continue;
    const v = (f as unknown as Obj)[key];
    if (v === undefined) continue;
    parts.push(`${key}: ${key === "jsonSchema" ? JSON.stringify(v) : q(v as string | number | boolean)}`);
  }
  if (f.description !== undefined) parts.push(`description: ${q(f.description)}`);
  return `{ ${parts.join(", ")} }`;
}

// Words YAML (1.1 or 1.2) would read as something other than a string.
const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;

/** A YAML scalar: plain where that reads back the same, double-quoted (JSON) otherwise. */
function q(v: string | number | boolean): string {
  if (typeof v !== "string") return String(v);
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v) && !RESERVED.test(v)) return v;
  return JSON.stringify(v);
}
