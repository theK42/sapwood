import { describe, expect, it } from "vitest";
import { loadProject } from "@thek42/sapwood-core";
import { SheetGrid } from "./grid.ts";
import { issueList } from "./issues.ts";

const SCHEMA = `
types:
  Weapon: { fields: { damage: float, next: "ref<Weapon>" } }
  Config: { singleton: true, fields: { lives: { type: int, required: true } } }
`;

describe("the issues panel's list", () => {
  it("says where each issue is, in sheet order then down the sheet, with its entity", () => {
    const { project: p } = loadProject(SCHEMA, {
      sheets: [
        { name: "B", rows: [["Weapon", "w2", "lots"], ["Weapon", "w3", 1, "nowhere"]] },
        { name: "A", rows: [["Weapon", "w1", 1], ["Nonsense", "x"]] },
      ],
    });
    const list = issueList(p);
    expect(list.map((x) => [x.sheet?.name ?? null, x.where, x.issue.level])).toEqual([
      [null, "", "error"], // the singleton's required field, on no sheet
      ["B", "C1", "error"],
      ["B", "D2", "error"],
      ["A", "A2", "error"],
    ]);
    expect(list[1]).toMatchObject({ row: 0, col: 2, entity: "Weapon w2" });
    expect(list[3]!.entity).toBe(null); // not an entity's row
  });

  it("follows rows as they move, and a row's own issue is the row", () => {
    const { project: p } = loadProject(SCHEMA, { sheets: [{ name: "S", rows: [["Weapon", "w1", 1], ["Weapon", "w1", 2]] }] });
    const s = p.sheetId("S");
    const dup = issueList(p).filter((x) => x.sheet);
    expect(dup.length).toBeGreaterThan(0);
    new SheetGrid(p, s).insert("row", 0, 2);
    const after = issueList(p).filter((x) => x.sheet);
    expect(after.map((x) => x.row)).toEqual(dup.map((x) => x.row! + 2));
    // On the grid: the row's issue shows on column A, and its number is marked.
    const g = new SheetGrid(p, s);
    const cells = g.issueCells();
    expect(cells.every((c) => c.row >= 2)).toBe(true);
    expect(g.rowLevel(0)).toBe(null);
    expect(g.rowLevel(cells[0]!.row)).toBe("error");
  });
});
