import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject } from "@thek42/sapwood-core";
import { SheetGrid } from "./grid.ts";
import { candidates, complete, suggest, tokenAt, type Candidate } from "./suggest.ts";

const fixture = (f: string) => readFileSync(new URL(`../../core/fixtures/krbsg/${f}`, import.meta.url), "utf8");
const krbsg = () => loadProject(fixture("schema.yaml"), fixture("project.yaml")).project;

describe("what a cell accepts", () => {
  it("a ref, a list of refs, or nothing", () => {
    const p = krbsg();
    const w = new SheetGrid(p, p.sheetId("Weapons"));
    expect(w.refAt(1, 2)).toMatchObject({ targets: ["Projectile"], list: true }); // projectiles
    expect(w.refAt(1, 4)).toBeNull(); // cooldown
    expect(w.refAt(1, 1)).toBeNull(); // the ID itself
    const e = new SheetGrid(p, p.sheetId("Enemies"));
    expect(e.refAt(1, 2)).toMatchObject({ targets: ["Sprite"], list: false });
  });

  it("an element of a list spread over columns, and a ref in a split struct", () => {
    const schema = `structs:
  Cost: { fields: { currency: { type: "ref<Coin>" }, amount: { type: int } } }
types:
  Coin: { fields: {} }
  Item: { fields: { tags: { type: "list<ref<Coin>>" }, price: { type: "struct<Cost>" } } }
`;
    const p = loadProject(schema, {
      sheets: [{ name: "Items", layouts: { Item: ["tags[0]", "tags[1]", "price.currency", "price.amount"] }, rows: [["Coin", "gold"], ["Item", "sword", "gold", "", "gold", 3]] }],
    }).project;
    const g = new SheetGrid(p, p.sheetId("Items"));
    expect([2, 3, 4, 5].map((c) => g.refAt(1, c)?.list ?? null)).toEqual([false, false, false, null]);
  });
});

describe("the IDs a ref may point at", () => {
  it("active entities of the type, once each, in reach", () => {
    const schema = `types:
  Sprite: { fields: {} }
  Enemy: { fields: { sprite: { type: "ref<Sprite>" }, any: { type: "ref<Sprite>", reach: descendants } } }
`;
    const p = loadProject(schema, {
      packs: [{ name: "level1" }],
      sheets: [
        { name: "Sprites", rows: [["Sprite", "spr_a"], ["#Sprite", "spr_off"], ["Sprite", "spr_a"], ["Enemy", "e0"]] },
        { name: "More", pack: "level1", rows: [["Sprite", "spr_l1"], ["Enemy", "e1"]] },
      ],
    }).project;
    const ids = (from: string, reach = false) => candidates(p, { targets: ["Sprite"], from, list: false, ...(reach ? { reach: "descendants" as const } : {}) }).map((c) => `${c.id} @${c.where}`);
    expect(ids("root")).toEqual(["spr_a @Sprites"]);
    expect(ids("level1")).toEqual(["spr_a @Sprites", "spr_l1 @level1 / More"]);
    expect(ids("root", true)).toEqual(["spr_a @Sprites", "spr_l1 @level1 / More"]);
  });

  it("from KRBSG: a weapon's projectiles", () => {
    const p = krbsg();
    const t = new SheetGrid(p, p.sheetId("Weapons")).refAt(1, 2)!;
    expect(candidates(p, t).map((c) => c.id)).toContain("BlasterBolt");
    expect(candidates(p, t).every((c) => c.type === "Projectile")).toBe(true);
  });
});

describe("typing an ID", () => {
  const c = (id: string): Candidate => ({ id, type: "T", where: "S" });
  const all = ["BlasterBolt", "HeavyBolt", "bolt_small", "Laser", "aboltz"].map(c);

  it("offers those it starts first, then at a word break, then anywhere", () => {
    expect(suggest(all, "bol").map((x) => x.id)).toEqual(["bolt_small", "BlasterBolt", "HeavyBolt", "aboltz"]);
    expect(suggest(all, "").length).toBe(5);
    expect(suggest(all, "Laser")).toEqual([]); // already typed
  });

  it("finds the ID being typed: the whole cell, a plain list's item, a JSON list's string", () => {
    expect(tokenAt("  Bla", 5, false)).toEqual({ start: 2, end: 5, prefix: "Bla", quote: false });
    expect(tokenAt("=ENTITY(", 8, false)).toBeNull();
    expect(tokenAt("BlasterBolt, Hea", 16, true)).toEqual({ start: 13, end: 16, prefix: "Hea", quote: false });
    expect(tokenAt('["BlasterBolt", "Hea"]', 20, true)).toEqual({ start: 17, end: 20, prefix: "Hea", quote: false });
    expect(tokenAt('["BlasterBolt", ', 16, true)).toEqual({ start: 16, end: 16, prefix: "", quote: true });
    expect(tokenAt('["BlasterBolt"]', 15, true)).toBeNull();
  });

  it("puts the picked ID in its place", () => {
    const t1 = tokenAt("BlasterBolt, Hea", 16, true)!;
    expect(complete("BlasterBolt, Hea", t1, "HeavyBolt")).toEqual({ text: "BlasterBolt, HeavyBolt", caret: 22 });
    const t2 = tokenAt('["Hea"]', 5, true)!;
    expect(complete('["Hea"]', t2, "HeavyBolt")).toEqual({ text: '["HeavyBolt"]', caret: 12 });
    // A quote not yet closed gets its closing one, and what follows stays.
    const t4 = tokenAt('["a", "He]', 9, true)!;
    expect(complete('["a", "He]', t4, "HeavyBolt")).toEqual({ text: '["a", "HeavyBolt"]', caret: 17 });
    const t3 = tokenAt('["a", ', 6, true)!;
    expect(complete('["a", ', t3, "b")).toEqual({ text: '["a", "b"', caret: 9 });
  });
});
