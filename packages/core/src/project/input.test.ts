import { describe, expect, it } from "vitest";
import { formulaR1C1, moveFormula } from "../formula/bind.ts";
import { contentKey } from "../formula/content.ts";
import { Sapwood } from "../api/sapwood.ts";
import { cellKey } from "../ops/doc.ts";
import { columnSpecs, sheetLayout } from "./layout.ts";
import { loadProject } from "./load.ts";

const SCHEMA = `
structs:
  Cost: { fields: { amount: int, currency: string } }
types:
  Weapon: { fields: { damage: float, price: "struct<Cost>", shots: "list<string>" } }
`;

describe("a cell's input", () => {
  it("typed back in, gives the same content", () => {
    const { project: p } = loadProject(SCHEMA, { sheets: [{ name: "S", rows: [["Weapon", "w1", 1]] }, { name: "T", rows: [[1]] }] });
    const s = p.sheetId("S");
    const sh = p.wb.sheet(s);
    for (const input of ["", "12.5", "-3", "TRUE", "false", "text", "'42", "'=not a formula", "'TRUE", "''quoted", "=C1*2", "=SUM(C:C)", "=T!A1+1", '=ENTITY("w1").damage', "=1+", "=Nowhere!A1"]) {
      p.set(s, "D1", input);
      const content = p.doc.sheets.get(s)!.cells.get(cellKey(sh.rows.idAt(1), sh.cols.idAt(4))) ?? null;
      const back = p.inputAt(s, sh.rows.idAt(1), sh.cols.idAt(4));
      p.set(s, "D1", back);
      const again = p.doc.sheets.get(s)!.cells.get(cellKey(sh.rows.idAt(1), sh.cols.idAt(4))) ?? null;
      expect(contentKey(again), `${input} -> ${back}`).toBe(contentKey(content));
    }
    p.set(s, "D1", "=C1*2");
    expect(p.inputAt(s, sh.rows.idAt(1), sh.cols.idAt(4))).toBe("=C1*2");
    p.set(s, "D1", "'42");
    expect(p.inputAt(s, sh.rows.idAt(1), sh.cols.idAt(4))).toBe("'42");
  });

  it("columns are named as layouts write them", () => {
    const { project: p } = loadProject(SCHEMA, { sheets: [{ name: "S", layouts: { Weapon: ["damage", "price.currency", "shots[1]"] }, rows: [["Weapon", "w1", 1, "gold", "a", "b"]] }] });
    const s = p.sheetId("S");
    const specs = columnSpecs(p.schema, p.schema.types.get("Weapon")!, sheetLayout(p.schema, p.doc.sheets.get(s)!, "Weapon"));
    expect([...specs.values()]).toEqual(["damage", "price.currency", "shots[1]"]);
  });
});

describe("formula text, moved and as R1C1", () => {
  it("relative references follow, absolute ones stay", () => {
    expect(moveFormula("=C2*2", 1, 0)).toBe("=C3*2");
    expect(moveFormula("=$C$2+C$2+$C2", 2, 3)).toBe("=$C$2+F$2+$C4");
    expect(moveFormula("=SUM(C:C)+SUM(2:2)", 3, 1)).toBe("=SUM(D:D)+SUM(5:5)");
    expect(moveFormula("='DLC Weapons'!B2&Tuning!A1", 1, 1)).toBe("='DLC Weapons'!C3&Tuning!B2");
    expect(moveFormula('=ENTITY("a").speed*(B2-1)%', 0, 1)).toBe('=ENTITY("a").speed*(C2-1)%');
    expect(moveFormula("=A1", -1, 0)).toBe("=#REF!");
    expect(moveFormula("=1+", 1, 1)).toBe("=1+");
    expect(moveFormula("text", 1, 1)).toBe("text");
  });

  it("R1C1 the way Sheets writes it", () => {
    expect(formulaR1C1("=C5/D5", 5, 6)).toBe("=R[0]C[-3]/R[0]C[-2]");
    expect(formulaR1C1("=SUM($A$1:C4)", 5, 4)).toBe("=SUM(R1C1:R[-1]C[-1])");
    expect(formulaR1C1("plain", 1, 1)).toBe(null);
  });
});

describe("pinning columns", () => {
  it("keeps each type's fields on their columns when a column goes in before them", () => {
    const s = Sapwood.load(SCHEMA, { sheets: [{ name: "S", rows: [["Weapon", "w1", 7, "x"]] }] });
    const p = s.project;
    const sheet = p.sheetId("S");
    const edit = p.pinColumns(sheet);
    expect(edit.ops.map((o) => o.kind)).toEqual(["setLayout"]);
    p.insert(sheet, "col", 3);
    expect(s.get("w1")).toMatchObject({ damage: 7 });
    // Without the pin, damage would have moved to the empty new column.
    const t = Sapwood.load(SCHEMA, { sheets: [{ name: "S", rows: [["Weapon", "w1", 7, "x"]] }] });
    t.project.insert(t.project.sheetId("S"), "col", 3);
    expect(t.get("w1").damage).toBeUndefined();
    expect(p.pinColumns(sheet).ops).toEqual([]); // already pinned
  });
});
