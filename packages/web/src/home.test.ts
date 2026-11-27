import { describe, expect, it } from "vitest";
import { loadProject, Sapwood, validate, type Patch } from "@thek42/sapwood-core";
import { dropPatches, packTree, type PackNode } from "./home.ts";

describe("the pack tree", () => {
  it("nests packs, lists sheets, and counts issues per sheet and per pack", () => {
    const { project: p } = loadProject("types:\n  Weapon: { fields: { damage: float } }\n", {
      sheets: [
        { name: "Weapons", rows: [["Weapon", "w1", 1], ["Weapn", "w2", 2]] },
        { name: "Notes", kind: "scratch", rows: [["anything"]] },
      ],
    });
    const dlc = p.addPack("dlc");
    const dlc2 = p.addPack("dlc2", dlc);
    p.setRows(p.addSheet("More", dlc2), [["Weapon", "w3", "lots"]]);
    const issues = validate(p).issues;
    const t = packTree(p.doc, issues);

    expect(t.root.name).toBe("root");
    expect(t.root.sheets.map((s) => [s.name, s.kind, s.rows, s.errors])).toEqual([
      ["Weapons", "data", 2, 1], // Weapn
      ["Notes", "scratch", 1, 0],
    ]);
    const [d] = t.root.packs;
    expect(d).toMatchObject({ name: "dlc", sheets: [] });
    expect(d!.packs[0]!.sheets).toMatchObject([{ name: "More", rows: 1, errors: 1 }]); // "lots" isn't a float
    // A pack counts its sub-packs; every issue is counted once, on a sheet or the project's.
    expect(d!.errors).toBe(1);
    expect(t.root.errors).toBe(2);
    expect(t.root.errors + t.root.warnings + t.project.errors + t.project.warnings).toBe(issues.length);
  });
});

describe("dragging in the pack tree", () => {
  const make = () =>
    Sapwood.load("types:\n  T: { fields: {} }\n", {
      packs: [{ name: "dlc" }, { name: "season" }, { name: "inner", parent: "dlc" }],
      sheets: [{ name: "A", rows: [] }, { name: "B", rows: [] }, { name: "C", rows: [] }, { name: "D", pack: "dlc", rows: [] }],
    });
  const tree = (s: Sapwood) => packTree(s.project.doc, []).root;
  const find = (n: PackNode, name: string): PackNode => (n.name === name ? n : n.packs.map((q) => find(q, name)).find((x) => x !== undefined)!) ?? undefined!;
  const sheet = (s: Sapwood, name: string) => [...s.project.wb.sheets.values()].find((x) => x.name === name)!;
  /** Drop and apply; the sheets per pack and the packs per parent after. */
  const drop = (s: Sapwood, d: Parameters<typeof dropPatches>[1], at: Parameters<typeof dropPatches>[2]) => {
    const ps = dropPatches(tree(s), d, at);
    if (ps && ps.length) s.apply(ps as Patch[]);
    const show = (n: PackNode): string => `${n.name}[${n.sheets.map((x) => x.name).join(",")}${n.packs.length ? `|${n.packs.map(show).join(",")}` : ""}]`;
    return { ps, tree: show(tree(s)) };
  };
  const S = (s: Sapwood, name: string) => ({ kind: "sheet" as const, id: sheet(s, name).id, pack: sheet(s, name).pack });
  const P = (s: Sapwood, name: string) => ({ kind: "pack" as const, id: find(tree(s), name).id });

  it("reorders sheets, before or after another", () => {
    const s = make();
    expect(drop(s, S(s, "C"), { on: "sheet", id: sheet(s, "A").id, where: "before" }).tree).toBe("root[C,A,B|dlc[D|inner[]],season[]]");
    expect(drop(s, S(s, "C"), { on: "sheet", id: sheet(s, "B").id, where: "after" }).tree).toBe("root[A,B,C|dlc[D|inner[]],season[]]");
    // Where it already is: nothing.
    expect(drop(s, S(s, "B"), { on: "sheet", id: sheet(s, "A").id, where: "after" }).ps).toEqual([]);
    expect(drop(s, S(s, "B"), { on: "sheet", id: sheet(s, "B").id, where: "after" }).ps).toEqual([]);
  });

  it("moves a sheet into another pack, at a place or last, as one change", () => {
    const s = make();
    expect(drop(s, S(s, "A"), { on: "sheet", id: sheet(s, "D").id, where: "before" }).tree).toBe("root[B,C|dlc[A,D|inner[]],season[]]");
    s.undo();
    expect(tree(s).sheets.map((x) => x.name)).toEqual(["A", "B", "C"]);
    expect(drop(s, S(s, "B"), { on: "pack", id: find(tree(s), "season").id, where: "into" }).tree).toBe("root[A,C|dlc[D|inner[]],season[B]]");
    expect(dropPatches(tree(s), S(s, "A"), { on: "pack", id: find(tree(s), "dlc").id, where: "before" })).toBeNull();
  });

  it("reorders packs, moves one into another, never into itself", () => {
    const s = make();
    expect(drop(s, P(s, "season"), { on: "pack", id: find(tree(s), "dlc").id, where: "before" }).tree).toBe("root[A,B,C|season[],dlc[D|inner[]]]");
    expect(drop(s, P(s, "inner"), { on: "pack", id: find(tree(s), "season").id, where: "after" }).tree).toBe("root[A,B,C|season[],inner[],dlc[D]]");
    expect(drop(s, P(s, "season"), { on: "pack", id: find(tree(s), "dlc").id, where: "into" }).tree).toBe("root[A,B,C|inner[],dlc[D|season[]]]");
    expect(dropPatches(tree(s), P(s, "dlc"), { on: "pack", id: find(tree(s), "season").id, where: "into" })).toBeNull();
    expect(dropPatches(tree(s), P(s, "dlc"), { on: "pack", id: tree(s).id, where: "before" })).toBeNull();
    expect(dropPatches(tree(s), P(s, "dlc"), { on: "pack", id: find(tree(s), "dlc").id, where: "into" })).toEqual([]);
  });
});
