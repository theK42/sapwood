import { describe, expect, it } from "vitest";
import { Sapwood } from "../api/sapwood.ts";
import { cloneDoc } from "../ops/doc.ts";
import { diffProjects } from "./diff.ts";
import { Project } from "./project.ts";

const SCHEMA = `
types:
  Weapon: { fields: { damage: float, note: string } }
`;

const start = () =>
  Sapwood.load(SCHEMA, {
    sheets: [
      { name: "W", rows: [["# weapons"], ["Weapon", "a", 1], ["Weapon", "b", 2, "x"], ["Weapon", "c", 3], ["Weapon", "d", 4]] },
      { name: "Notes", kind: "scratch", rows: [["hello", 1]] },
    ],
  });

describe("a diff", () => {
  it("says what changed to entities, cells, rows, formats and sheets", () => {
    const s = start();
    const before = Project.fromDoc(cloneDoc(s.project.doc));
    const p = s.project;
    const w = p.sheetId("W");
    p.set(w, "C2", "10"); // a's damage
    p.set(w, "D3", ""); // b's note cleared
    p.set(w, "A4", "#Weapon"); // c commented out
    p.set(w, "B5", "dd"); // d renamed
    p.set(w, "A1", "# all the weapons"); // not an entity row
    p.insert(w, "row", 6);
    p.setRows(w, [["Weapon", "e", "5", "new"]], 6);
    p.move(w, "row", 2, 1, 5); // a moves down, below d
    p.setFormat(w, "C3", { bold: true });
    p.set(p.sheetId("Notes"), "B1", "2");
    p.addSheet("Extra");

    const d = diffProjects(before, p);
    expect(d.schema).toEqual([]);
    const W = d.sheets.find((x) => x.name === "W")!;
    expect(W.status).toBe("changed");
    // In order down the sheet as it is now: b, c, dd, a, e.
    expect(W.entities.map((e) => [e.id, e.change, e.renamedFrom ?? null, e.fields.map((f) => `${f.name}: ${f.before} -> ${f.after}`)])).toEqual([
      ["b", "changed", null, ["note: x -> "]],
      ["c", "commented out", null, []],
      ["dd", "changed", "d", []],
      ["a", "changed", null, ["damage: 1 -> 10"]],
      ["e", "added", null, ["damage:  -> 5", "note:  -> new"]],
    ]);
    expect(W.cells).toEqual([{ where: "A1", row: 0, col: 0, before: "# weapons", after: "# all the weapons" }]);
    expect(W.rows).toEqual({ added: 1, removed: 0, moved: 1 });
    expect(W.formats).toBe(1);
    expect(d.sheets.find((x) => x.name === "Notes")!.cells).toEqual([{ where: "B1", row: 0, col: 1, before: "1", after: "2" }]);
    expect(d.sheets.find((x) => x.name === "Extra")!.status).toBe("added");
    expect(diffProjects(p, p)).toEqual({ schema: [], sheets: [] });
  });

  it("says what changed in the schema, and an entity removed", () => {
    const s = start();
    const before = Project.fromDoc(cloneDoc(s.project.doc));
    const p = s.project;
    p.renameField("Weapon", "damage", "dmg");
    p.setField("Weapon", "dmg", { type: "int" });
    p.addField("Weapon", { name: "range", type: "float" });
    p.addDef("types", { name: "Shield", fields: [{ name: "hp", type: "int" }] });
    s.delete("a");
    const d = diffProjects(before, p);
    expect(d.schema).toEqual(expect.arrayContaining(["field Weapon.range added", "type Shield added", "field Shield.hp added", "field Weapon.damage renamed to dmg", "Weapon.dmg: type float → int"]));
    expect(d.sheets.find((x) => x.name === "W")!.entities.find((e) => e.id === "a")).toMatchObject({ change: "removed", row: null });
  });
});
