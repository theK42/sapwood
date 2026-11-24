import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject, parseType, validate, type Issue } from "@thek42/sapwood-core";
import { copyPayload } from "./clipboard.ts";
import { SheetGrid } from "./grid.ts";
import { blank, cellText, inPanel, issuesByPath, ordered, summary, switchVariant } from "./panel.ts";

const fixture = (f: string) => readFileSync(new URL(`../../core/fixtures/krbsg/${f}`, import.meta.url), "utf8");
const krbsg = () => loadProject(fixture("schema.yaml"), fixture("project.yaml")).project;
const shapes = parseType("list<union<Shape>>");

describe("the panel's cells", () => {
  it("structs, unions, json and lists of them go to the panel; plain values and lists don't", () => {
    expect(["list<union<Shape>>", "struct<Vec2>", "json", "list<json>"].map((t) => inPanel(parseType(t)))).toEqual([true, true, true, true]);
    expect(["list<ref<Sprite>>", "float", "ref<Sprite>"].map((t) => inPanel(parseType(t)))).toEqual([false, false, false]);
  });

  it("such a cell shows its summary, the formula bar its JSON, and a copy carries the JSON", () => {
    const p = krbsg();
    const g = new SheetGrid(p, p.sheetId("CollisionShapes"));
    const c = g.cell(1, 2);
    expect(c.panel).toBe(true);
    expect(c.text).toBe("Box size (40, 20), offset (0, 10); Box size (40, 20), offset (0, 10), rotation …"); // 80 characters at most
    expect(c.input).toMatch(/^\[\{"kind":"Box"/);
    expect(g.fieldAt(1, 2)).toMatchObject({ label: "shapes" });
    expect(g.fieldAt(1, 1)).toBeNull(); // the ID
    expect(copyPayload(g, { row: 2, col: 2, rows: 1, cols: 1 }).text).toBe(g.cell(2, 2).input.replace(/"/g, '""').replace(/^|$/g, '"'));
    // JSON that doesn't read is shown as typed, so the problem shows.
    g.edit([{ row: 2, col: 2, input: "[{oops" }]);
    expect(new SheetGrid(p, p.sheetId("CollisionShapes")).cell(2, 2)).toMatchObject({ text: "[{oops", panel: true });
  });

  it("a singleton's struct field row is a panel cell too", () => {
    const schema = `structs:
  Cost: { fields: { gems: { type: int }, coins: { type: int } } }
types:
  Shop: { singleton: true, fields: { revive: { type: "struct<Cost>" }, name: { type: string } } }
`;
    const p = loadProject(schema, { sheets: [{ name: "Shop", rows: [["Shop"], [".revive", '{"gems": 5}'], [".name", "Bazaar"]] }] }).project;
    const g = new SheetGrid(p, p.sheetId("Shop"));
    expect(g.fieldAt(1, 1)).toMatchObject({ label: "revive" });
    expect(g.cell(1, 1)).toMatchObject({ text: "gems 5", panel: true });
    expect(g.cell(2, 1).panel).toBeUndefined();
  });
});

describe("summaries", () => {
  it("read briefly, and end in … when long", () => {
    const p = krbsg();
    expect(summary(p.schema, shapes, [{ kind: "Circle", radius: 3 }])).toBe("Circle radius 3");
    expect(summary(p.schema, shapes, [])).toBe("none");
    expect(summary(p.schema, parseType("union<Shape>"), { kind: "Box" })).toBe("Box");
    expect(summary(p.schema, parseType("json"), { a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(summary(p.schema, shapes, Array(20).fill({ kind: "Circle", radius: 1 })).endsWith("…")).toBe(true);
    // Not the shape it should be: its JSON.
    expect(summary(p.schema, shapes, { kind: "Box" })).toBe('{"kind":"Box"}');
  });
});

describe("issues by place", () => {
  const issue = (message: string): Issue => ({ level: "error", code: "x", message });
  it("each at the path after the field's label, the rest on the whole", () => {
    const m = issuesByPath([issue("shapes[0].radius: must be at least 0"), issue("shapes[1].size is required"), issue("shapes: needs at least 1 item"), issue("Not valid JSON: [{")], "shapes");
    expect([...m].map(([k, v]) => [k, v.map((i) => i.message)])).toEqual([
      ["[0].radius", ["must be at least 0"]],
      ["[1].size", ["is required"]],
      ["", ["needs at least 1 item", "Not valid JSON: [{"]],
    ]);
  });

  it("match what validation says about a cell", () => {
    const p = krbsg();
    const g = new SheetGrid(p, p.sheetId("CollisionShapes"));
    g.edit([{ row: 2, col: 2, input: '[{"kind":"Circle","radius":-1},{"kind":"Box","size":{"x":"a"}}]' }]);
    const on = validate(p).issues.filter((i) => i.at?.row === p.wb.sheet(g.sheet).rows.idAt(3));
    expect([...issuesByPath(on, "shapes")].map(([k, v]) => [k, v.map((i) => i.message)])).toEqual([["[1].size.x", ["Expected a number, got \"a\""]]]);
    g.edit([{ row: 2, col: 2, input: '[{"kind":"Circle","radius":-1}]' }]);
    const again = validate(p).issues.filter((i) => i.at?.row === p.wb.sheet(g.sheet).rows.idAt(3));
    expect([...issuesByPath(again, "shapes")].map(([k, v]) => [k, v.map((i) => i.message)])).toEqual([["[0].radius", ["must be at least 0"]]]);
  });
});

describe("editing values", () => {
  it("a new item starts blank, a variant first", () => {
    const p = krbsg();
    expect(blank(p.schema, parseType("union<Shape>"))).toEqual({ kind: "Box" });
    expect(blank(p.schema, parseType("struct<Vec2>"))).toEqual({});
    expect(blank(p.schema, parseType("float"))).toBe(0);
  });

  it("switching a variant keeps the fields of the same name", () => {
    const p = krbsg();
    expect(switchVariant(p.schema, "Shape", { kind: "Box", size: { x: 1 }, offset: { x: 2 } }, "Circle")).toEqual({ kind: "Circle", offset: { x: 2 } });
  });

  it("the cell gets JSON in schema order, the discriminator first; nothing at all clears it", () => {
    const p = krbsg();
    expect(cellText(p.schema, shapes, [{ offset: { y: 1, x: 2 }, size: { x: 3 }, kind: "Box", extra: 1 }])).toBe('[{"kind":"Box","size":{"x":3},"offset":{"x":2,"y":1},"extra":1}]');
    expect(cellText(p.schema, shapes, undefined)).toBe("");
    expect(ordered(p.schema, parseType("json"), { b: 1, a: 2 })).toEqual({ b: 1, a: 2 });
  });
});
