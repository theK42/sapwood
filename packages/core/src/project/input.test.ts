import { describe, expect, it } from "vitest";
import { contentKey } from "../formula/content.ts";
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
