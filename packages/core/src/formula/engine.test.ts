import { describe, expect, it } from "vitest";
import { Engine } from "./engine.ts";
import { Workbook } from "./model.ts";
import { isErr, type Value } from "./values.ts";

function setup() {
  const wb = new Workbook();
  const s = wb.addSheet("Scratch", "root", "scratch");
  const e = new Engine(wb);
  return { wb, s, e };
}

const code = (v: Value): string | null => (isErr(v) ? v.code : null);

describe("operators and literals", () => {
  const cases: [string, unknown][] = [
    ["=1+2*3", 7],
    ["=(1+2)*3", 9],
    ["=-2^2", 4],
    ["=2^3^2", 64],
    ["=10/4", 2.5],
    ["=1/0", "#DIV/0!"],
    ['="a"&1&TRUE', "a1TRUE"],
    ["=2>1", true],
    ['="abc"="ABC"', true],
    ['="5"+1', 6],
    ['="x"+1', "#VALUE!"],
    ["=50%", 0.5],
    ["=0.1+0.2", 0.30000000000000004],
  ];
  it.each(cases)("%s", (f, want) => {
    const { s, e } = setup();
    e.set(s, "A1", f);
    const v = e.get(s, "A1");
    expect(isErr(v) ? v.code : v).toBe(want);
  });

  it("reports syntax errors and keeps the text", () => {
    const { s, e } = setup();
    e.set(s, "A1", "=1+");
    expect(code(e.get(s, "A1"))).toBe("#ERROR!");
    expect(e.formula(s, "A1")).toBe("=1+");
  });
});

describe("references and recalculation", () => {
  it("recalculates downstream cells only", () => {
    const { s, e } = setup();
    e.batch(() => {
      e.set(s, "A1", "1");
      e.set(s, "A2", "=A1+1");
      e.set(s, "A3", "=A2*10");
      e.set(s, "B1", "=100");
    });
    expect(e.get(s, "A3")).toBe(20);
    e.set(s, "A1", "5");
    expect(e.get(s, "A3")).toBe(60);
    expect(e.lastEvaluations).toBe(2);
  });

  it("handles a 20k-long chain built in reverse without deep recursion", () => {
    const { s, e } = setup();
    const n = 20_000;
    e.batch(() => {
      for (let r = n; r >= 2; r--) e.setAt(s, r, 1, `=A${r - 1}+1`);
      e.set(s, "A1", "1");
    });
    expect(e.getAt(s, n, 1)).toBe(n);
    e.set(s, "A1", "2");
    expect(e.getAt(s, n, 1)).toBe(n + 1);
    expect(e.lastEvaluations).toBe(n - 1); // already in a good order: no retries
  });

  it("detects cycles and recovers when broken", () => {
    const { s, e } = setup();
    e.batch(() => {
      e.set(s, "A1", "=B1+1");
      e.set(s, "B1", "=A1+1");
      e.set(s, "C1", "=A1");
    });
    expect(code(e.get(s, "A1"))).toBe("#CYCLE!");
    expect(code(e.get(s, "B1"))).toBe("#CYCLE!");
    expect(code(e.get(s, "C1"))).toBe("#CYCLE!");
    e.set(s, "B1", "7");
    expect(e.get(s, "A1")).toBe(8);
    expect(e.get(s, "C1")).toBe(8);
  });

  it("every cell on a cycle is #CYCLE!, whichever is evaluated first", () => {
    // A2 reads A1 through a range but picks another element, so it never sees A1's error:
    // only finding the cycle itself can make it #CYCLE!.
    for (const first of ["A1", "A2"]) {
      const { s, e } = setup();
      const inputs: Record<string, string> = { A1: "=A2+1", A2: "=INDEX(A1:A3, 3)", A3: "5" };
      e.batch(() => {
        e.set(s, first, inputs[first]!);
        for (const [a1, input] of Object.entries(inputs)) if (a1 !== first) e.set(s, a1, input);
      });
      expect(code(e.get(s, "A1")), first).toBe("#CYCLE!");
      expect(code(e.get(s, "A2")), first).toBe("#CYCLE!");
      e.set(s, "A1", "1");
      expect(e.get(s, "A2"), first).toBe(5);
    }
  });

  it("a cycle reached from two sides is #CYCLE! all round", () => {
    // B1 is on two cycles, with A1 and with C1; A1 and C1 pick other elements.
    for (const order of [["A1", "B1", "C1"], ["C1", "B1", "A1"], ["B1", "A1", "C1"]]) {
      const { s, e } = setup();
      const inputs: Record<string, string> = { A1: "=INDEX(B1:B2, 2)", B1: "=A1+C1", B2: "3", C1: "=INDEX(B1:B2, 2)" };
      e.batch(() => {
        for (const a1 of [...order, "B2"]) e.set(s, a1, inputs[a1]!);
      });
      for (const a1 of ["A1", "B1", "C1"]) expect(code(e.get(s, a1)), `${order} ${a1}`).toBe("#CYCLE!");
    }
  });

  it("self reference is a cycle", () => {
    const { s, e } = setup();
    e.set(s, "A1", "=A1+1");
    expect(code(e.get(s, "A1"))).toBe("#CYCLE!");
  });

  it("whole-column ranges track new rows", () => {
    const { wb, s, e } = setup();
    const t = wb.addSheet("Totals", "root", "scratch");
    e.batch(() => {
      for (let r = 1; r <= 5; r++) e.setAt(s, r, 3, String(r));
      e.set(t, "A1", "=SUM(Scratch!C:C)");
    });
    expect(e.get(t, "A1")).toBe(15);
    e.set(s, "C50", "100");
    expect(e.get(t, "A1")).toBe(115);
    expect(e.formula(t, "A1")).toBe("=SUM(Scratch!C:C)");
  });
});

describe("stable row/column IDs", () => {
  it("row insert shifts the rendered text, not the stored formula", () => {
    const { s, e } = setup();
    e.batch(() => {
      e.set(s, "A3", "21");
      e.set(s, "B1", "=A3*2");
    });
    e.insertRows(s, 1, 2);
    expect(e.formula(s, "B3")).toBe("=A5*2");
    expect(e.get(s, "B3")).toBe(42);
  });

  it("deleting a referenced row gives #REF!, restoring brings it back", () => {
    const { s, e } = setup();
    e.batch(() => {
      e.set(s, "A3", "21");
      e.set(s, "B1", "=A3*2");
    });
    const gone = e.deleteRows(s, 3);
    expect(e.formula(s, "B1")).toBe("=#REF!*2");
    expect(code(e.get(s, "B1"))).toBe("#REF!");
    e.restoreRows(s, gone);
    expect(e.formula(s, "B1")).toBe("=A3*2");
    expect(e.get(s, "B1")).toBe(42);
  });

  it("deleting a referenced row gives #REF! even when the referenced cell is empty", () => {
    const { s, e } = setup();
    e.set(s, "A1", "=B2+1");
    expect(e.get(s, "A1")).toBe(1);
    e.deleteRows(s, 2);
    expect(code(e.get(s, "A1"))).toBe("#REF!");
    e.deleteCols(s, 2);
    e.set(s, "C1", "=D3");
    e.deleteCols(s, 4);
    expect(code(e.get(s, "C1"))).toBe("#REF!");
  });

  it("ranges grow on insert inside and survive deleting a corner", () => {
    const { s, e } = setup();
    e.batch(() => {
      for (let r = 1; r <= 3; r++) e.setAt(s, r, 1, String(r));
      e.set(s, "B1", "=SUM(A1:A3)");
    });
    expect(e.get(s, "B1")).toBe(6);
    e.insertRows(s, 2);
    e.set(s, "A2", "10");
    expect(e.formula(s, "B1")).toBe("=SUM(A1:A4)");
    expect(e.get(s, "B1")).toBe(16);
    e.deleteRows(s, 4); // the bottom corner
    expect(e.formula(s, "B1")).toBe("=SUM(A1:A3)");
    expect(e.get(s, "B1")).toBe(13);
  });

  it("row moves keep references attached to their rows", () => {
    const { s, e } = setup();
    e.batch(() => {
      e.set(s, "A1", "1");
      e.set(s, "A2", "2");
      e.set(s, "A3", "3");
      e.set(s, "B5", "=A1*100");
    });
    e.moveRows(s, 1, 1, 3); // row 1 moves to the bottom of A1:A3
    expect(e.formula(s, "B5")).toBe("=A3*100");
    expect(e.get(s, "B5")).toBe(100);
  });

  it("column insert and delete", () => {
    const { s, e } = setup();
    e.batch(() => {
      e.set(s, "B1", "4");
      e.set(s, "D1", "=B1+1");
    });
    e.insertCols(s, 1);
    expect(e.formula(s, "E1")).toBe("=C1+1");
    e.deleteCols(s, 3);
    expect(e.formula(s, "D1")).toBe("=#REF!+1");
  });

  it("copy shifts relative references only", () => {
    const { s, e } = setup();
    e.batch(() => {
      e.set(s, "A1", "1");
      e.set(s, "A2", "2");
      e.set(s, "B1", "10");
      e.set(s, "C1", "=A1+$B$1");
    });
    e.copy(s, "C1", s, "C2");
    expect(e.formula(s, "C2")).toBe("=A2+$B$1");
    expect(e.get(s, "C2")).toBe(12);
  });
});

describe("cross-sheet references and pack reach", () => {
  function packs() {
    const wb = new Workbook();
    wb.addPack("weapons", "root");
    wb.addPack("enemies", "root");
    const rootTuning = wb.addSheet("Tuning", "root", "scratch");
    const weaponTuning = wb.addSheet("Tuning", "weapons", "scratch"); // same name, other pack
    const weapons = wb.addSheet("Weapon", "weapons", "scratch");
    const enemies = wb.addSheet("Enemy", "enemies", "scratch");
    const e = new Engine(wb);
    e.batch(() => {
      e.set(rootTuning, "A1", "1");
      e.set(weaponTuning, "A1", "2");
    });
    return { wb, e, rootTuning, weaponTuning, weapons, enemies };
  }

  it("bare names resolve in the own pack first, then ancestors", () => {
    const { e, weapons, enemies } = packs();
    e.set(weapons, "A1", "=Tuning!A1");
    e.set(enemies, "A1", "=Tuning!A1");
    expect(e.get(weapons, "A1")).toBe(2);
    expect(e.get(enemies, "A1")).toBe(1);
  });

  it("qualified names pick the pack explicitly", () => {
    const { e, weapons } = packs();
    e.set(weapons, "A1", "='root/Tuning'!A1");
    expect(e.get(weapons, "A1")).toBe(1);
    // Rendered qualified, because the bare name would mean weapons/Tuning here.
    expect(e.formula(weapons, "A1")).toBe("='root/Tuning'!A1");
  });

  it("a sibling or descendant pack is out of reach", () => {
    const { e, weapons, enemies, rootTuning } = packs();
    e.set(enemies, "A2", "='weapons/Weapon'!A1");
    expect(code(e.get(enemies, "A2"))).toBe("#REACH!");
    e.set(rootTuning, "A2", "=Weapon!A1"); // root can't see into weapons
    expect(code(e.get(rootTuning, "A2"))).toBe("#REF!");
    void weapons;
  });

  it("moving a sheet out of reach turns existing formulas into #REACH!", () => {
    const { wb, e, weapons, rootTuning } = packs();
    const shared = wb.addSheet("Shared", "root", "scratch");
    e.set(shared, "A1", "5");
    e.set(weapons, "A1", "=Shared!A1");
    expect(e.get(weapons, "A1")).toBe(5);
    e.setSheetPack(shared, "enemies");
    expect(code(e.get(weapons, "A1"))).toBe("#REACH!");
    void rootTuning;
  });
});

describe("entities", () => {
  function world() {
    const wb = new Workbook();
    wb.addPack("dlc", "root");
    const weapons = wb.addSheet("Weapon", "root");
    const dlc = wb.addSheet("DlcWeapon", "dlc");
    const calc = wb.addSheet("Calc", "root", "scratch");
    const e = new Engine(wb);
    e.batch(() => {
      e.setLayout(weapons, "Weapon", ["damage", "cooldown", "ammo"]);
      e.setLayout(dlc, "Weapon", ["damage", "cooldown", "ammo"]);
      const rows = [
        ["Weapon", "Blaster", "10", "0.5", "Cell"],
        ["#Weapon", "Old", "1", "1", ""],
        ["Weapon", "Cannon", "=ENTITY(\"Blaster\").damage*3", "2", "Shell"],
        ["", "scratch note", "", "", ""],
        ["Ammo", "Cell", "", "", ""],
        ["Ammo", "Shell", "", "", ""],
      ];
      rows.forEach((r, i) => r.forEach((v, j) => e.setAt(weapons, i + 1, j + 1, v)));
      e.setAt(dlc, 1, 1, "Weapon");
      e.setAt(dlc, 1, 2, "Laser");
      e.setAt(dlc, 1, 3, "99");
    });
    return { wb, e, weapons, dlc, calc };
  }

  it("ENTITY(id).field reads through the entity index", () => {
    const { e, weapons, calc } = world();
    expect(e.get(weapons, "C3")).toBe(30);
    e.set(calc, "A1", '=ENTITY("Blaster").damage + ENTITY("Cannon").damage');
    expect(e.get(calc, "A1")).toBe(40);
    e.set(weapons, "C1", "20");
    expect(e.get(weapons, "C3")).toBe(60);
    expect(e.get(calc, "A1")).toBe(80);
  });

  it("survives row moves; renames and inactive rows break it", () => {
    const { e, weapons, calc } = world();
    e.set(calc, "A1", '=ENTITY("Blaster").cooldown');
    e.moveRows(weapons, 1, 1, 6);
    expect(e.get(calc, "A1")).toBe(0.5);
    e.setAt(weapons, 6, 2, "Blaster2");
    expect(code(e.get(calc, "A1"))).toBe("#REF!");
    e.setAt(weapons, 6, 2, "Blaster");
    expect(e.get(calc, "A1")).toBe(0.5);
    e.setAt(weapons, 6, 1, "#Weapon");
    expect(code(e.get(calc, "A1"))).toBe("#REF!");
  });

  it("IDs are matched exactly, with a hint for case mismatches", () => {
    const { e, calc } = world();
    e.set(calc, "A1", '=ENTITY("blaster").damage');
    const v = e.get(calc, "A1");
    expect(isErr(v) && v.detail).toContain('did you mean "Blaster"');
  });

  it("unknown fields and pack reach", () => {
    const { e, calc, dlc } = world();
    e.set(calc, "A1", '=ENTITY("Blaster").speed');
    expect(code(e.get(calc, "A1"))).toBe("#NAME?");
    e.set(calc, "A2", '=ENTITY("Laser").damage');
    expect(code(e.get(calc, "A2"))).toBe("#REACH!");
    e.setAt(dlc, 2, 3, '=ENTITY("Blaster").damage + ENTITY("Laser").damage');
    expect(e.getAt(dlc, 2, 3)).toBe(109);
  });

  it("validation rules: per-entity names, REFS and global ENTITIES", () => {
    const { e, weapons } = world();
    expect(e.evalRule("=cooldown >= 0.05", "Blaster")).toBe(true);
    e.set(weapons, "D1", "0.01");
    expect(e.evalRule("=cooldown >= 0.05", "Blaster")).toBe(false);
    // Rules see every pack; Old is inactive. 10 + 30 + 99 (Laser, in dlc).
    expect(e.evalRule('=SUM(ENTITIES("Weapon", "damage"))')).toBe(139);
    expect(e.evalRule('=ROWS(ENTITIES("Ammo"))')).toBe(2);
    // REFS follows a ref field; `hp1` would be a cell in a sheet formula, but is a name in a rule.
    expect(e.evalRule('=COUNTA(REFS(ammo, "id"))', "Cannon")).toBe(1);
    e.set(weapons, "E3", '["Cell","Shell"]');
    expect(e.evalRule('=COUNTA(REFS(ammo, "id"))', "Cannon")).toBe(2);
  });

  it("ENTITIES in a cell recalculates when entities are added", () => {
    const { e, weapons, calc } = world();
    e.set(calc, "A1", '=ROWS(ENTITIES("Weapon"))');
    expect(e.get(calc, "A1")).toBe(2);
    e.setAt(weapons, 2, 1, "Weapon"); // un-comment "Old"
    expect(e.get(calc, "A1")).toBe(3);
  });

  it("ENTITIES(type, field) depends on the column, not on each cell", () => {
    const { e, weapons, calc } = world();
    e.set(calc, "A1", '=SUM(ENTITIES("Weapon", "damage"))');
    expect(e.get(calc, "A1")).toBe(40); // Blaster and Cannon; Laser is in dlc, out of reach
    e.set(weapons, "D1", "0.7"); // a cooldown, not a damage: nothing re-runs
    expect(e.lastEvaluations).toBe(0);
    e.set(weapons, "C1", "20"); // Cannon (3 × Blaster's damage), then the sum
    expect(e.get(calc, "A1")).toBe(80);
    expect(e.lastEvaluations).toBe(2);
  });

  it("ENTITIES(type, field) follows layout and type changes", () => {
    const { e, weapons, calc } = world();
    e.set(calc, "A1", '=SUM(ENTITIES("Weapon", "cooldown"))');
    expect(e.get(calc, "A1")).toBe(2.5);
    e.setLayout(weapons, "Weapon", ["cooldown", "damage", "ammo"]); // cooldown is column C now
    expect(e.get(calc, "A1")).toBe(11.5); // 10, and Cannon's formula: Blaster's damage (now D1, 0.5) × 3
    e.setAt(weapons, 3, 1, "Ammo"); // Cannon is no longer a weapon
    expect(e.get(calc, "A1")).toBe(10);
  });

  it("a duplicate ID of another type changes what ENTITIES(type, field) reads", () => {
    const { e, weapons, calc } = world();
    e.set(calc, "A1", '=SUM(ENTITIES("Weapon", "damage"))');
    expect(e.get(calc, "A1")).toBe(40);
    e.insertRows(weapons, 1);
    e.batch(() => {
      e.setAt(weapons, 1, 1, "Ammo");
      e.setAt(weapons, 1, 2, "Blaster"); // first in document order: ENTITY("Blaster") is this Ammo
    });
    expect(code(e.get(calc, "A1"))).toBe("#NAME?"); // an Ammo has no damage
    e.deleteRows(weapons, 1);
    expect(e.get(calc, "A1")).toBe(40);
  });

  it("row deletes, restores and moves update the index row by row", () => {
    const { e, weapons, calc } = world();
    e.batch(() => {
      e.set(calc, "A1", '=INDEX(ENTITIES("Weapon"), 1)');
      e.set(calc, "A2", '=ROWS(ENTITIES("Weapon"))');
    });
    e.moveRows(weapons, 1, 1, 6); // Blaster goes to the end
    expect(e.get(calc, "A1")).toBe("Cannon");
    const gone = e.deleteRows(weapons, 2, 1); // Cannon
    expect([e.get(calc, "A1"), e.get(calc, "A2")]).toEqual(["Blaster", 1]);
    e.restoreRows(weapons, gone);
    expect([e.get(calc, "A1"), e.get(calc, "A2")]).toEqual(["Cannon", 2]);
  });

  it("a column inserted before A re-reads every row", () => {
    const { e, weapons, calc } = world();
    e.set(calc, "A1", '=ROWS(ENTITIES("Weapon"))');
    e.insertCols(weapons, 1); // column A is empty now: no row is an entity
    expect(e.get(calc, "A1")).toBe(0);
    e.deleteCols(weapons, 1);
    expect(e.get(calc, "A1")).toBe(2);
  });
});

describe("functions", () => {
  const cases: [string, unknown][] = [
    ["=ROUND(2.675, 2)", 2.68],
    ["=ROUND(-2.5, 0)", -3],
    ["=ROUNDDOWN(2.679, 2)", 2.67],
    ["=MOD(-3, 2)", 1],
    ["=SUM(1, \"2\", TRUE)", 4],
    ["=SUM(T1:T3)", 6],
    ["=AVERAGE(T1:T3)", 2],
    ["=MAX(T1:T3)", 3],
    ["=COUNTIF(T1:T3, \">1\")", 2],
    ["=SUMIF(T1:T3, \"<>2\")", 4],
    ["=VLOOKUP(\"b\", L1:M3, 2, FALSE)", 20],
    ["=VLOOKUP(\"z\", L1:M3, 2, FALSE)", "#N/A"],
    ["=IFERROR(VLOOKUP(\"z\", L1:M3, 2, FALSE), -1)", -1],
    ["=INDEX(M1:M3, MATCH(\"c\", L1:L3, 0))", 30],
    ["=XLOOKUP(\"a\", L1:L3, M1:M3)", 10],
    ["=IF(T1>0, \"pos\", 1/0)", "pos"],
    ["=CONCAT(\"x\", T1:T3)", "x123"],
    ["=MID(\"sapwood\", 2, 3)", "apw"],
    ["=UPPER(LEFT(\"hello\", 2))", "HE"],
    ["=AND(TRUE, T1>0)", true],
    ["=NOPE(1)", "#NAME?"],
  ];
  it.each(cases)("%s", (f, want) => {
    const { s, e } = setup();
    e.batch(() => {
      ["1", "2", "3"].forEach((v, i) => e.setAt(s, i + 1, 20, v)); // T1:T3
      ["a", "b", "c"].forEach((v, i) => e.setAt(s, i + 1, 12, v)); // L1:L3
      ["10", "20", "30"].forEach((v, i) => e.setAt(s, i + 1, 13, v)); // M1:M3
      e.set(s, "A1", f);
    });
    const v = e.get(s, "A1");
    expect(isErr(v) ? v.code : v).toBe(want);
  });
});

describe("rendering", () => {
  const texts = [
    "=A1+B2*C3",
    "=(A1+B2)*C3",
    "=$A$1+A$2+$A3",
    "=SUM(A1:B10, Other!C:C, 3:5)",
    '=IF(A1>=2, "yes", "no")',
    '=ENTITY("Blaster").damage',
    "=-A1^2",
    "=-(A1^2)",
    "=A1-(B1-C1)",
    "=10%",
  ];
  it.each(texts)("%s round-trips", (t) => {
    const { wb, s, e } = setup();
    wb.addSheet("Other");
    e.set(s, "Z99", t);
    expect(e.formula(s, "Z99")).toBe(t);
  });
});

describe("wide readers computed before their inputs", () => {
  // Found in S2: a reader written above its inputs used to retry once per stale
  // precedent, which made loading 100k rows quadratic.
  it("evaluate each formula a bounded number of times", () => {
    const n = 3000;
    const wb = new Workbook();
    const s = wb.addSheet("S", "root", "scratch");
    const e = new Engine(wb);
    e.batch(() => {
      e.setAt(s, 1, 3, "=SUM(B:B)");
      for (let r = 1; r <= n; r++) {
        e.setAt(s, r, 1, String(r));
        e.setAt(s, r, 2, `=A${r}*2`);
      }
    });
    expect(e.getAt(s, 1, 3)).toBe(n * (n + 1));
    expect(e.lastEvaluations).toBeLessThanOrEqual(n + 2);
  });

  it("still detect a cycle through a wide read", () => {
    const wb = new Workbook();
    const s = wb.addSheet("S", "root", "scratch");
    const e = new Engine(wb);
    e.batch(() => {
      e.set(s, "C1", "=SUM(B1:B3)");
      e.set(s, "B1", "1");
      e.set(s, "B2", "=C1+1");
      e.set(s, "B3", "3");
    });
    expect(isErr(e.get(s, "C1")) || isErr(e.get(s, "B2"))).toBe(true);
  });
});

describe("ROW and COLUMN", () => {
  it("return positions and follow structure changes", () => {
    const { s, e } = setup();
    e.batch(() => {
      e.set(s, "B3", "=ROW()");
      e.set(s, "C1", "=COLUMN(E9)*100+ROW(E9)");
    });
    expect(e.get(s, "B3")).toBe(3);
    expect(e.get(s, "C1")).toBe(509);
    e.insertRows(s, 1, 2);
    expect(e.get(s, "B5")).toBe(5);
    expect(e.get(s, "C3")).toBe(511);
    e.moveRows(s, 5, 1, 1);
    expect(e.get(s, "B1")).toBe(1);
  });
});
