import { describe, expect, it } from "vitest";
import { loadProject } from "../project/load.ts";
import { checkOps } from "./check.ts";
import { OpError } from "./doc.ts";

const refused = (x: unknown, message: RegExp) => {
  expect(() => checkOps(x)).toThrow(OpError);
  expect(() => checkOps(x)).toThrow(message);
};

describe("checkOps", () => {
  it("takes the ops an edit makes, formulas included", () => {
    const { project: p } = loadProject("types:\n  Weapon: { fields: { damage: float, dps: float } }\n", { sheets: [{ name: "S", rows: [["Weapon", "w1", 2]] }] });
    const s = p.sheetId("S");
    const ops = [...p.set(s, "D1", '=C1*2+SUM(C:C)-ENTITY("w1").damage%').ops, ...p.setFormat(s, "C1", { bold: true, fill: "#f00" }).ops, ...p.insert(s, "row", 1, 2).ops];
    expect(checkOps(JSON.parse(JSON.stringify(ops)))).toEqual(ops);
  });

  it("refuses what isn't an op, saying where", () => {
    refused({}, /expected a list/);
    refused([{ kind: "nope" }], /ops\[0\]\.kind: not an op/);
    refused([{ kind: "setCell", sheet: "s1", row: "r1", content: null }], /ops\[0\]\.col: expected a non-empty string/);
    refused([{ kind: "insert", sheet: "s1", axis: "diagonal", after: null, ids: ["r9"] }], /axis: expected one of row, col/);
    refused([{ kind: "delete", sheet: "s1", axis: "row", ids: [] }], /ids: expected a non-empty list/);
    refused([{ kind: "setCell", sheet: "s1", row: "r1", col: "c1", content: { v: Infinity } }], /content\.v: expected text/);
    refused([{ kind: "setCell", sheet: "s1", row: "r1", col: "c1", content: { f: { k: "bin", op: "%%", l: { k: "num", v: 1 }, r: { k: "num", v: 2 } } } }], /content\.f\.op: expected an operator/);
    refused([{ kind: "setCell", sheet: "s1", row: "r1", col: "c1", content: { f: { k: "call", fn: "SUM", args: [{ k: "eval" }] } } }], /content\.f\.args\[0\]\.k: expected a formula node/);
    refused([{ kind: "setFormat", sheet: "s1", row: "r1", col: "c1", format: { fill: { evil: 1 } } }], /format\.fill: expected text/);
  });

  it("refuses formulas nested past any a person would write", () => {
    let f: unknown = { k: "num", v: 1 };
    for (let i = 0; i < 500; i++) f = { k: "neg", e: f };
    refused([{ kind: "setCell", sheet: "s1", row: "r1", col: "c1", content: { f } }], /nested too deeply/);
  });

  it("refuses schema ops: they come as YAML", () => {
    refused([{ kind: "setSchema", id: "t1", key: "name", value: "X" }], /changes the schema/);
  });

  it("copies only an op's own fields", () => {
    const [op] = checkOps([{ kind: "renameId", from: "a", to: "b", extra: { huge: true } }]);
    expect(op).toEqual({ kind: "renameId", from: "a", to: "b" });
  });
});
