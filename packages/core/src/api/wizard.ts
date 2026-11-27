// Wizards (DESIGN §9.3): a run's plan, from a wizard and its parameters. The parameters are
// checked (required, pattern, list lengths); each row is repeated for `forEach` and kept or
// skipped by `when:`; then `{…}` is filled in its ID and fields. Sapwood.runWizard makes the
// plan: the packs and sheets, then the rows, as one change.
//
// Templates: `{param}`, `{param.field}`, the row's item `{r}`, `{r.field}` and `{r.index}`, and
// a named row's IDs `{rewardRows.ids}`. A value that's a placeholder alone keeps what it names as
// it is (a number, a list, a struct); otherwise it's written into the text. A field value that
// starts with `=` is a formula.

import type { JsonValue } from "./sapwood.ts";
import { readPattern, type WizardDef, type WizardRow, type WizardStep } from "../schema/model.ts";

export interface PlannedRow {
  type: string;
  id: string;
  /** Field values as the API takes them: a formula as `{ $formula }`. Blank ones left out. */
  fields: Record<string, JsonValue>;
  /** The sheet it goes on, by name, in a pack by name. */
  sheet: { name: string; pack: string };
}

export interface WizardPlan {
  /** The sheet its rows go on unless they say, by name, in a pack by name; made if `create` and it isn't there (rows' own sheets too). */
  sheet: { name: string; pack: string; create: boolean };
  /** Packs and sheets the steps make first (skipped if there already). */
  packs: { name: string; parent: string; editors: boolean }[];
  sheets: { name: string; pack: string }[];
  rows: PlannedRow[];
}

type Scope = Record<string, unknown>;

const PLACEHOLDER = /\{([A-Za-z_]\w*)((?:\.\w+)*)\}/g;

/** What `{root.a.b}` names in a scope; undefined if nothing. */
function lookup(scope: Scope, root: string, rest: string): unknown {
  let v: unknown = scope[root];
  for (const k of rest.split(".").filter(Boolean)) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

/** A template filled: a placeholder alone keeps its value; text gets them written in. */
function fill(t: unknown, scope: Scope): unknown {
  if (typeof t === "string") {
    const whole = /^\{([A-Za-z_]\w*)((?:\.\w+)*)\}$/.exec(t);
    if (whole) return lookup(scope, whole[1]!, whole[2]!);
    return t.replace(PLACEHOLDER, (_, root: string, rest: string) => {
      const v = lookup(scope, root, rest);
      return v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(t)) return t.map((x) => fill(x, scope));
  if (t !== null && typeof t === "object") return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, fill(v, scope)]));
  return t;
}

const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === "" || v === 0 || (Array.isArray(v) && v.length === 0));

/** `param`, `!param`, or `param == value` (`!=` too). */
function holds(when: string, scope: Scope): boolean {
  const cmp = /^\s*([A-Za-z_]\w*)\s*(==|!=)\s*(.*?)\s*$/.exec(when);
  if (cmp) {
    const v = scope[cmp[1]!];
    const same = String(v ?? "") === cmp[3]!.replace(/^["']|["']$/g, "");
    return cmp[2] === "==" ? same : !same;
  }
  const not = /^\s*!\s*/.test(when);
  return not !== truthy(scope[when.replace(/^\s*!?\s*/, "").trim()]);
}

/**
 * The plan for a run, or the problems that stop it (each said plainly). `params` are by name;
 * a missing one takes its default.
 */
export function planWizard(w: WizardDef, given: Record<string, unknown>): { plan: WizardPlan | null; problems: string[] } {
  const problems: string[] = [];
  const scope: Scope = {};
  for (const [name, d] of Object.entries(w.params)) {
    let v = given[name] ?? d.default ?? (d.type === "pack" ? "root" : undefined);
    if (typeof v === "string" && /^(int|float)$/.test(d.type) && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v);
    const blank = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (blank && d.required) problems.push(`${name} is required`);
    if (typeof v === "string" && d.pattern) {
      const p = readPattern(d.pattern);
      if (!p.re.test(v)) problems.push(`${name} must ${p.says}`);
    }
    if (d.minItems !== undefined && (!Array.isArray(v) || v.length < d.minItems)) problems.push(`${name} needs at least ${d.minItems} ${d.minItems === 1 ? "item" : "items"}`);
    if (d.maxItems !== undefined && Array.isArray(v) && v.length > d.maxItems) problems.push(`${name} takes at most ${d.maxItems} items`);
    if (/^list</.test(d.type) && v !== undefined && !Array.isArray(v)) problems.push(`${name} is a list`);
    scope[name] = v;
  }
  for (const k of Object.keys(given)) if (!(k in w.params)) problems.push(`${w.name} has no parameter ${k}`);
  if (problems.length) return { plan: null, problems };

  // Rows as they'll be: repeated and kept or skipped, each with its scope; then the named rows' IDs.
  const expanded: { row: WizardRow; scope: Scope }[] = [];
  for (const row of w.rows) {
    if (row.when !== undefined && !holds(String(row.when), scope)) continue;
    if (row.forEach === undefined) expanded.push({ row, scope });
    else {
      const items = scope[row.forEach];
      (Array.isArray(items) ? items : []).forEach((item, index) => {
        const it = item !== null && typeof item === "object" && !Array.isArray(item) ? { ...item, index } : { value: item, index };
        expanded.push({ row, scope: { ...scope, [row.as ?? "item"]: it } });
      });
    }
  }
  const ids = expanded.map((x) => String(fill(x.row.id, x.scope) ?? "").trim());
  const named: Record<string, { ids: string[] }> = {};
  expanded.forEach((x, i) => {
    if (x.row.name) (named[x.row.name] ??= { ids: [] }).ids.push(ids[i]!);
  });
  for (const r of w.rows) if (r.name && !named[r.name]) named[r.name] = { ids: [] };

  const text = (t: unknown, s: Scope = scope) => String(fill(t, s) ?? "").trim();
  const sheet = { name: text(w.sheet.name), pack: text(w.sheet.pack ?? "root") || "root", create: w.sheet.create === true };
  const rows: PlannedRow[] = expanded.map((x, i) => {
    const full = { ...x.scope, ...named };
    const fields: Record<string, JsonValue> = {};
    for (const [k, t] of Object.entries(x.row.fields ?? {})) {
      const v = fill(t, full);
      if (v === undefined || v === null || v === "") continue;
      fields[k] = typeof v === "string" && v.startsWith("=") ? { $formula: v } : (v as JsonValue);
    }
    const pack = x.row.pack !== undefined ? text(x.row.pack, x.scope) || "root" : sheet.pack;
    const own = x.row.sheet !== undefined ? text(x.row.sheet, x.scope) : "";
    return { type: x.row.type, id: ids[i]!, fields, sheet: { name: own || sheet.name, pack } };
  });
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.id === "") problems.push(`A ${r.type} row's ID came out blank`);
    else if (seen.has(r.id.toLowerCase())) problems.push(`Two rows would both be ${r.id}`);
    seen.add(r.id.toLowerCase());
  }

  const packs: WizardPlan["packs"] = [];
  const sheets: WizardPlan["sheets"] = [];
  for (const st of w.steps ?? ([] as WizardStep[])) {
    if (st.when !== undefined && !holds(String(st.when), scope)) continue;
    if ("createPack" in st) packs.push({ name: text(st.createPack), parent: text(st.parent ?? "root") || "root", editors: st.editors === true });
    else if ("createSheet" in st) sheets.push({ name: text(st.createSheet), pack: text(st.pack ?? "root") || "root" });
  }
  if (problems.length) return { plan: null, problems };
  return { plan: { sheet, packs, sheets, rows }, problems };
}

/** Whether running it makes a pack that only a Developer may make (DESIGN §11.2). */
export function needsDeveloper(w: WizardDef): boolean {
  return (w.steps ?? []).some((s) => "createPack" in s && s.editors !== true);
}
