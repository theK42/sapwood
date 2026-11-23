import { describe, expect, it } from "vitest";
import { loadProject, Sapwood } from "@thek42/sapwood-core";
import { TypeGrid } from "./typeview.ts";

const SCHEMA = `
types:
  Weapon: { fields: { damage: float, next: "ref<Weapon>", shots: "list<string>" } }
  Enemy: { fields: { hp: int } }
`;

const project = () =>
  loadProject(SCHEMA, {
    sheets: [
      { name: "Main", rows: [["Weapon", "a", 1, "b"], ["Enemy", "e", 5], ["# notes"], ["Weapon", "b", 2, "zz"]] },
      // Another order, and the list split over two columns.
      { name: "DLC", layouts: { Weapon: ["shots[0]", "shots[1]", "damage"] }, rows: [["#Weapon", "c", "x", "y", 3]] },
    ],
  }).project;

describe("a type view", () => {
  it("has every entity of the type, from every sheet, at its home cells", () => {
    const p = project();
    const t = new TypeGrid(p, "Weapon");
    expect(t.rows.map((r) => [r.sheetName, r.row, r.active])).toEqual([
      ["Main", 0, true],
      ["Main", 3, true],
      ["DLC", 0, false],
    ]);
    expect([0, 1, 2, 3, 4, 5, 6].map((c) => t.columnName(c))).toEqual(["Sheet", "id", "damage", "next", "shots", "shots[0]", "shots[1]"]);
    expect(t.cell(2, 0).text).toBe("DLC");
    expect(t.cell(2, 1).text).toBe("c");
    expect(t.cell(2, 2).text).toBe("3"); // damage is DLC's E column
    expect(t.address(2, 2)).toBe("DLC!E1");
    expect(t.cell(2, 6).text).toBe("y");
    expect(t.home(2, 4)).toBe(null); // DLC has no whole-list column
    expect(t.home(0, 5)).toBe(null); // nor Main a split one
    expect(t.cell(1, 3).issue).toMatchObject({ level: "error" }); // b's next is zz, which doesn't exist
    expect(t.rowLevel(1)).toBe("error");
    expect(t.counts).toEqual({ errors: 1, warnings: 0 });
    expect(() => new TypeGrid(p, "Nope")).toThrow();
  });

  it("writes edits to the home sheets, in one change", () => {
    const s = Sapwood.load(SCHEMA, {
      sheets: [
        { name: "Main", rows: [["Weapon", "a", 1]] },
        { name: "DLC", layouts: { Weapon: ["shots[0]", "shots[1]", "damage"] }, rows: [["Weapon", "c", "x", "y", 3]] },
      ],
    });
    const p = s.project;
    const { ops } = new TypeGrid(p, "Weapon").edit([
      { row: 0, col: 2, input: "10" },
      { row: 1, col: 2, input: "=LEN(C1)*7" }, // as typed on DLC: C1 is its x
      { row: 1, col: 4, input: "lost" }, // no home: skipped
    ]);
    expect(ops.map((o) => o.kind)).toEqual(["setCell", "setCell"]);
    expect(s.get("a").damage).toBe(10);
    expect(s.get("c").damage).toEqual({ $formula: "=LEN(C1)*7", $value: 7 });
    expect(new TypeGrid(p, "Weapon").cell(1, 2)).toMatchObject({ input: "=LEN(C1)*7", formula: true, text: "7" });
  });
});
