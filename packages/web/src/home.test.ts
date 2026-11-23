import { describe, expect, it } from "vitest";
import { loadProject, validate } from "@thek42/sapwood-core";
import { packTree } from "./home.ts";

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
