import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject } from "@thek42/sapwood-core";
import { SheetGrid, SPARE_ROWS } from "./grid.ts";

const fixture = (f: string) => readFileSync(new URL(`../../core/fixtures/krbsg/${f}`, import.meta.url), "utf8");
const krbsg = () => loadProject(fixture("schema.yaml"), fixture("project.yaml")).project;

describe("a sheet as the grid shows it", () => {
  it("cells, rows and the sticky header's names", () => {
    const p = krbsg();
    const g = new SheetGrid(p, p.sheetId("Weapons"));
    expect(g.name).toBe("Weapons");
    expect(g.rows).toBe(g.liveRows + SPARE_ROWS);
    // Row 1 is a comment naming the columns; row 2 the Blaster.
    expect(g.rowClass(0).kind).toBe("comment");
    expect(g.rowType(1)).toBe("Weapon");
    expect(g.cell(1, 1)).toMatchObject({ text: "Blaster", input: "Blaster", formula: false });
    expect(g.cell(1, 4)).toMatchObject({ text: "0.5", number: true });
    expect([0, 1, 2, 3, 4, 5].map((c) => g.columnName("Weapon", c))).toEqual(["type", "id", "projectiles", "script", "cooldown", "damage"]);
    expect(g.columnName("Projectile", 4)).toBe("collider");
    expect(g.columnName(null, 3)).toBe("");
    expect(g.cell(500, 3)).toMatchObject({ text: "", input: "" }); // past the end
  });

  it("formulas show their value, and the formula bar their text", () => {
    const p = krbsg();
    const g0 = new SheetGrid(p, p.sheetId("Weapons"));
    g0.edit([{ row: 1, col: 6, input: "=F2/E2" }]);
    const g = new SheetGrid(p, p.sheetId("Weapons"));
    expect(g.cell(1, 6)).toMatchObject({ text: "2", input: "=F2/E2", formula: true });
    g.edit([{ row: 1, col: 6, input: "=F2/3" }]);
    expect(new SheetGrid(p, p.sheetId("Weapons")).cell(1, 6).text).toBe("0.333333333333");
  });

  it("issues sit on their cells, the worst first", () => {
    const p = krbsg();
    const g0 = new SheetGrid(p, p.sheetId("Weapons"));
    g0.edit([{ row: 1, col: 2, input: '["NoSuchBolt"]' }, { row: 1, col: 4, input: "0.01" }]);
    const g = new SheetGrid(p, p.sheetId("Weapons"));
    expect(g.cell(1, 2).issue).toMatchObject({ level: "error" });
    expect(g.cell(1, 0).issue).toMatchObject({ level: "warning" }); // a rule's, on the row: shown on column A
    expect(g.errors).toBe(1);
    expect(g.warnings).toBe(1);
  });

  it("typing past the end makes the rows and columns first, in one go", () => {
    const p = krbsg();
    const s = p.sheetId("Weapons");
    const g = new SheetGrid(p, s);
    const rows = g.liveRows;
    const cols = g.liveCols;
    const { ops } = g.edit([{ row: rows + 2, col: cols + 1, input: "note" }]);
    expect(ops.map((o) => o.kind)).toEqual(["insert", "insert", "setCell"]);
    const after = new SheetGrid(p, s);
    expect(after.liveRows).toBe(rows + 3);
    expect(after.liveCols).toBe(cols + 2);
    expect(after.cell(rows + 2, cols + 1).text).toBe("note");
    // A bad edit takes back the rows it made.
    const before = JSON.stringify([...p.doc.sheets.get(s)!.rows.order]);
    expect(() => after.edit([{ row: rows + 10, col: 0, input: "x" }, { row: -1, col: 0, input: "y" }])).toThrow();
    expect(JSON.stringify([...p.doc.sheets.get(s)!.rows.order])).toBe(before);
  });

  it("formats merge key by key, and clear", () => {
    const p = krbsg();
    const s = p.sheetId("Weapons");
    const g = new SheetGrid(p, s);
    g.format({ row: 1, col: 2, rows: 1, cols: 2 }, { bold: true });
    g.format({ row: 1, col: 2, rows: 1, cols: 1 }, { fill: "#ffe08a" });
    let v = new SheetGrid(p, s);
    expect(v.cell(1, 2).format).toEqual({ bold: true, fill: "#ffe08a" });
    expect(v.cell(1, 3).format).toEqual({ bold: true });
    v.format({ row: 1, col: 2, rows: 1, cols: 1 }, { bold: false });
    v = new SheetGrid(p, s);
    expect(v.cell(1, 2).format).toEqual({ fill: "#ffe08a" });
    expect(v.format({ row: 1, col: 2, rows: 1, cols: 1 }, { fill: "#ffe08a" }).ops).toEqual([]); // no change, no op
    v.format({ row: 1, col: 2, rows: 1, cols: 2 }, null);
    expect(new SheetGrid(p, s).cell(1, 2).format).toBe(null);
  });
});
