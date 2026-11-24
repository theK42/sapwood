import { describe, expect, it } from "vitest";
import { canonDoc, cloneDoc } from "../ops/doc.ts";
import { Sapwood } from "./sapwood.ts";

const SCHEMA = `
structs:
  Cost: { fields: { amount: int, currency: string } }
types:
  Weapon:
    fields:
      damage: float
      price: "struct<Cost>"
      shots: "list<ref<Ammo>>"
  Ammo: { fields: { speed: float } }
`;
// root: Weapons and Ammo; dlc and other are its children.
const project = () =>
  Sapwood.load(SCHEMA, {
    packs: [{ name: "dlc" }, { name: "other" }],
    sheets: [
      { name: "Weapons", rows: [["Weapon", "w1", 10, "", '["a1"]', "", "a note"], ["Weapon", "w2", "=C1*2"], ["#Weapon", "w0", 1]] },
      { name: "Ammo", rows: [["Ammo", "a1", 900], ["Ammo", "a2", 600]] },
      { name: "Calc", kind: "scratch", rows: [["=Weapons!C1+1"]] },
      { name: "Dlc", pack: "dlc", rows: [["Weapon", "w9", 7, "", '["a2"]'], ["Weapon", "w8", "=C1*3"]] },
    ],
  });
const value = (s: Sapwood, sheet: string, a1: string, pack = "root") => s.project.engine.get(s.project.sheetId(sheet, [...s.project.wb.packs.values()].find((p) => p.name === pack)!.id), a1);

describe("moving entities to another pack (DESIGN §7.4)", () => {
  it("moves down, with formulas following and what breaks reported", () => {
    const s = project();
    const before = canonDoc(cloneDoc(s.doc));
    const { report } = s.moveEntities(["w1"], "dlc");
    // After the last Weapon on dlc's only sheet with one.
    expect(report.moved).toEqual([{ id: "w1", sheet: "Dlc", pack: "dlc" }]);
    expect(s.get("w1")).toMatchObject({ $pack: "dlc", $sheet: "Dlc", damage: 10, shots: ["a1"] });
    expect(s.query("Weapon", { pack: "dlc" }).map((e) => e.$id)).toEqual(["w9", "w8", "w1"]);
    // w1's ref to a1 (root) still reaches; nothing refers to w1.
    expect(report.needs).toEqual([]);
    expect(report.breaks).toEqual([]);
    // w2 and Calc read w1's damage: pointed at the new cell, but root can't read dlc.
    expect(report.formulas.map((f) => `${f.cell.sheet}!${f.cell.cell}`).sort()).toEqual(["Calc!A1", "Weapons!C1"]);
    expect(report.formulas[0]!.why).toMatch(/#REACH!/);
    expect(s.get("w2").damage).toMatchObject({ $formula: "='dlc/Dlc'!C3*2" }); // named with its pack: root can't reach it
    expect(report.lost).toEqual([{ sheet: "Weapons", cell: "G1" }]); // the note
    expect(report.issues.length).toBeGreaterThan(0);
    s.undo();
    expect(canonDoc(s.doc)).toEqual(before);
  });

  it("moves up, keeping formulas working", () => {
    const s = project();
    s.moveEntities(["w9"], "root");
    expect(s.get("w9")).toMatchObject({ $pack: "root", $sheet: "Weapons", damage: 7 });
    // After the last Weapon on Weapons, commented out or not.
    expect(s.query("Weapon", { inactive: true, pack: "root" }).map((e) => e.$id)).toEqual(["w1", "w2", "w0", "w9"]);
    expect(s.get("w8").damage).toEqual({ $value: 21, $formula: "=Weapons!C4*3" });
    expect(s.validate().errors).toBe(0);
  });

  it("several at once, formulas between them following both", () => {
    const s = project();
    const { report } = s.moveEntities(["w9", "w8"], "root");
    expect(report.moved.map((m) => m.id)).toEqual(["w9", "w8"]);
    expect(s.get("w8").damage).toEqual({ $value: 21, $formula: "=C4*3" }); // on the same sheet now
    expect(report.formulas).toEqual([]);
    expect(s.project.wb.sheet(s.project.sheetId("Dlc", [...s.project.wb.packs.values()].find((p) => p.name === "dlc")!.id)).rows.length).toBe(0);
  });

  it("refs out of reach, both ways, and a commented-out entity", () => {
    const s = project();
    const p = s.previewMove(["a1"], "other");
    expect(p.breaks).toEqual([{ from: "w1", field: "shots", to: "a1" }]);
    expect(p.moved).toEqual([{ id: "a1", sheet: "Ammo", pack: "other" }]); // the type-named sheet, made for it
    expect(p.issues.map((i) => i.code)).toContain("ref.reach");
    expect(s.get("a1").$pack).toBe("root"); // only a preview
    const q = s.previewMove(["w9"], "other");
    expect(q.needs).toEqual([]); // a2 is in root
    const r = s.previewMove(["w1"], "other");
    expect(r.needs).toEqual([]);
    s.moveEntities(["w0"], "dlc");
    expect(s.query("Weapon", { inactive: true, pack: "dlc" }).find((e) => e.$id === "w0")).toMatchObject({ $active: false, damage: 1 });
    expect(value(s, "Dlc", "B3", "dlc")).toBe("w0");
  });

  it("needs: what the moved entities refer to that won't reach", () => {
    const s = project();
    s.moveEntities(["a2"], "dlc"); // now only dlc's w9 refers to it
    const p = s.previewMove(["w1"], "dlc");
    expect(p.needs).toEqual([]);
    s.set("w1", { shots: ["a1", "a2"] }); // root's w1 can't reach a2 now
    const q = s.previewMove(["w1"], "other");
    expect(q.needs).toEqual([{ from: "w1", field: "shots", to: "a2" }]); // a2 in dlc: moving it along mends it
    const t = s.previewMove(["w9"], "other");
    expect(t.needs).toEqual([{ from: "w9", field: "shots", to: "a2" }]);
  });
});

describe("a sheet removed by an undo, with entities on it", () => {
  // Found trying moves in the browser: the engine kept the removed sheet's rows in its index
  // of rows by type, and the next rebuild looked the sheet up.
  it("after a move that made a sheet, undone by its inverse", () => {
    const s = project();
    s.project.wb.idSalt = "4_";
    const c = new Sapwood(s.project).moveEntities(["w1", "w2", "a1"], "other"); // onto new Weapon and Ammo sheets there
    s.project.apply(c.inverse);
    expect(new Sapwood(s.project).previewMove(["w1", "w2", "a1"], "other").moved.map((m) => m.sheet)).toEqual(["Weapon", "Weapon", "Ammo"]);
    expect(s.get("a1").$pack).toBe("root");
  });

  it("after an entity made on a new sheet, undone by its inverse", () => {
    const s = project();
    const c = s.create("Ammo", { $id: "a9" }, { pack: "other" });
    s.project.apply(c.inverse);
    s.create("Ammo", { $id: "a8" }, { pack: "other" });
    expect(s.query("Ammo", { pack: "other" }).map((e) => e.$id)).toEqual(["a8"]);
  });
});
