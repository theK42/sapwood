import { describe, expect, it } from "vitest";
import { loadProject } from "@thek42/sapwood-core";
import { idsAt, refList } from "./refs.ts";

const SCHEMA = `
types:
  Weapon: { fields: { damage: float, next: "ref<Weapon>", shots: "list<ref<Weapon>>" } }
  Config: { singleton: true, fields: { starter: "ref<Weapon>" } }
`;

const project = () =>
  loadProject(SCHEMA, {
    sheets: [
      { name: "W", rows: [["# id and fields"], ["Weapon", "a", 1, "b", '["a", "b"]'], ["Weapon", "b", '=ENTITY("a").damage+1'], ["Config.starter", "b"]] },
      { name: "S", layouts: { Weapon: ["shots[0]", "shots[1]"] }, rows: [["Weapon", "c", "a", "b"]] },
    ],
  }).project;

describe("ids in cells", () => {
  it("knows what a cell defines or names", () => {
    const p = project();
    const w = p.sheetId("W");
    expect(idsAt(p, w, 1, 1)).toEqual({ defines: "a", names: [] });
    expect(idsAt(p, w, 1, 3).names).toEqual(["b"]);
    expect(idsAt(p, w, 1, 4).names).toEqual(["a", "b"]);
    expect(idsAt(p, w, 2, 2).names).toEqual(["a"]); // a formula's ENTITY("a")
    expect(idsAt(p, w, 3, 1).names).toEqual(["b"]); // a singleton's field
    expect(idsAt(p, w, 0, 0)).toEqual({ defines: null, names: [] });
    const s = p.sheetId("S");
    expect(idsAt(p, s, 0, 2).names).toEqual(["a"]); // one element of a split list
    expect(idsAt(p, s, 0, 3).names).toEqual(["b"]);
  });

  it("lists the definition, then each use, by position", () => {
    const p = project();
    expect(refList(p, "b").map((x) => `${x.kind} ${x.sheetName}!${x.where} ${x.owner ?? ""} ${x.field ?? ""}`.trim())).toEqual([
      "definition W!B3 Weapon b",
      "field W!D2 Weapon a next",
      "field W!E2 Weapon a shots[1]",
      "field S!D1 Weapon c shots[1]",
      "field W!B4 Config starter",
    ]);
    expect(refList(p, "a").at(-1)).toMatchObject({ kind: "formula", where: "C3", owner: "Weapon b" });
  });
});
