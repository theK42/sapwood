import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject } from "../project/load.ts";
import { exportJson } from "../export/json.ts";
import { validate } from "../project/validate.ts";
import { cloneDoc, docsEqual, liveIds } from "./doc.ts";
import { applyOp, OpError, type Op } from "./ops.ts";
import { Project } from "../project/project.ts";

const fixture = (f: string) => readFileSync(new URL(`../../fixtures/krbsg/${f}`, import.meta.url), "utf8");
const KRBSG_SCHEMA = fixture("schema.yaml");
const KRBSG = fixture("project.yaml");
const krbsg = () => loadProject(KRBSG_SCHEMA, KRBSG).project;
const root = (p: Project) => JSON.parse(exportJson(p, { allowInvalid: true }).find((f) => f.path === "root.json")!.content);
const text = (p: Project, sheet: string, a1: string) => {
  const v = p.engine.get(p.sheetId(sheet), a1);
  return v === null ? "" : String(v);
};

/** Apply an edit's inverse and check the document and the engine are as they were. */
function expectUndoes(p: Project, edit: { inverse: Op[] }, before: ReturnType<typeof cloneDoc>, exportBefore: unknown) {
  p.apply(edit.inverse);
  expect(docsEqual(p.doc, before)).toBe(true);
  expect(root(p)).toEqual(exportBefore);
}

describe("edits are ops, and every op has an exact inverse", () => {
  it("setting a cell, including past the end of the sheet", () => {
    const p = krbsg();
    const before = cloneDoc(p.doc);
    const exp = root(p);
    const s = p.sheetId("Weapons");
    const e = p.set(s, "H20", "far away");
    // Rows 3–20 and columns G–H were created first, as inserts.
    expect(e.ops.map((o) => o.kind)).toEqual(["insert", "insert", "setCell"]);
    expect(text(p, "Weapons", "H20")).toBe("far away");
    expectUndoes(p, e, before, exp);
    expect(p.wb.sheet(s).rows.length).toBe(2);
  });

  it("a formula is stored against stable IDs, so moving rows doesn't touch it", () => {
    const p = krbsg();
    const s = p.sheetId("Sprites");
    p.set(s, "G2", "=E2*2");
    const content = p.doc.sheets.get(s)!.cells;
    const stored = JSON.stringify([...content].filter(([, c]) => c && "f" in c));
    p.move(s, "row", 2, 1, 10);
    expect(JSON.stringify([...content].filter(([, c]) => c && "f" in c))).toBe(stored);
    expect(p.engine.formula(s, "G10")).toBe("=E10*2");
    expect(text(p, "Sprites", "G10")).toBe("80");
  });

  it("insert, delete and move rows and columns", () => {
    const p = krbsg();
    const s = p.sheetId("Sprites");
    const before = cloneDoc(p.doc);
    const exp = root(p);
    const edits = [
      p.insert(s, "row", 3, 2),
      p.set(s, "A3", "Sprite"),
      p.set(s, "B3", "spr_new"),
      p.remove(s, "row", 5),
      p.move(s, "row", 2, 2, 8),
      p.insert(s, "col", 4),
      p.move(s, "col", 4, 1, 6),
      p.remove(s, "col", 3),
    ];
    for (const e of edits.reverse()) p.apply(e.inverse);
    expect(docsEqual(p.doc, before)).toBe(true);
    expect(root(p)).toEqual(exp);
  });

  it("deleted rows stay as tombstones: formulas show #REF!, and restoring brings them back", () => {
    const p = krbsg();
    const s = p.sheetId("Sprites");
    p.set(s, "G2", "=E3+1");
    const del = p.remove(s, "row", 3);
    expect(text(p, "Sprites", "G2")).toBe("#REF!");
    expect(p.engine.formula(s, "G2")).toBe("=#REF!+1");
    p.apply(del.inverse);
    expect(text(p, "Sprites", "G2")).toBe("41");
  });

  it("columns A and B of a data sheet can't be moved or deleted, and nothing goes before them", () => {
    const p = krbsg();
    const s = p.sheetId("Sprites");
    expect(() => p.remove(s, "col", 1)).toThrow(/can't be deleted/);
    expect(() => p.move(s, "col", 2, 1, 5)).toThrow(/can't be moved/);
    expect(() => p.insert(s, "col", 2)).toThrow(/nothing goes before them/);
    expect(() => p.move(s, "col", 4, 1, 1)).toThrow(/nothing goes before them/);
    const scratch = p.addSheet("Notes", p.wb.root, "scratch");
    p.set(scratch, "B2", "x");
    p.insert(scratch, "col", 1); // fine on a scratch sheet
    expect(text(p, "Notes", "C2")).toBe("x");
  });

  it("a failing op leaves everything as it was", () => {
    const p = krbsg();
    const s = p.sheetId("Sprites");
    const before = cloneDoc(p.doc);
    const [r2, r3] = p.wb.sheet(s).rows.liveIds();
    const col = p.wb.sheet(s).cols.liveIds()[4]!;
    expect(() =>
      p.apply([
        { kind: "setCell", sheet: s, row: r2!, col, content: { v: 99 } },
        { kind: "delete", sheet: s, axis: "row", ids: [r3!] },
        { kind: "delete", sheet: s, axis: "row", ids: [r3!] }, // already deleted
      ]),
    ).toThrow(OpError);
    expect(docsEqual(p.doc, before)).toBe(true);
    expect(text(p, "Sprites", "E2")).toBe("40");
  });

  it("purging rows needs them empty", () => {
    const p = krbsg();
    const s = p.sheetId("Sprites");
    const row = p.wb.sheet(s).rows.liveIds()[1]!;
    expect(() => p.apply([{ kind: "purge", sheet: s, axis: "row", ids: [row] }])).toThrow(/not empty/);
  });

  it("formats are per cell, never validated, and undo exactly", () => {
    const p = krbsg();
    const s = p.sheetId("Sprites");
    const before = cloneDoc(p.doc);
    const a = p.setFormat(s, "C2", { bold: true });
    const b = p.setFormat(s, "C2", { bold: true, fill: "#ffeeaa" });
    const [row, , col] = [p.wb.sheet(s).rows.idAt(2), 0, p.wb.sheet(s).cols.idAt(3)];
    expect(p.format(s, row, col)).toEqual({ bold: true, fill: "#ffeeaa" });
    p.apply(b.inverse);
    expect(p.format(s, row, col)).toEqual({ bold: true });
    p.apply(a.inverse);
    expect(docsEqual(p.doc, before)).toBe(true);
  });

  it("sheets and packs: create, rename, move, and undo", () => {
    const p = krbsg();
    const before = cloneDoc(p.doc);
    const ops: Op[] = [
      { kind: "createPack", pack: "pk1", name: "event", parent: "root" },
      { kind: "createSheet", sheet: "sx", name: "Halloween", pack: "pk1", sheetKind: "data" },
      { kind: "renameSheet", sheet: p.sheetId("Weapons"), name: "Guns" },
      { kind: "renamePack", pack: "pk1", name: "spooky" },
      { kind: "setSheetPack", sheet: "sx", pack: "root" },
    ];
    const inv = p.apply(ops);
    expect(p.wb.findSheet("root", "Guns")).toBeDefined();
    expect(p.wb.packs.get("pk1")!.name).toBe("spooky");
    expect(() => p.apply([{ kind: "createSheet", sheet: "sy", name: "guns", pack: "root", sheetKind: "data" }])).toThrow(/already a sheet/);
    expect(() => p.apply([{ kind: "removePack", pack: "root" }])).toThrow(/root/);
    p.apply(inv);
    expect(docsEqual(p.doc, before)).toBe(true);
  });

  it("qualified sheet references use the pack's name, and survive renaming it", () => {
    const p = krbsg();
    p.apply([{ kind: "createPack", pack: "pk1", name: "event", parent: "root" }]);
    const ev = p.addSheet("Tuning", "pk1");
    p.set(ev, "C1", "7");
    const local = p.addSheet("Calc", "pk1", "scratch");
    p.set(local, "A1", "='event/Tuning'!C1*2");
    expect(p.engine.get(local, "A1")).toBe(14);
    p.apply([{ kind: "renamePack", pack: "pk1", name: "spooky" }]);
    expect(p.engine.get(local, "A1")).toBe(14);
  });

  it("layouts are ops", () => {
    const p = krbsg();
    const s = p.sheetId("Weapons");
    const before = cloneDoc(p.doc);
    const e = p.setLayout(s, "Weapon", ["projectiles", "script", "damage", "cooldown"]);
    expect(root(p).types.Weapon.Blaster).toMatchObject({ damage: 0.5, cooldown: 1 });
    p.apply(e.inverse);
    expect(docsEqual(p.doc, before)).toBe(true);
  });
});

describe("renameId (§8.2)", () => {
  it("rewrites column B and every ref, inside JSON lists too, keeping the text as written", () => {
    const p = krbsg();
    const weapons = p.sheetId("Weapons");
    p.set(weapons, "C2", '[ "BlasterBolt",  "BlasterBolt" ]');
    p.set(p.sheetId("Projectiles"), "D2", "BlasterBolt"); // a script name that happens to match: not a ref
    const e = p.renameId("BlasterBolt", "Zap");
    expect(text(p, "Projectiles", "B2")).toBe("Zap");
    expect(text(p, "Weapons", "C2")).toBe('[ "Zap",  "Zap" ]');
    expect(text(p, "Projectiles", "D2")).toBe("BlasterBolt");
    expect(e.ops).toEqual([{ kind: "renameId", from: "BlasterBolt", to: "Zap" }]);
    expect(validate(p).issues.filter((i) => i.level === "error").map((i) => i.message)).toEqual([]);
  });

  it("refs inside struct and union cells, and in split and repeated columns", () => {
    const schema = `
structs:
  Box: { fields: { size: int } }
  Link: { fields: { target: "ref<Weapon>", note: string } }
  Burst: { fields: { weapon: "ref<Weapon>", count: int } }
unions:
  Effect: { discriminator: kind, variants: [Box, Burst] }
types:
  Weapon: { fields: { next: "struct<Link>", effects: "list<union<Effect>>", alts: "list<ref<Weapon>>" } }
  Config: { singleton: true, fields: { start: "ref<Weapon>", link: "struct<Link>" } }
`;
    const { project: p } = loadProject(schema, {
      sheets: [
        {
          name: "W",
          layouts: { Weapon: ["next.target", "next.note", "effects", "alts[0]", "alts[1]"] },
          rows: [
            ["Weapon", "gun", "gun", "gun", '[{"kind": "Burst", "weapon": "gun", "count": 2}, {"kind": "Box", "size": 1}]', "gun", "knife"],
            ["Weapon", "knife"],
          ],
        },
        { name: "C", rows: [["Config"], [".start", "gun"], [".link", '{"target": "gun", "note": "gun"}']] },
      ],
    });
    expect(validate(p).issues).toEqual([]);
    p.renameId("gun", "rifle");
    const w = (a1: string) => text(p, "W", a1);
    expect([w("B1"), w("C1"), w("D1"), w("F1"), w("G1")]).toEqual(["rifle", "rifle", "gun", "rifle", "knife"]);
    expect(w("E1")).toBe('[{"kind": "Burst", "weapon": "rifle", "count": 2}, {"kind": "Box", "size": 1}]');
    expect(text(p, "C", "B2")).toBe("rifle");
    expect(text(p, "C", "B3")).toBe('{"target": "rifle", "note": "gun"}');
    expect(validate(p).issues).toEqual([]);
  });

  it("is case-sensitive, leaves formulas alone and lists the ones that mention the ID", () => {
    const p = krbsg();
    const sprites = p.sheetId("Sprites");
    p.set(p.sheetId("Enemies"), "C2", "SPR_SHIP"); // already broken; left alone
    p.set(sprites, "G2", '=ENTITY("spr_ship").width');
    const e = p.renameId("spr_ship", "spr_hero");
    expect(text(p, "Enemies", "C2")).toBe("SPR_SHIP");
    expect(text(p, "PlayerShips", "C2")).toBe("spr_hero");
    expect(e.formulas).toEqual([{ sheet: sprites, row: p.wb.sheet(sprites).rows.idAt(2), col: p.wb.sheet(sprites).cols.idAt(7) }]);
    expect(p.engine.formula(sprites, "G2")).toBe('=ENTITY("spr_ship").width');
  });

  it("commented-out rows are rewritten too", () => {
    const p = krbsg();
    p.set(p.sheetId("Enemies"), "A2", "#Enemy");
    p.renameId("house", "hut");
    expect(text(p, "Enemies", "E2")).toBe("hut");
  });

  it("undoes exactly, even where a cell already held the new name", () => {
    const p = krbsg();
    p.set(p.sheetId("Enemies"), "E2", "bolt"); // already the new name
    const before = cloneDoc(p.doc);
    const e = p.renameId("house", "bolt");
    expect(text(p, "PlayerShips", "D2")).toBe("bolt");
    p.apply(e.inverse);
    expect(docsEqual(p.doc, before)).toBe(true);
    expect(text(p, "Enemies", "E2")).toBe("bolt");
  });
});

describe("a project rebuilt from its document is the same project", () => {
  it("KRBSG, after edits", () => {
    const p = krbsg();
    const s = p.sheetId("Sprites");
    p.set(s, "G2", "=E2*2");
    p.remove(s, "row", 3);
    p.move(s, "row", 2, 1, 6);
    p.renameId("tex_ship", "tex_hero");
    const q = Project.fromDoc(cloneDoc(p.doc));
    expect(docsEqual(q.doc, p.doc)).toBe(true);
    expect(root(q)).toEqual(root(p));
    expect(validate(q).issues).toEqual(validate(p).issues);
    expect(q.engine.formula(s, "G6")).toBe("=E6*2");
    expect(liveIds(q.doc.sheets.get(s)!.rows)).toEqual(liveIds(p.doc.sheets.get(s)!.rows));
  });

  it("ops replay onto a copy of the base to the same document", () => {
    const p = krbsg();
    const base = cloneDoc(p.doc);
    const s = p.sheetId("Weapons");
    const ops = [p.set(s, "J9", "x"), p.insert(s, "row", 2), p.renameId("Blaster", "Pew")].flatMap((e) => e.ops);
    const doc = cloneDoc(base);
    for (const op of ops) applyOp(doc, op);
    expect(docsEqual(doc, p.doc)).toBe(true);
  });
});
