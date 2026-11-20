import { describe, expect, it } from "vitest";
import { Engine } from "./engine.ts";
import { Workbook } from "./model.ts";
import { isErr, type Value } from "./values.ts";

const code = (v: Value): string | null => (isErr(v) ? v.code : null);

/** Weapon rows whose ID is computed: B = Tuning!A1 (prefix) & K (a number column). */
function world(n = 5) {
  const wb = new Workbook();
  const weapons = wb.addSheet("Weapon");
  const tuning = wb.addSheet("Tuning", "root", "scratch");
  const calc = wb.addSheet("Calc", "root", "scratch");
  const e = new Engine(wb);
  e.batch(() => {
    e.setLayout(weapons, "Weapon", ["damage"]);
    e.set(tuning, "A1", "w");
    for (let r = 1; r <= n; r++) {
      e.setAt(weapons, r, 1, "Weapon");
      e.setAt(weapons, r, 2, `=Tuning!$A$1&K${r}`);
      e.setAt(weapons, r, 3, String(r * 10));
      e.setAt(weapons, r, 11, String(r));
    }
  });
  return { wb, e, weapons, tuning, calc };
}

describe("formula IDs", () => {
  it("are indexed once computed", () => {
    const { e, weapons, calc } = world();
    expect(e.getAt(weapons, 3, 2)).toBe("w3");
    e.set(calc, "A1", '=ENTITY("w3").damage');
    expect(e.get(calc, "A1")).toBe(30);
  });

  it("readers written before the IDs (in the same batch) still resolve", () => {
    const wb = new Workbook();
    const weapons = wb.addSheet("Weapon");
    const calc = wb.addSheet("Calc", "root", "scratch");
    const e = new Engine(wb);
    e.batch(() => {
      e.set(calc, "A1", '=ENTITY("x2").damage + ROWS(ENTITIES("Weapon"))');
      e.setLayout(weapons, "Weapon", ["damage"]);
      for (let r = 3; r >= 1; r--) {
        e.setAt(weapons, r, 3, String(r * 100));
        e.setAt(weapons, r, 2, `="x"&C${r}/100`);
        e.setAt(weapons, r, 1, "Weapon");
      }
    });
    expect(e.get(calc, "A1")).toBe(203);
  });

  it("editing an input renames the entity; readers follow the ID", () => {
    const { e, weapons, calc } = world();
    e.batch(() => {
      e.set(calc, "A1", '=ENTITY("w3").damage');
      e.set(calc, "A2", '=ENTITY("w99").damage');
    });
    e.setAt(weapons, 3, 11, "99"); // row 3 is now w99
    expect(code(e.get(calc, "A1"))).toBe("#REF!");
    expect(e.get(calc, "A2")).toBe(30);
  });

  it("one prefix edit renames every entity, and each reader recomputes once", () => {
    const n = 2000;
    const { e, tuning, calc } = world(n);
    e.batch(() => {
      for (let r = 1; r <= n; r++) e.setAt(calc, r, 1, `=ENTITY("v${r}").damage`);
      e.setAt(calc, 1, 2, '=SUM(ENTITIES("Weapon", "damage"))');
      e.setAt(calc, 2, 2, '=INDEX(ENTITIES("Weapon"), 1)');
    });
    expect(code(e.getAt(calc, 7, 1))).toBe("#REF!");
    e.set(tuning, "A1", "v");
    expect(e.getAt(calc, 7, 1)).toBe(70);
    expect(e.getAt(calc, 2, 2)).toBe("v1");
    // n ID cells + n ENTITY readers + 2 ENTITIES readers, no repeats.
    expect(e.lastEvaluations).toBe(2 * n + 2);
  });

  it("duplicates created by a formula resolve once the clash is undone", () => {
    const { e, weapons, calc } = world();
    e.set(calc, "A1", '=ENTITY("w2").damage');
    e.setAt(weapons, 4, 11, "2"); // row 4 also computes "w2"
    expect(e.get(calc, "A1")).toBe(20); // first one wins; validation reports the duplicate
    e.setAt(weapons, 2, 11, "7");
    expect(e.get(calc, "A1")).toBe(40);
  });

  it("an ID may not depend on the entity index, even indirectly", () => {
    const { e, weapons, calc } = world();
    e.setAt(weapons, 2, 2, '=ENTITY("w1").id & "_child"');
    const v = e.getAt(weapons, 2, 2);
    expect(code(v)).toBe("#CYCLE!");
    expect(isErr(v) && v.detail).toContain("can't depend on ENTITY()");
    // Through another cell:
    e.set(calc, "Z1", '=ROWS(ENTITIES("Weapon"))');
    e.setAt(weapons, 3, 2, '="w"&Calc!Z1');
    expect(code(e.getAt(weapons, 3, 2))).toBe("#CYCLE!");
    // And through a range read:
    e.setAt(weapons, 4, 2, '="w"&SUM(Calc!Z1:Z2)');
    expect(code(e.getAt(weapons, 4, 2))).toBe("#CYCLE!");
    // The rest of the index is unaffected.
    e.set(calc, "A1", '=ENTITY("w5").damage');
    expect(e.get(calc, "A1")).toBe(50);
  });

  it("the oscillating case terminates", () => {
    const { e, weapons } = world(1);
    // Without the rule this would flip between "x" and "y" forever.
    e.setAt(weapons, 1, 2, '=IF(ISERROR(ENTITY("x")), "x", "y")');
    expect(code(e.getAt(weapons, 1, 2))).toBe("#CYCLE!");
  });

  it("the rule applies only to entity rows", () => {
    const { e, weapons, calc } = world();
    e.set(calc, "A1", '=ENTITY("w1").damage');
    e.setAt(weapons, 2, 1, ""); // row 2 becomes a scratch row
    e.setAt(weapons, 2, 2, '=ENTITY("w1").damage');
    expect(e.getAt(weapons, 2, 2)).toBe(10);
    e.setAt(weapons, 2, 1, "Weapon"); // back to an entity row: column B is an ID again
    expect(code(e.getAt(weapons, 2, 2))).toBe("#CYCLE!");
  });

  it("column A can't be a formula on a data sheet", () => {
    const { e, weapons, calc } = world();
    e.set(calc, "A1", '=ENTITY("w2").damage');
    e.setAt(weapons, 2, 1, '="Weapon"');
    expect(code(e.getAt(weapons, 2, 1))).toBe("#VALUE!");
    expect(code(e.get(calc, "A1"))).toBe("#REF!"); // row 2 is no longer an entity
  });

  it("row moves don't change computed IDs", () => {
    const { e, weapons, calc } = world();
    e.set(calc, "A1", '=ENTITY("w2").damage');
    e.moveRows(weapons, 2, 1, 5);
    expect(e.getAt(weapons, 5, 2)).toBe("w2");
    expect(e.get(calc, "A1")).toBe(20);
  });

  it("ID changes are detected per row and references can follow", () => {
    const { e, weapons, calc } = world();
    e.batch(() => {
      e.set(calc, "A1", '=ENTITY("w3").damage * 2');
      e.set(calc, "A2", '=ENTITY("w4").damage');
    });
    const before = e.entityIds();
    e.setAt(weapons, 3, 11, "30");
    const changes = Engine.idChanges(before, e.entityIds());
    expect(changes).toEqual([{ row: expect.any(String), type: "Weapon", from: "w3", to: "w30" }]);
    expect(code(e.get(calc, "A1"))).toBe("#REF!");
    for (const c of changes) expect(e.rewriteEntityRefs(c.from, c.to)).toBe(1);
    expect(e.formula(calc, "A1")).toBe('=ENTITY("w30").damage*2');
    expect(e.get(calc, "A1")).toBe(60);
    expect(e.get(calc, "A2")).toBe(40);
  });
});
