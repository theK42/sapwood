import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject } from "@thek42/sapwood-core";
import { seriesIn, SheetGrid, SPARE_ROWS } from "./grid.ts";

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

  it("inserts, deletes and moves rows, and columns without moving fields off their data", () => {
    const p = krbsg();
    const s = p.sheetId("Weapons");
    const at = () => new SheetGrid(p, s);
    expect(at().insert("row", 1, 2).ops.map((o) => o.kind)).toEqual(["insert"]);
    expect(at().cell(3, 1).input).toBe("Blaster");
    expect(at().remove("row", 1, 2).ops.map((o) => o.kind)).toEqual(["delete"]);
    expect(at().cell(1, 1).input).toBe("Blaster");
    // A column before the fields: they're pinned to their columns first, so cooldown stays 0.5.
    const before = (p as unknown as { doc: { sheets: Map<string, { layouts: Map<string, unknown> }> } }).doc.sheets.get(s)!.layouts.size;
    expect(before).toBe(0);
    expect(at().insert("col", 2, 1).ops.map((o) => o.kind)).toEqual(["setLayout", "insert"]);
    expect(at().columnName("Weapon", 2)).toBe("");
    expect(at().columnName("Weapon", 3)).toBe("projectiles");
    expect(at().cell(1, 5).text).toBe("0.5");
    // Not before A or B, and A and B don't move or go.
    expect(at().insert("col", 1, 1).ops).toEqual([]);
    expect(at().remove("col", 0, 1).ops).toEqual([]);
    expect(at().move("col", 1, 1, 4).ops).toEqual([]);
    expect(at().move("col", 4, 1, 1).ops).toEqual([]);
    // Moving cooldown's column to the end keeps it cooldown.
    at().remove("col", 2, 1);
    const cols = at().liveCols;
    at().move("col", 4, 1, cols - 1);
    expect(at().columnName("Weapon", cols - 1)).toBe("cooldown");
    expect(at().cell(1, cols - 1).text).toBe("0.5");
    // A row dragged down, then back up.
    at().edit([{ row: 2, col: 0, input: "# note" }]);
    at().move("row", 1, 1, 2);
    expect(at().cell(2, 1).input).toBe("Blaster");
    at().move("row", 2, 1, 1);
    expect(at().cell(1, 1).input).toBe("Blaster");
  });

  it("moves a selection of rows or columns, side by side or not, to a landing line", () => {
    const p = krbsg();
    const s = p.sheetId("Weapons");
    const at = () => new SheetGrid(p, s);
    at().edit([2, 3, 4, 5].flatMap((row) => [{ row, col: 0, input: "Weapon" }, { row, col: 1, input: `w${row}` }]));
    const start = Array.from({ length: 4 }, (_, r) => at().cell(r + 1, 1).input);
    // Rows 1 and 3 (not side by side) land before row 5: they come together there, in order.
    const moved = at().moveTo("row", [3, 1], 5);
    expect(moved.at).toBe(3);
    expect(at().cell(3, 1).input).toBe(start[0]);
    expect(at().cell(4, 1).input).toBe(start[2]);
    expect(at().cell(1, 1).input).toBe(start[1]);
    expect(at().cell(2, 1).input).toBe(start[3]);
    // Landing where they already are moves nothing.
    expect(at().moveTo("row", [3, 4], 3)).toEqual({ ops: [], at: null });
    expect(at().moveTo("row", [3, 4], 5)).toEqual({ ops: [], at: null });
    // A and B don't move, and nothing lands before them: they're dropped from the set.
    expect(at().movable("col", [0, 1, 4, 3])).toEqual([3, 4]);
    expect(at().moveTo("col", [0, 1], 6).ops).toEqual([]);
    expect(at().moveTo("col", [4], 1).ops).toEqual([]);
    // Columns keep their fields: cooldown's and range's columns go to the end.
    const names = Array.from({ length: at().liveCols }, (_, c) => at().columnName("Weapon", c));
    const end = at().liveCols;
    const r = at().moveTo("col", [0, 3, 4], end);
    expect(r.ops.map((o) => o.kind)).toEqual(["setLayout", "move"]);
    expect(r.at).toBe(end - 2);
    expect(at().columnName("Weapon", end - 2)).toBe(names[3]);
    expect(at().columnName("Weapon", end - 1)).toBe(names[4]);
    expect(at().columnName("Weapon", 3)).toBe(names[5]);
    // Nothing moving leaves no pins behind.
    expect(at().moveTo("col", [end - 1], end).ops).toEqual([]);
    // Out past the end, among the blank rows: the rows up to there are made, and it lands where the line was.
    const rows = at().liveRows;
    const last = at().cell(rows - 1, 1).input;
    const far = at().moveTo("row", [1], rows + 3);
    expect(far.ops.map((o) => o.kind)).toEqual(["insert", "move"]);
    expect(far.at).toBe(rows + 2);
    expect(at().liveRows).toBe(rows + 3);
    expect(at().cell(rows + 2, 1).input).toBe(start[1]);
    expect(at().cell(rows - 2, 1).input).toBe(last);
    expect(at().cell(rows + 1, 1).input).toBe("");
    // And a column, out past the last one: it keeps its field.
    const cols = at().liveCols;
    const name = at().columnName("Weapon", 3);
    expect(at().moveTo("col", [3], cols + 2).at).toBe(cols + 1);
    expect(at().columnName("Weapon", cols + 1)).toBe(name);
    // Not past what the grid shows.
    expect(at().moveTo("row", [1], at().rows + 1).ops).toEqual([]);
  });

  it("reads a plain list typed in a list cell as the JSON it holds", () => {
    const p = krbsg();
    const s = p.sheetId("Weapons");
    new SheetGrid(p, s).edit([{ row: 1, col: 2, input: "BlasterBolt" }]);
    expect(new SheetGrid(p, s).cell(1, 2).input).toBe('["BlasterBolt"]');
    expect(new SheetGrid(p, s).cell(1, 2).issue).toBe(null);
    new SheetGrid(p, s).edit([{ row: 1, col: 2, input: " BlasterBolt , PlasmaBolt " }]);
    expect(new SheetGrid(p, s).cell(1, 2).input).toBe('["BlasterBolt","PlasmaBolt"]');
    // JSON, formulas and blanks as typed; and other fields, and rows that aren't entities.
    for (const input of ['["a"]', "=LIST()", ""]) expect(new SheetGrid(p, s).typed(1, 2, input)).toBe(input);
    expect(new SheetGrid(p, s).typed(1, 3, "a, b")).toBe("a, b");
    expect(new SheetGrid(p, s).typed(0, 2, "a, b")).toBe("a, b");
  });

  it("fill repeats the source, moving formulas, and brings formats", () => {
    const p = krbsg();
    const s = p.sheetId("Weapons");
    const g = new SheetGrid(p, s);
    g.edit([{ row: 1, col: 6, input: "=F2/E2", format: { bold: true } }]);
    new SheetGrid(p, s).fill({ row: 1, col: 6, rows: 1, cols: 1 }, { row: 1, col: 6, rows: 4, cols: 2 });
    const v = new SheetGrid(p, s);
    expect(v.cell(2, 6).input).toBe("=F3/E3");
    expect(v.cell(4, 7).input).toBe("=G5/F5");
    expect(v.cell(4, 7).format).toEqual({ bold: true });
    expect(v.cell(1, 6).text).toBe("2");
  });

  it("fill carries on a series of two or more, and never from one cell", () => {
    const at = (xs: string[], n: number) => Array.from({ length: n }, (_, i) => seriesIn(xs)?.at(i) ?? null);
    expect(at(["1", "2"], 5)).toEqual(["1", "2", "3", "4", "5"]);
    expect(at(["10", "7.5"], 4)).toEqual(["10", "7.5", "5", "2.5"]);
    expect(at(["0.1", "0.2"], 3)).toEqual(["0.1", "0.2", "0.3"]);
    expect(at(["Wave 1", "Wave 2"], 4)).toEqual(["Wave 1", "Wave 2", "Wave 3", "Wave 4"]);
    expect(at(["lvl08", "lvl09"], 3)).toEqual(["lvl08", "lvl09", "lvl10"]);
    expect(at(["star1.png", "star2.png"], 3)).toEqual(["star1.png", "star2.png", "star3.png"]);
    expect(at(["v2.1-final", "v2.3-final"], 3)).toEqual(["v2.1-final", "v2.3-final", "v2.5-final"]); // the last number counts
    expect(seriesIn(["star1.png", "star2.jpg"])).toBe(null);
    expect(seriesIn(["star1.png"])).toBe(null);
    expect(seriesIn(["5"])).toBe(null); // one cell: repeat it
    expect(seriesIn(["Wave 1"])).toBe(null);
    expect(seriesIn(["1", "2", "4"])).toBe(null); // uneven: repeat
    expect(seriesIn(["Wave 1", "Boss 2"])).toBe(null);
    expect(seriesIn(["=A1", "=A2"])).toBe(null); // formulas move instead
    expect(seriesIn(["1", ""])).toBe(null);
    expect(seriesIn(["a", "b"])).toBe(null);
    expect(seriesIn(["'1", "'2"])).toBe(null); // typed as text
  });

  it("fill down, up and across continues each line's series, or repeats it", () => {
    const { project: p } = loadProject("types:\n  T: { fields: { n: float } }\n", { sheets: [{ name: "S", kind: "scratch", rows: [] }] });
    const s = p.sheetId("S");
    new SheetGrid(p, s).edit([
      { row: 2, col: 0, input: "1" }, { row: 3, col: 0, input: "2" },
      { row: 2, col: 1, input: "x" }, { row: 3, col: 1, input: "y" },
      { row: 2, col: 2, input: "7" }, { row: 3, col: 2, input: "=C3*2" },
    ]);
    new SheetGrid(p, s).fill({ row: 2, col: 0, rows: 2, cols: 3 }, { row: 0, col: 0, rows: 7, cols: 3 });
    const g = new SheetGrid(p, s);
    expect([0, 1, 2, 3, 4, 5, 6].map((r) => g.cell(r, 0).input)).toEqual(["-1", "0", "1", "2", "3", "4", "5"]);
    expect([0, 1, 4, 5, 6].map((r) => g.cell(r, 1).input)).toEqual(["x", "y", "x", "y", "x"]);
    expect([4, 5].map((r) => g.cell(r, 2).input)).toEqual(["7", "=C5*2"]);
    // Across: a row's series.
    new SheetGrid(p, s).edit([{ row: 8, col: 0, input: "Wave 1" }, { row: 8, col: 1, input: "Wave 2" }]);
    new SheetGrid(p, s).fill({ row: 8, col: 0, rows: 1, cols: 2 }, { row: 8, col: 0, rows: 1, cols: 4 });
    expect([0, 1, 2, 3].map((c) => new SheetGrid(p, s).cell(8, c).input)).toEqual(["Wave 1", "Wave 2", "Wave 3", "Wave 4"]);
  });
});

describe("a field's columns, from the grid", () => {
  it("what a column's field is, how it sits, and what it may become", () => {
    const schema = `structs:
  Cost: { fields: { currency: string, amount: int } }
types:
  Item: { fields: { price: "struct<Cost>", tags: "list<string>", n: int } }
`;
    const p = loadProject(schema, { sheets: [{ name: "Items", rows: [["Item", "sword", '{"amount":3}', '["a","b"]', 1]] }] }).project;
    const g = new SheetGrid(p, p.sheetId("Items"));
    expect(g.fieldColumnsAt("Item", 2)).toMatchObject({ field: "price", form: { kind: "whole" }, split: true, spread: false });
    expect(g.fieldColumnsAt("Item", 3)).toMatchObject({ field: "tags", split: false, spread: true, longest: 2 });
    expect(g.fieldColumnsAt("Item", 1)).toBeNull();
    g.setColumns("Item", "tags", { kind: "spread", columns: 2 }); // applied as it goes, as edits are
    const g2 = new SheetGrid(p, p.sheetId("Items"));
    expect(g2.fieldColumnsAt("Item", 4)).toMatchObject({ field: "tags", form: { kind: "spread", columns: 2 } });
    expect(g2.cell(0, 3).text).toBe("a");
  });
});
