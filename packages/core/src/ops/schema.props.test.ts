// Property tests for schema ops, through the project API: random schema edits (with
// some cell edits among them) on two tasks from the same base, then
//
//  - undo, replay and mirror, as in ops.props.test.ts;
//  - rebase agrees with a three-way merge of the schemas, property by property, however
//    conflicts are resolved;
//  - conflict detection is symmetric, and without conflicts both landing orders give
//    the same schema (up to the order of things added side by side).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { stableJson } from "../formula/content.ts";
import { exportJson } from "../export/json.ts";
import { loadProject } from "../project/load.ts";
import { Project, type Edit } from "../project/project.ts";
import { validate } from "../project/validate.ts";
import { canonDoc, cloneDoc, type Doc } from "./doc.ts";
import { applyOp, OpError, type Op } from "./ops.ts";
import { conflictId, rebase, type Conflict, type Side } from "./rebase.ts";
import { isSection, LIST_KEYS, propsOf, schemaNodes } from "./schema.ts";

const RUNS = Number(process.env.RUNS ?? 300);
type Gen = fc.GeneratorValue;
const int = (g: Gen, max: number): number => g(fc.integer, { min: 0, max });
const pick = <T,>(g: Gen, xs: readonly T[]): T => xs[int(g, xs.length - 1)]!;
const prop = (name: string, body: (g: Gen) => void) => it(name, () => fc.assert(fc.property(fc.gen(), body), { numRuns: RUNS }), 600_000);

const SCHEMA = `
enums:
  Element: { members: [kinetic, fire, ice] }
structs:
  Cost: { fields: { currency: string, amount: int } }
  Box: { fields: { w: float } }
  Circle: { fields: { r: float } }
unions:
  Shape: { variants: [Box, Circle] }
traits:
  Visual: { fields: { sprite: string } }
types:
  Weapon:
    traits: [Visual]
    fields:
      damage: float
      element: { type: "enum<Element>", default: fire }
      main: "ref<Projectile>"
      cost: "struct<Cost>"
      shape: "union<Shape>"
  Projectile: { fields: { speed: float } }
  GameConfig: { singleton: true, fields: { lives: int, revive: "struct<Cost>" } }
`;

const ROWS = [
  ["Weapon", "blaster", "b.png", "3", "fire", "bolt", '{"currency": "gold", "amount": 5}', '{"kind": "Box", "w": 2}'],
  ["#Weapon", "old", "", "1", "ice"],
  ["Projectile", "bolt", "5"],
  ["GameConfig"],
  [".revive.amount", "4"],
  ["Projectile", "dart", "=C3*2"],
];

const start = (() => {
  const p = loadProject(SCHEMA, { sheets: [{ name: "S", rows: ROWS }, { name: "N", kind: "scratch", rows: [['=ENTITY("bolt").speed']] }] }).project;
  return cloneDoc(p.doc);
})();

const NAMES = ["x", "y", "speed", "w"];
const TYPENAMES = ["Alpha", "Beta", "Projectile"];
// Members are matched by name when lists merge, so a task that removes `fire` and then
// renames `ice` to `fire` can't be told apart from one that kept `fire`. New names here
// never reuse the base's.
const MEMBERS = ["acid", "void"];
const RENAMED = ["blaze", "frost"];
const TYPES = ["float", "int", "string", "enum<Element>", "ref<Projectile>", "list<ref<Projectile>>"];

/** One random edit through the project API, or null when it doesn't apply here. */
function genEdit(g: Gen, p: Project): Edit | null {
  const s = p.doc.schema;
  const owners = [...s.types, ...s.traits, ...s.structs];
  // Half the time, Projectile: so both sides often touch the same fields and conflict.
  const owner = (int(g, 1) && owners.find((o) => o.id === "t2")) || pick(g, owners);
  const field = owner.fields.length ? pick(g, owner.fields) : null;
  const named = [...s.types, ...s.structs, ...s.enums, ...s.traits, ...s.unions];
  const sheet = p.sheetId("S");
  try {
    switch (pick(g, ["addField", "removeField", "setField", "setField", "renameField", "renameType", "members", "renameMember", "removeDef", "addDef", "cell", "cell"] as const)) {
      case "addField":
        return p.addField(owner.name, { name: pick(g, NAMES), type: pick(g, TYPES) }, field && int(g, 1) ? field.name : undefined);
      case "removeField":
        return field && p.removeField(owner.name, field.name);
      case "setField":
        return field && p.setField(owner.name, field.name, pick(g, [{ min: int(g, 3) }, { min: null }, { type: pick(g, TYPES) }, { description: pick(g, ["a", "b"]) }]));
      case "renameField":
        return field && p.renameField(owner.name, field.name, pick(g, NAMES));
      case "renameType":
        return p.renameType(pick(g, named).name, pick(g, TYPENAMES));
      case "members": {
        const e = s.enums[0];
        if (!e) return null;
        // Lists merge by name, so a member listed twice (a schema error anyway) isn't generated.
        const fresh = MEMBERS.filter((x) => !e.members.some((m) => m.name === x));
        const add = int(g, 1) === 1 && fresh.length > 0;
        const members = add ? [...e.members, { name: pick(g, fresh) }] : e.members.filter((_, i) => i !== int(g, e.members.length));
        return p.setDef(e.name, { members });
      }
      case "renameMember": {
        const e = s.enums[0];
        return e && e.members.length ? p.renameEnumMember(e.name, pick(g, e.members).name, pick(g, RENAMED)) : null;
      }
      case "removeDef":
        return p.removeDef(pick(g, named).name);
      case "addDef":
        return p.addDef("types", { name: pick(g, TYPENAMES), traits: [], fields: [{ name: "hp", type: "int" }] });
      case "cell":
        return p.set(sheet, `${pick(g, ["A", "B", "C", "D", "E"])}${1 + int(g, 7)}`, pick(g, ["", "Weapon", "Projectile", "fire", "ice", "acid", "bolt", "7"]));
    }
  } catch (e) {
    // Edits refused as they stand: an op that doesn't apply, or a name the API can't find.
    if (e instanceof OpError || /^(No |.* has no field|.* already has a field|.* can't have fields|Use rename)/.test((e as Error).message)) return null;
    throw e;
  }
}

function task(doc: Doc, salt: string): Project {
  const p = Project.fromDoc(cloneDoc(doc));
  p.wb.idSalt = salt;
  return p;
}

function genOps(g: Gen, doc: Doc, salt: string, max = 5): { p: Project; edits: Edit[]; ops: Op[] } {
  const p = task(doc, salt);
  const edits: Edit[] = [];
  for (let i = int(g, max); i > 0; i--) {
    const e = genEdit(g, p);
    if (e) edits.push(e);
    if (int(g, 2) === 0) validate(p); // what validation keeps must survive schema edits
  }
  return { p, edits, ops: edits.flatMap((e) => e.ops) };
}

const observe = (p: Project) => ({
  issues: validate(p).issues.map((i) => `${i.code} ${i.message} ${JSON.stringify(i.at ?? null)}`).sort(),
  export: exportJson(p, { allowInvalid: true }),
});

/** A schema as comparable data: nodes by ID, each with its parent and properties. List properties as sets. */
function nodesOf(doc: Doc, sortLists = true): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, n] of schemaNodes(doc.schema)) {
    const props = propsOf(n.def);
    for (const k of Object.keys(props))
      if (sortLists && LIST_KEYS.has(k) && Array.isArray(props[k])) props[k] = (props[k] as unknown[]).map((x) => stableJson(x)).sort();
    out.set(id, stableJson({ parent: n.parent, ...props }));
  }
  return out;
}

/** Each node's properties as comparable text. */
function byId(doc: Doc): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const [id, n] of schemaNodes(doc.schema)) {
    const props: Record<string, string> = { parent: n.parent };
    for (const [k, v] of Object.entries(propsOf(n.def))) props[k] = stableJson(v);
    out.set(id, props);
  }
  return out;
}

/**
 * Definition names that don't name the same definition in every one of these documents.
 * A rename re-run on the head rightly rewrites references the other side added, so a
 * value mentioning one of these names can't be checked property by property.
 */
function unstableNames(...docs: Doc[]): Set<string> {
  const maps = docs.map((d) => {
    const m = new Map<string, string>();
    for (const [id, n] of schemaNodes(d.schema)) if (isSection(n.parent) && n.parent !== "rules") m.set(n.def.name as string, m.has(n.def.name as string) ? "*" : id);
    return m;
  });
  const out = new Set<string>();
  for (const m of maps) for (const name of m.keys()) if (maps.some((o) => o.get(name) !== m.get(name))) out.add(name);
  return out;
}

const merged = { checked: 0, skipped: 0 };

/** Whether text (however many times JSON-encoded) mentions one of the names as a word. */
const mentionsWord = (text: string, names: ReadonlySet<string>): boolean => [...names].some((n) => new RegExp(`\\b${n}\\b`).test(text));

/** Every name a rename in these ops changes from or to: definitions, fields and enum members. */
function renamedNames(base: Doc, ops: readonly Op[]): Set<string> {
  const out = new Set<string>();
  const nodes = schemaNodes(base.schema);
  for (const op of ops) {
    if (op.kind === "renameEnumMember") (out.add(op.from), out.add(op.to));
    if (op.kind === "renameType" || op.kind === "renameField") {
      out.add(op.name);
      const was = nodes.get(op.id)?.def.name;
      if (typeof was === "string") out.add(was);
    }
  }
  return out;
}

/** Decide each conflict the same way whichever side lands first: by a hash of its name. */
const coin = (salt: number) => (c: Conflict, mineIs: "a" | "b"): Side => {
  const id = conflictId(c, mineIs === "b");
  let h = salt;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const aWins = (h & 1) === 0;
  return aWins === (mineIs === "a") ? "mine" : "theirs";
};

describe("schema ops (properties)", () => {
  prop("undo, replay and mirror", (g) => {
    const { p, edits, ops } = genOps(g, start, "", 8);
    const doc = cloneDoc(start);
    for (const op of ops) applyOp(doc, op);
    expect(canonDoc(doc)).toEqual(canonDoc(p.doc));
    expect(observe(Project.fromDoc(cloneDoc(p.doc)))).toEqual(observe(p));
    for (const e of [...edits].reverse()) p.apply(e.inverse);
    expect(canonDoc(p.doc)).toEqual(canonDoc(start));
    expect(observe(p)).toEqual(observe(Project.fromDoc(cloneDoc(start))));
  });

  prop("rebase agrees with a three-way merge of the schema's properties", (g) => {
    const t = genOps(g, start, "t"), m = genOps(g, start, "m");
    const resolved = new Map<string, Side>();
    const r = rebase(start, t.ops, m.ops, (c) => {
      const side: Side = int(g, 1) ? "mine" : "theirs";
      resolved.set(conflictId(c), side);
      return side;
    });
    const head = cloneDoc(start);
    for (const op of [...t.ops, ...r.ops]) applyOp(head, op);
    expect(canonDoc(head)).toEqual(canonDoc(r.state));
    // A definition removed on one side while the other renamed or changed it leaves names
    // the oracle can't follow; those runs only check that the ops apply.
    if (r.conflicts.some((c) => c.kind === "op" || c.kind === "schemaDeleted")) return void merged.skipped++;
    merged.checked++;
    const B = byId(start), T = byId(t.p.doc), M = byId(m.p.doc), R = byId(r.state);
    const unstable = unstableNames(start, t.p.doc, m.p.doc, r.state);
    const mentionsUnstable = (v: string | undefined) => v !== undefined && [...unstable].some((n) => v.includes(JSON.stringify(n)));
    // A rename re-run on the head may meet theirs' changes (an enum field theirs made a float
    // keeps its old default): values mentioning a renamed name aren't checked (see below).
    const renamed = renamedNames(start, [...t.ops, ...m.ops]);
    const touched = (v: string | undefined) => v !== undefined && mentionsWord(v, renamed);
    for (const [id, got] of R) {
      const b = B.get(id), tt = T.get(id), mm = M.get(id);
      if (!b || !tt || !mm) continue; // added by one side
      for (const k of new Set([...Object.keys(b), ...Object.keys(tt), ...Object.keys(mm)])) {
        if (LIST_KEYS.has(k)) continue;
        const [bv, tv, mv] = [b[k], tt[k], mm[k]];
        if (k !== "name" && [bv, tv, mv, got[k]].some((v) => mentionsUnstable(v) || touched(v))) continue;
        let want: string;
        if (tv === mv || mv === bv) want = tv!;
        else if (tv === bv) want = mv!;
        else want = resolved.get(`schema ${id}#${k}`) === "mine" ? mv! : tv!;
        if (got[k] !== want) throw new Error(JSON.stringify({ at: `${id}#${k}`, got: got[k], want, b: bv, t: tv, m: mv, theirs: t.ops.filter((o) => o.kind !== "setLayout" && o.kind !== "setCell" && o.kind !== "insert"), mine: m.ops.filter((o) => o.kind !== "setLayout" && o.kind !== "setCell" && o.kind !== "insert"), conflicts: r.conflicts }).slice(0, 4000));
      }
    }
    for (const id of B.keys()) if (!T.has(id) && !M.has(id)) expect(R.has(id), `${id} removed by both`).toBe(false);
  });

  it("the merge oracle checked most runs", () => {
    expect(merged.checked).toBeGreaterThan(merged.skipped);
  });

  prop("conflict detection is symmetric: landing order doesn't change what conflicts", (g) => {
    const a = genOps(g, start, "a").ops, b = genOps(g, start, "b").ops;
    const ids = (r: { conflicts: Conflict[] }, swap: boolean) => r.conflicts.filter((c) => c.kind !== "op").map((c) => conflictId(c, swap)).sort();
    expect(ids(rebase(start, b, a), true)).toEqual(ids(rebase(start, a, b), false));
  });

  prop("both landing orders give the same schema, however conflicts are resolved", (g) => {
    const a = genOps(g, start, "a").ops, b = genOps(g, start, "b").ops;
    const pickSide = coin(int(g, 1000));
    const x = rebase(start, a, b, (c) => pickSide(c, "b"));
    const y = rebase(start, b, a, (c) => pickSide(c, "a"));
    if ([...x.conflicts, ...y.conflicts].some((c) => c.kind === "op" || c.kind === "schemaDeleted")) return;
    // A rename re-run on the head meets the other side's changes in one order and not the
    // other (one side turned an enum field into a float: is its default still a member?).
    // As in rebase.props.test.ts, values mentioning a renamed name are left out; the rest
    // must agree.
    const names = renamedNames(start, [...a, ...b]);
    const touched = (v: string | undefined) => v !== undefined && mentionsWord(v, names);
    const nx = nodesOf(x.state), ny = nodesOf(y.state);
    expect([...nx.keys()].sort()).toEqual([...ny.keys()].sort());
    for (const [id, vx] of nx) {
      const px = JSON.parse(vx) as Record<string, unknown>, py = JSON.parse(ny.get(id)!) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(px), ...Object.keys(py)])) {
        const [sx, sy] = [px[k], py[k]].map((v) => (v === undefined ? undefined : stableJson(v)));
        if (sx !== sy && !touched(sx) && !touched(sy)) throw new Error(JSON.stringify({ id, k, x: sx, y: sy, a, b }, null, 1).slice(0, 5000));
      }
    }
  });
});

describe("the schema generator", () => {
  it("reaches every kind of schema conflict, and edits that apply", () => {
    const kinds = new Map<string, number>();
    let applied = 0;
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const t = genOps(g, start, "t"), m = genOps(g, start, "m");
        applied += t.ops.length;
        for (const c of rebase(start, t.ops, m.ops).conflicts) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
      }),
      { numRuns: 1500 },
    );
    // Two renames of one member to different names need both sides to pick the same one: rarer.
    for (const [k, n] of [["schema", 5], ["schemaDeleted", 5], ["cell", 5], ["enumRename", 1]] as const) expect(kinds.get(k) ?? 0, k).toBeGreaterThan(n);
    expect(applied).toBeGreaterThan(1500);
  }, 60_000);
});
