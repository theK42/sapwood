// Schema ops (DESIGN §5.9) and the schema renames (§8.2), through the project API, and
// their rebase.

import { describe, expect, it } from "vitest";
import { exportJson } from "../export/json.ts";
import { loadProject } from "../project/load.ts";
import { Project, type Edit } from "../project/project.ts";
import { validate } from "../project/validate.ts";
import { canonDoc, cloneDoc, docsEqual, type Doc } from "./doc.ts";
import { applyOp, OpError, type Op } from "./ops.ts";
import { conflictId, rebase, type Resolve } from "./rebase.ts";
import { mergeList } from "./schema.ts";

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
      elements: "list<enum<Element>>"
      main: "ref<Projectile>"
      cost: "struct<Cost>"
      shape: "union<Shape>"
  Projectile: { fields: { speed: float } }
  GameConfig: { singleton: true, fields: { lives: int, revive: "struct<Cost>", start: "ref<Weapon>" } }
rules:
  - { id: fast, type: Projectile, severity: warning, expr: "=speed > 0", message: "Too slow" }
`;

// Weapon columns from C: sprite, damage, element, elements, main, cost, shape.
const ROWS = [
  ["Weapon", "blaster", "b.png", 3, "fire", '["fire", "ice"]', "bolt", '{"currency": "gold", "amount": 5}', '{"kind": "Box", "w": 2}'],
  ["#Weapon", "old", "", 1, "fire"],
  ["Projectile", "bolt", 5],
  ["GameConfig.lives", 3],
  ["GameConfig"],
  [".revive.amount", 4],
  [".start", "blaster"],
];

function base(): Project {
  return loadProject(SCHEMA, {
    sheets: [
      { name: "S", rows: ROWS },
      { name: "Notes", kind: "scratch", rows: [['=ENTITY("blaster").damage', '="Projectile"', '="fire"']] },
    ],
  }).project;
}

const issues = (p: Project) => validate(p).issues.map((i) => `${i.code}: ${i.message}`);
const cell = (p: Project, a1: string, sheet = "S") => p.engine.get(p.sheetId(sheet), a1);
const rootJson = (p: Project) => JSON.parse(exportJson(p, { allowInvalid: true }).find((f) => f.path === "root.json")!.content);

/** Undo gives back exactly the starting document, and the engine agrees with a rebuilt one. */
function undoes(p: Project, start: Doc, ...edits: Edit[]) {
  const rebuilt = Project.fromDoc(cloneDoc(p.doc));
  expect(issues(rebuilt)).toEqual(issues(p));
  expect(exportJson(rebuilt, { allowInvalid: true })).toEqual(exportJson(p, { allowInvalid: true }));
  for (const e of [...edits].reverse()) p.apply(e.inverse);
  expect(docsEqual(p.doc, start)).toBe(true);
  expect(issues(p)).toEqual(issues(base()));
}

describe("schema ops on a project (§5.9)", () => {
  it("the fixture is clean", () => {
    expect(issues(base())).toEqual([]);
  });

  it("adding a required field: blank cells are errors until filled; the default layout gains it", () => {
    const p = base();
    const start = cloneDoc(p.doc);
    const e1 = p.addField("Projectile", { name: "radius", type: "float", required: true });
    expect(issues(p)).toEqual([expect.stringMatching(/required/i)]);
    const e2 = p.set(p.sheetId("S"), "D3", "0.5");
    expect(issues(p)).toEqual([]);
    expect(rootJson(p).types.Projectile.bolt).toEqual({ speed: 5, radius: 0.5 });
    undoes(p, start, e1, e2);
  });

  it("changing a field's type re-reads its cells; failures are validation errors", () => {
    const p = base();
    const start = cloneDoc(p.doc);
    const e1 = p.set(p.sheetId("S"), "C3", "5.5");
    const e2 = p.setField("Projectile", "speed", { type: "int", min: 0 });
    expect(issues(p)).toEqual([expect.stringMatching(/whole number|integer/i)]);
    const e3 = p.setField("Projectile", "speed", { type: "float", min: null });
    expect(issues(p)).toEqual([]);
    undoes(p, start, e1, e2, e3);
  });

  it("removing a field keeps its cells, as scratch, and says which held data", () => {
    const p = base();
    const start = cloneDoc(p.doc);
    const e = p.removeField("Visual", "sprite");
    expect(e.affected).toEqual([expect.objectContaining({ row: p.wb.sheet(p.sheetId("S")).rows.idAt(1) })]);
    expect(cell(p, "C1")).toBe("b.png"); // still there
    expect(rootJson(p).types.Weapon.blaster).toMatchObject({ damage: 3, element: "fire" });
    expect(rootJson(p).types.Weapon.blaster.sprite).toBeUndefined();
    // The layout was pinned as it was, so damage still reads from D, and C is scratch.
    expect(issues(p)).toEqual([]);
    expect(e.ops[0]).toMatchObject({ kind: "setLayout", type: "Weapon" });
    undoes(p, start, e);
  });

  it("adding a field mid-type, or to a trait, pins layouts so existing columns keep their fields", () => {
    const p = base();
    const start = cloneDoc(p.doc);
    const e1 = p.addField("Weapon", { name: "range", type: "float" }, "damage");
    const e2 = p.addField("Visual", { name: "tint", type: "string" });
    expect(issues(p)).toEqual([]);
    const s = p.sheetId("S");
    expect(p.layout(s, "Weapon").map((c) => p.wb.sheet(s).cols.liveIds().indexOf(c.col) + 1)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const e3 = p.setRows(s, [["Weapon", "blaster", "b.png", "3", "fire", '["fire", "ice"]', "bolt", '{"currency": "gold", "amount": 5}', '{"kind": "Box", "w": 2}', "40", "red"]]);
    expect(rootJson(p).types.Weapon.blaster).toMatchObject({ damage: 3, range: 40, tint: "red" });
    // Appending a field at the end of a type changes nothing about its columns: no pin.
    const e4 = p.addField("Projectile", { name: "mass", type: "float" });
    expect(e4.ops.map((o) => o.kind)).toEqual(["addSchema"]);
    undoes(p, start, e1, e2, e3, e4);
  });

  it("removing a type makes its rows invalid until deleted or commented out", () => {
    const p = base();
    const start = cloneDoc(p.doc);
    const e = p.removeDef("Projectile");
    expect(e.affected).toHaveLength(1);
    expect(issues(p)).toContainEqual(expect.stringMatching(/^row.unknown-type/));
    undoes(p, start, e);
  });

  it("adding and removing definitions", () => {
    const p = base();
    const start = cloneDoc(p.doc);
    const e1 = p.addDef("types", { name: "Shield", traits: [], fields: [{ name: "hp", type: "int", min: 1 }] });
    const e2 = p.setRows(p.sheetId("S"), [["Shield", "buckler", "0"]], 8);
    expect(issues(p)).toEqual([expect.stringMatching(/at least 1|min/i)]);
    const e3 = p.addDef("enums", { name: "Rarity", members: [{ name: "common" }] }, "Element");
    expect(p.doc.schema.enums.map((x) => x.name)).toEqual(["Element", "Rarity"]);
    undoes(p, start, e1, e2, e3);
  });
});

describe("plain schema ops", () => {
  const doc = () => cloneDoc(base().doc);
  const fails = (op: Op, msg: RegExp) => {
    const d = doc();
    expect(() => applyOp(d, op)).toThrow(OpError);
    expect(() => applyOp(d, op)).toThrow(msg);
    expect(docsEqual(d, doc())).toBe(true);
  };

  it("refuse what doesn't apply", () => {
    fails({ kind: "addSchema", parent: "types", def: { id: "f1", name: "X" }, after: null }, /already exists/);
    fails({ kind: "addSchema", parent: "enums", def: { id: "z", name: "X", fields: [] }, after: null }, /no fields/);
    fails({ kind: "addSchema", parent: "nope", def: { id: "z", name: "x", type: { kind: "int" } }, after: null }, /can't have fields/);
    fails({ kind: "addSchema", parent: "types", def: { id: "z", name: "X" }, after: "nope" }, /no nope/);
    fails({ kind: "removeSchema", id: "nope" }, /no nope/);
    fails({ kind: "setSchema", id: "t1", key: "fields", value: [] }, /isn't a property/);
  });

  it("a property set to what it was changes nothing", () => {
    const d = doc();
    const id = d.schema.types[0]!.id;
    expect(applyOp(d, { kind: "setSchema", id, key: "name", value: "Weapon" })).toEqual([]);
  });

  it("clearing a property and undoing it", () => {
    const d = doc();
    const start = cloneDoc(d);
    const f = d.schema.types[1]!.fields[0]!;
    const inv = applyOp(d, { kind: "setSchema", id: f.id, key: "description", value: "how fast" });
    expect(inv).toEqual([{ kind: "setSchema", id: f.id, key: "description" }]);
    for (const op of inv) applyOp(d, op);
    expect(canonDoc(d)).toEqual(canonDoc(start));
  });
});

describe("schema renames (§8.2)", () => {
  it("renameType rewrites column A, the schema's references, layouts and rules, and reports formulas", () => {
    const p = base();
    const start = cloneDoc(p.doc);
    const s = p.sheetId("S");
    const e0 = p.setLayout(s, "Projectile", ["", "speed"]);
    const e0b = p.set(s, "D3", "5");
    const e1 = p.renameType("Projectile", "Shot");
    expect(cell(p, "A3")).toBe("Shot");
    expect(p.doc.sheets.get(s)!.layouts.has("Shot")).toBe(true);
    expect(p.doc.sheets.get(s)!.layouts.has("Projectile")).toBe(false);
    expect(p.doc.schema.rules[0]!.type).toBe("Shot");
    expect(e1.formulas).toEqual([expect.objectContaining({ sheet: p.sheetId("Notes", "root") })]);
    const e2 = p.renameType("Weapon", "Gun");
    expect([cell(p, "A1"), cell(p, "A2")]).toEqual(["Gun", "#Gun"]);
    const e3 = p.renameType("GameConfig", "Config");
    expect([cell(p, "A4"), cell(p, "A5")]).toEqual(["Config.lives", "Config"]);
    expect(issues(p)).toEqual([]);
    const json = rootJson(p);
    expect(json.types.Gun.blaster.main).toEqual({ type: "Shot", id: "bolt" });
    expect(json.types.Shot.bolt).toEqual({ speed: 5 });
    expect(json.singletons.Config).toMatchObject({ lives: 3, revive: { amount: 4 } });
    // A formula reading a field still works: it reads by row, not by type name.
    expect(cell(p, "A1", "Notes")).toBe(3);
    undoes(p, start, e0, e0b, e1, e2, e3);
  });

  it("renameType on a union variant rewrites its tag in JSON cells", () => {
    const p = base();
    const start = cloneDoc(p.doc);
    const e = p.renameType("Box", "Rect");
    expect(cell(p, "I1")).toBe('{"kind": "Rect", "w": 2}');
    expect(p.doc.schema.unions[0]!.variants).toEqual(["Rect", "Circle"]);
    expect(issues(p)).toEqual([]);
    undoes(p, start, e);
  });

  it("renameType refuses a name in use or an invalid one", () => {
    const p = base();
    expect(() => p.renameType("Weapon", "Projectile")).toThrow(/already used/);
    expect(() => p.renameType("Weapon", "2guns")).toThrow(/valid name/);
  });

  it("renameField on a struct rewrites JSON keys and singleton paths; on a type it only reports formulas", () => {
    const p = base();
    const start = cloneDoc(p.doc);
    const e1 = p.renameField("Cost", "amount", "qty");
    expect(cell(p, "H1")).toBe('{"currency": "gold", "qty": 5}');
    expect(cell(p, "A6")).toBe(".revive.qty");
    expect(issues(p)).toEqual([]);
    const e2 = p.renameField("Weapon", "damage", "power");
    expect(e2.ops.filter((o) => o.kind === "setCell")).toEqual([]);
    expect(e2.formulas).toHaveLength(1); // ENTITY("blaster").damage
    expect(rootJson(p).types.Weapon.blaster.power).toBe(3);
    const e3 = p.renameField("GameConfig", "lives", "hearts");
    expect(cell(p, "A4")).toBe("GameConfig.hearts");
    const e4 = p.renameField("Projectile", "speed", "velocity");
    expect(e4.rules).toEqual(["fast"]);
    undoes(p, start, e1, e2, e3, e4);
  });

  it("renameEnumMember rewrites enum cells (lists and commented rows too) and defaults", () => {
    const p = base();
    const start = cloneDoc(p.doc);
    const e = p.renameEnumMember("Element", "fire", "flame");
    expect([cell(p, "E1"), cell(p, "F1"), cell(p, "E2")]).toEqual(["flame", '["flame", "ice"]', "flame"]);
    const weapon = p.doc.schema.types[0]!;
    expect(weapon.fields.find((f) => f.name === "element")!.default).toBe("flame");
    expect(p.doc.schema.enums[0]!.members.map((m) => m.name)).toEqual(["kinetic", "flame", "ice"]);
    expect(e.formulas).toHaveLength(1); // ="fire"
    expect(issues(p)).toEqual([]);
    expect(() => p.renameEnumMember("Element", "fire", "x")).toThrow(/no member/);
    expect(() => p.renameEnumMember("Element", "ice", "flame")).toThrow(/already has/);
    undoes(p, start, e);
  });
});

describe("mergeList", () => {
  it("keeps what each side added, drops what one removed, and follows a reorder of an unchanged list", () => {
    expect(mergeList(["a", "b"], ["a", "b", "c"], ["a", "b", "d"])).toEqual(["a", "b", "d", "c"]);
    expect(mergeList(["a", "b"], ["x", "a", "b"], ["a", "b"])).toEqual(["x", "a", "b"]);
    expect(mergeList(["a", "b", "c"], ["a", "c"], ["a", "b", "c", "d"])).toEqual(["a", "c", "d"]);
    expect(mergeList(["a", "b"], ["a", "b", "c"], ["b"])).toEqual(["b", "c"]);
    expect(mergeList(["a", "b"], ["b", "a"], ["a", "b"])).toEqual(["b", "a"]);
    expect(mergeList([{ name: "a" }], [{ name: "a", description: "x" }], [{ name: "a" }, { name: "b" }])).toEqual([{ name: "a", description: "x" }, { name: "b" }]);
  });
});

describe("schema ops on rebase", () => {
  /** Two tasks from the same base. Theirs lands; mine rebases onto it. */
  function tasks(theirs: (p: Project) => Edit[], mine: (p: Project) => Edit[], resolve?: Resolve) {
    const b = cloneDoc(base().doc);
    const task = (salt: string) => {
      const p = Project.fromDoc(cloneDoc(b));
      p.wb.idSalt = salt;
      return p;
    };
    const t = theirs(task("t")).flatMap((e) => e.ops);
    const m = mine(task("m")).flatMap((e) => e.ops);
    const r = rebase(b, t, m, resolve);
    // The rebased ops really apply to the head and give the reported document.
    const head = cloneDoc(b);
    for (const op of [...t, ...r.ops]) applyOp(head, op);
    expect(canonDoc(head)).toEqual(canonDoc(r.state));
    return { ...r, ids: r.conflicts.map((c) => conflictId(c)), head: Project.fromDoc(r.state) };
  }

  it("enum members added on both sides are all kept, theirs first", () => {
    const r = tasks(
      (p) => [p.setDef("Element", { members: [...p.doc.schema.enums[0]!.members, { name: "acid" }] })],
      (p) => [p.setDef("Element", { members: [...p.doc.schema.enums[0]!.members, { name: "void" }] })],
    );
    expect(r.ids).toEqual([]);
    expect(r.state.schema.enums[0]!.members.map((m) => m.name)).toEqual(["kinetic", "fire", "ice", "acid", "void"]);
  });

  it("fields added at the same place on both sides are both kept, theirs first", () => {
    const r = tasks(
      (p) => [p.addField("Projectile", { name: "radius", type: "float" })],
      (p) => [p.addField("Projectile", { name: "mass", type: "float" })],
    );
    expect(r.ids).toEqual([]);
    expect(r.state.schema.types[1]!.fields.map((f) => f.name)).toEqual(["speed", "radius", "mass"]);
    expect(issues(r.head)).toEqual([]);
  });

  it("the same property set differently on both sides conflicts; the resolution picks", () => {
    const t = (p: Project) => [p.setField("Projectile", "speed", { min: 1 })];
    const m = (p: Project) => [p.setField("Projectile", "speed", { min: 2 })];
    const r = tasks(t, m);
    expect(r.ids).toEqual([expect.stringMatching(/^schema .*#min$/)]);
    expect(r.state.schema.types[1]!.fields[0]!.min).toBe(1);
    expect(tasks(t, m, () => "mine").state.schema.types[1]!.fields[0]!.min).toBe(2);
    // Different properties of the same field don't conflict.
    const both = tasks(t, (p) => [p.setField("Projectile", "speed", { max: 9 })]);
    expect(both.ids).toEqual([]);
    expect(both.state.schema.types[1]!.fields[0]).toMatchObject({ min: 1, max: 9 });
  });

  it("a field one side removed and the other changed conflicts; keeping the change brings it back", () => {
    const t = (p: Project) => [p.removeField("Projectile", "speed")];
    const m = (p: Project) => [p.setField("Projectile", "speed", { min: 2 })];
    const r = tasks(t, m);
    expect(r.ids).toEqual([expect.stringMatching(/^schemaDeleted .* by theirs$/)]);
    expect(r.state.schema.types[1]!.fields).toEqual([]);
    const keep = tasks(t, m, () => "mine");
    expect(keep.state.schema.types[1]!.fields[0]).toMatchObject({ name: "speed", min: 2 });
    // Mine removing a type theirs added a field to: keeping theirs keeps the type.
    const kept = tasks((p) => [p.addField("Projectile", { name: "mass", type: "float" })], (p) => [p.removeDef("Projectile")]);
    expect(kept.ids).toEqual([expect.stringMatching(/^schemaDeleted .* by mine$/)]);
    expect(kept.state.schema.types[1]!.fields.map((f) => f.name)).toEqual(["speed", "mass"]);
  });

  it("renameType is re-run on the head, so rows theirs added are renamed too", () => {
    const r = tasks(
      (p) => [p.setRows(p.sheetId("S"), [["Projectile", "dart", "8"]], 8)],
      (p) => [p.renameType("Projectile", "Shot")],
    );
    expect(r.ids).toEqual([]);
    expect([cell(r.head, "A3"), cell(r.head, "A8")]).toEqual(["Shot", "Shot"]);
    expect(issues(r.head)).toEqual([]);
  });

  it("two renames of the same type conflict; resolving for mine renames everything to mine's name", () => {
    const t = (p: Project) => [p.renameType("Projectile", "Bullet")];
    const m = (p: Project) => [p.renameType("Projectile", "Shot")];
    const r = tasks(t, m);
    expect(r.ids).toContainEqual(expect.stringMatching(/^schema .*#name$/));
    expect(cell(r.head, "A3")).toBe("Bullet");
    expect(issues(r.head)).toEqual([]);
    const mine = tasks(t, m, () => "mine");
    expect(cell(mine.head, "A3")).toBe("Shot");
    expect(mine.state.schema.types[0]!.fields.find((f) => f.name === "main")!.type).toEqual({ kind: "ref", targets: ["Shot"] });
    expect(issues(mine.head)).toEqual([]);
  });

  it("renameEnumMember reaches cells theirs wrote; two renames of one member conflict", () => {
    const r = tasks(
      (p) => [p.set(p.sheetId("S"), "E2", "fire"), p.setRows(p.sheetId("S"), [["Weapon", "torch", "", "1", "fire"]], 8)],
      (p) => [p.renameEnumMember("Element", "fire", "flame")],
    );
    expect(r.ids).toEqual([]);
    expect(cell(r.head, "E8")).toBe("flame");
    expect(issues(r.head)).toEqual([]);
    const both = tasks((p) => [p.renameEnumMember("Element", "fire", "blaze")], (p) => [p.renameEnumMember("Element", "fire", "flame")]);
    expect(both.ids).toContainEqual(expect.stringMatching(/^enumRename /));
    expect(both.state.schema.enums[0]!.members.map((m) => m.name)).toEqual(["kinetic", "blaze", "ice"]);
    expect(cell(both.head, "E1")).toBe("blaze");
    const mine = tasks((p) => [p.renameEnumMember("Element", "fire", "blaze")], (p) => [p.renameEnumMember("Element", "fire", "flame")], () => "mine");
    expect(mine.state.schema.enums[0]!.members.map((m) => m.name)).toEqual(["kinetic", "flame", "ice"]);
    expect(cell(mine.head, "E1")).toBe("flame");
    expect(issues(mine.head)).toEqual([]);
  });

  it("a field mine adds names a type theirs renamed: it gets the new name", () => {
    const r = tasks((p) => [p.renameType("Projectile", "Shot")], (p) => [p.addField("Weapon", { name: "alt", type: "list<ref<Projectile>>" })]);
    expect(r.ids).toEqual([]);
    expect(r.state.schema.types[0]!.fields.at(-1)!.type).toEqual({ kind: "list", of: { kind: "ref", targets: ["Shot"] } });
    expect(issues(r.head)).toEqual([]);
  });

  it("mine renaming a field and back leaves theirs' rename of it", () => {
    const r = tasks(
      (p) => [p.renameField("Projectile", "speed", "velocity")],
      (p) => [p.renameField("Projectile", "speed", "pace"), p.renameField("Projectile", "pace", "speed")],
    );
    expect(r.ids).toEqual([]);
    expect(r.state.schema.types[1]!.fields[0]!.name).toBe("velocity");
  });

  it("mine adding an enum member and taking it out again doesn't remove theirs' member of that name", () => {
    const add = (p: Project) => p.setDef("Element", { members: [...p.doc.schema.enums[0]!.members, { name: "acid" }] });
    const r = tasks(
      (p) => [add(p)],
      (p) => [add(p), p.setDef("Element", { members: p.doc.schema.enums[0]!.members.filter((m) => m.name !== "acid") })],
    );
    expect(r.state.schema.enums[0]!.members.map((m) => m.name)).toEqual(["kinetic", "fire", "ice", "acid"]);
  });

  it("a field theirs renamed keeps mine's edits to it: fields are addressed by ID", () => {
    const r = tasks((p) => [p.renameField("Projectile", "speed", "velocity")], (p) => [p.setField("Projectile", "speed", { min: 1 })]);
    expect(r.ids).toEqual([]);
    expect(r.state.schema.types[1]!.fields[0]).toMatchObject({ name: "velocity", min: 1 });
  });
});
