import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonDoc, cloneDoc } from "../ops/doc.ts";
import { formatSchema } from "../schema/yaml.ts";
import { ApiError, Sapwood, type ApiErrorCode } from "./sapwood.ts";

function fails(code: ApiErrorCode, fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe(code);
    return (e as ApiError).message;
  }
  throw new Error(`expected ${code}`);
}

const SCHEMA = `
enums:
  Element: { members: [fire, ice] }
structs:
  Cost: { fields: { amount: int, currency: string } }
types:
  Weapon:
    fields:
      damage: float
      element: "enum<Element>"
      shots: "list<ref<Ammo>>"
      price: "struct<Cost>"
  Ammo: { fields: { speed: float, spin: float } }
  Config:
    singleton: true
    fields: { lives: int }
`;
const project = () =>
  Sapwood.load(SCHEMA, {
    sheets: [
      { name: "Weapons", rows: [["Weapon", "w1", 10, "fire", '["a1"]', '{"amount":5}'], ["Weapon", "w2", "=C1*2", "ice"]] },
      { name: "Ammo", rows: [["Ammo", "a1", 900, 1], ["Ammo", "a2", 600], ["Config"], [".lives", 3], ["", '=ENTITIES("Ammo")']] },
    ],
  });

/** Replace exactly one occurrence. */
function edit(text: string, from: string | RegExp, to: string): string {
  const n = typeof from === "string" ? text.split(from).length - 1 : (text.match(new RegExp(from, "g")) ?? []).length;
  expect(n, `${from} in\n${text}`).toBe(1);
  return text.replace(from, to);
}

describe("schema apply", () => {
  it("the schema as it is changes nothing, with or without its IDs", () => {
    const s = project();
    const text = s.schemaYaml();
    expect(s.applySchema(text).ops).toEqual([]);
    const bare = text.replace(/id: [\w"]+, /g, "").replace(/^ *id: .*\n/gm, "");
    expect(bare).not.toContain("id:");
    const c = s.applySchema(bare);
    expect(c.ops).toEqual([]);
    expect(s.schemaYaml()).toBe(text);
  });

  it("additions: fields, definitions and members, without shifting columns", () => {
    const s = project();
    const before = canonDoc(cloneDoc(s.doc));
    let t = s.schemaYaml();
    t = edit(t, "members: [fire, ice]", "members: [fire, ice, poison]");
    t = edit(t, /( +)damage: +(\{[^}]*\})\n/, "$1damage: $2\n$1weight: { type: float, min: 0 }\n"); // mid-type
    t = edit(t, "types:\n", "types:\n  Shield:\n    fields:\n      hp: { type: int }\n");
    s.applySchema(t);
    expect(s.get("w1")).toMatchObject({ damage: 10, element: "fire", shots: ["a1"], price: { amount: 5 } });
    expect(s.get("w1").weight).toBeUndefined();
    s.set("w1", { weight: 2, element: "poison" });
    expect(s.get("w1")).toMatchObject({ weight: 2, element: "poison", damage: 10 });
    s.create("Shield", { $id: "sh1", hp: 3 }, { sheet: "Weapons" });
    expect(s.validate().issues).toEqual([]);
    s.undo();
    s.undo();
    s.undo();
    expect(canonDoc(s.doc)).toEqual(before);
  });

  it("renames rewrite cells, and report the formulas they leave alone", () => {
    const s = project();
    let t = s.schemaYaml();
    t = edit(t, "  Ammo:\n", "  Bullet:\n");
    t = edit(t, "list<ref<Ammo>>", "list<ref<Bullet>>");
    t = edit(t, "speed:", "velocity:");
    t = edit(t, "members: [fire, ice]", "members: [flame, ice]");
    const c = s.applySchema(t);
    expect(s.get("a1")).toMatchObject({ $type: "Bullet", velocity: 900 });
    expect(s.get("w1")).toMatchObject({ element: "flame", shots: ["a1"] });
    expect(c.formulas).toEqual([{ sheet: "Ammo", cell: "B5" }]);
    expect(s.validate().issues).toEqual([]);
    expect(s.schemaYaml()).toBe(formatSchema(s.doc.schema));
  });

  it("names can be swapped", () => {
    const s = project();
    let t = s.schemaYaml();
    t = edit(t, "speed:", "SPIN:").replace("spin:", "speed:").replace("SPIN:", "spin:");
    t = t.replace("  Ammo:\n", "  Cost2:\n").replace("  Cost:\n", "  Ammo:\n").replace("  Cost2:\n", "  Cost:\n");
    t = t.replace("ref<Ammo>", "ref<Cost>").replace("struct<Cost>", "struct<Ammo>");
    s.applySchema(t);
    expect(s.get("a1")).toMatchObject({ $type: "Cost", speed: 1, spin: 900 });
    expect(s.get("w1").price).toEqual({ amount: 5 });
    expect(s.validate().issues).toEqual([]);
  });

  it("removing a field with data needs force; its cells stay, as scratch", () => {
    const s = project();
    const before = canonDoc(cloneDoc(s.doc));
    const t = edit(s.schemaYaml(), /\n *speed: \{[^}]*\}/, "");
    expect(fails("confirm", () => s.applySchema(t))).toContain("Ammo.speed turns 2 cells holding data into scratch (Ammo!C1, Ammo!C2)");
    expect(canonDoc(s.doc)).toEqual(before);
    const c = s.applySchema(t, { force: true });
    expect(c.scratch).toEqual([{ sheet: "Ammo", cell: "C1" }, { sheet: "Ammo", cell: "C2" }]);
    expect(s.get("a1")).toEqual({ $type: "Ammo", $id: "a1", $pack: "root", $sheet: "Ammo", $active: true, spin: 1 }); // spin stays in D
    s.undo();
    expect(canonDoc(s.doc)).toEqual(before);
  });

  it("property changes, a moved field, and order changes reported", () => {
    const s = project();
    let t = s.schemaYaml();
    t = edit(t, /(speed: \{[^}]*type: float)/, "$1, min: 700");
    t = edit(t, /\n( *)lives: (\{[^}]*\})/, "\n$1lives: $2\n$1spin: { type: float }");
    const c = s.applySchema(edit(t, /\n *spin: +\{ id: [^}]*\}/, ""), { force: true });
    expect(s.validate().issues.map((i) => i.code)).toEqual(["field.constraint"]);
    expect(c.scratch).toEqual([{ sheet: "Ammo", cell: "D1" }]);
    const u = s.schemaYaml();
    const swapped = u.replace(/(\n *damage: +\{[^}]*\})(\n *element: +\{[^}]*\})/, "$2$1");
    expect(swapped).not.toBe(u);
    const r = s.applySchema(swapped);
    expect(r.ops).toEqual([]);
    expect(r.notes).toEqual(["The order of Weapon's fields changed; reordering isn't applied yet, so the old order stays"]);
  });

  it("rows that become another type in the edit keep their columns, as one edit at a time does", () => {
    // Ammo removed and Weapon renamed to Ammo: the Ammo sheet's rows are the renamed Weapon's
    // now, by position from C. A field put in after damage mustn't shift them onto the next column.
    const s = project();
    const other = Sapwood.fromDoc(cloneDoc(s.doc));
    other.project.removeDef("Ammo");
    other.project.renameType("Weapon", "Ammo");
    other.project.addField("Ammo", { name: "range", type: "int" }, "damage");
    s.applySchema(other.schemaYaml(), { force: true });
    expect(s.validate()).toEqual(other.validate());
    expect(s.get("a1")).toEqual(other.get("a1"));
    expect(s.get("a1")).toMatchObject({ damage: 900, element: { $invalid: 1 } }); // D stays element's
    expect(s.get("a1").range).toBe(undefined);
  });

  it("text that doesn't parse or resolve is refused", () => {
    const s = project();
    expect(fails("bad-schema", () => s.applySchema("types: [1"))).toContain("The schema has problems");
    expect(fails("bad-schema", () => s.applySchema(edit(s.schemaYaml(), "list<ref<Ammo>>", "list<ref<Nope>>")))).toContain("Nope");
  });
});

describe("schema apply (properties)", () => {
  const RUNS = Number(process.env.RUNS ?? 150);
  it("a removed type's pinned layout goes with it, so a type renamed to its name starts afresh", () => {
    // Found by the property below: one edit at a time, removing a field pinned Weapon's
    // layout, removing Weapon left the pin, and Ammo renamed to Weapon took it over.
    const s = project();
    const other = Sapwood.fromDoc(cloneDoc(s.doc));
    const p = other.project;
    p.removeField("Weapon", "damage");
    expect(p.doc.sheets.get(p.sheetId("Weapons"))!.layouts.has("Weapon")).toBe(true);
    p.removeDef("Weapon");
    expect(p.doc.sheets.get(p.sheetId("Weapons"))!.layouts.has("Weapon")).toBe(false);
    p.renameType("Ammo", "Weapon");
    s.applySchema(other.schemaYaml(), { force: true });
    expect(s.validate()).toEqual(other.validate());
    expect(s.get("w1")).toEqual(other.get("w1"));
  });

  const NAMES = ["Ammo", "Weapon", "Cost", "Shield", "Element"];
  const FIELDS = ["speed", "spin", "damage", "element", "price", "hp", "amount"];

  it("applying another copy's edited schema gives what its edits gave", () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const pick = <T,>(xs: readonly T[]): T => xs[g(fc.integer, { min: 0, max: xs.length - 1 })]!;
        const s = project();
        const start = canonDoc(cloneDoc(s.doc));
        const other = Sapwood.fromDoc(cloneDoc(s.doc));
        const p = other.project;
        // Edits with their arguments, and their order in what applySchema does: removals,
        // renames, then the rest. The text shows only where edits end up, so in another order
        // (rename a type, then remove it) the copy's cells can differ for reasons no text shows.
        // A type is renamed at most once. The text shows only where a type ends up: Weapon renamed
        // to Ammo (a name just freed) and then to Ammo2 reads as Weapon to Ammo2, though one at a
        // time the second rename also took the old Ammo's rows along, which no text shows.
        const renamed = new Set<string>();
        const done: string[] = []; // the edits that applied, said in a failure
        const did = <T,>(what: string, f: () => T): T => {
          const r = f();
          done.push(what);
          return r;
        };
        const edits: [number, () => unknown][] = [];
        for (let i = g(fc.integer, { min: 1, max: 6 }); i > 0; i--) {
          const [a, b, c, d] = [pick(NAMES), pick(FIELDS), pick(FIELDS), pick(NAMES)];
          edits.push(pick<[number, () => unknown]>([
            [2, () => { const type = pick(["int", "float", "string", "list<ref<Ammo>>"]), after = pick([undefined, c]); return did(`addField ${a}.${b + i}: ${type} after ${after}`, () => p.addField(a, { name: b + i, type }, after)); }],
            [0, () => did(`removeField ${a}.${b}`, () => p.removeField(a, b))],
            [1, () => did(`renameField ${a}.${b} ${c}`, () => p.renameField(a, b, c))],
            [1, () => { const to = d + pick(["", "2"]); if (renamed.has(a)) return; return did(`renameType ${a} ${to}`, () => (renamed.add(to), p.renameType(a, to))); }], // once each: see renamed
            [2, () => { const x = pick([{ min: 1 }, { type: "string" }, { required: true }, { min: null }]); return did(`setField ${a}.${b} ${JSON.stringify(x)}`, () => p.setField(a, b, x)); }],
            [1, () => { const [f, t] = [pick(["fire", "ice"]), pick(["flame", "frost"])]; return did(`renameEnumMember ${f} ${t}`, () => p.renameEnumMember("Element", f, t)); }], // to names it never had: see schemaRenames
            [2, () => did(`addDef ${a}S`, () => p.addDef("structs", { name: a + "S", fields: [{ name: "x", type: "int" }] }))],
            [0, () => did(`removeDef ${a}`, () => p.removeDef(a))],
          ]));
        }
        for (const [, edit] of edits.sort((x, y) => x[0] - y[0]))
          try {
            edit();
          } catch {
            // an edit that doesn't apply to this schema
          }
        const target = other.schemaYaml();
        try {
          s.applySchema(target, { force: true });
        } catch (e) {
          // The other copy's edits may leave a schema that doesn't resolve: then it's refused, and nothing changes.
          expect((e as ApiError).code).toBe("bad-schema");
          expect(canonDoc(s.doc)).toEqual(start);
          return;
        }
        const edited = done.join("; ");
        expect(s.schemaYaml(), edited).toBe(target);
        expect(s.validate(), edited).toEqual(other.validate());
        for (const id of ["w1", "w2", "a1", "a2"]) {
          const read = (x: Sapwood) => { try { return x.get(id); } catch (e) { return (e as ApiError).code; } };
          expect(read(s), edited).toEqual(read(other));
        }
        expect(s.applySchema(target).ops).toEqual([]);
        s.undo();
        s.undo();
        expect(canonDoc(s.doc)).toEqual(start);
      }),
      { numRuns: RUNS },
    );
  });
});
