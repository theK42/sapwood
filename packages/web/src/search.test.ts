import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject, Sapwood } from "@thek42/sapwood-core";
import { cellIndex, rank, score, search, searchCells } from "./search.ts";

const fixture = (f: string) => readFileSync(new URL(`../../core/fixtures/krbsg/${f}`, import.meta.url), "utf8");
const krbsg = () => loadProject(fixture("schema.yaml"), fixture("project.yaml")).project;
const names = (hits: ReturnType<typeof search>["hits"]) => hits.map((h) => `${h.kind} ${h.kind === "entity" ? h.id : h.name}`);

describe("search", () => {
  it("ranks the whole name, its start, a word's start, then anywhere", () => {
    expect(rank("Sprite", "sprite")).toBe(0);
    expect(rank("spr_star1", "spr")).toBe(1);
    expect(rank("spr_star1", "star")).toBe(2);
    expect(rank("IonBolt", "bolt")).toBe(2);
    expect(rank("spr_star1", "1")).toBe(2);
    expect(rank("Projectile", "ject")).toBe(3);
    expect(rank("Projectile", "xyz")).toBeNull();
    // Every word must match; the worst one counts.
    expect(score("spr_star3", "star 3")).toBe(2);
    expect(score("spr_star3", "star 4")).toBeNull();
    expect(score("anything", "  ")).toBeNull();
  });

  it("finds types, sheets and entities, best first", () => {
    const p = krbsg();
    expect(names(search(p, "sprite").hits)).toEqual(["type Sprite", "sheet Sprites"]);
    const star = search(p, "star").hits;
    expect(names(star).slice(0, 3)).toEqual(["type StarfieldLayer", "sheet Starfield", "entity spr_star1"]);
    expect(star.filter((h) => h.kind === "entity").every((h) => h.kind === "entity" && /star/i.test(h.id))).toBe(true);
    const bolt = search(p, "bolt").hits.find((h) => h.kind === "entity" && h.id === "bolt");
    expect(bolt).toMatchObject({ kind: "entity", type: "CollisionShape", where: "CollisionShapes", active: true });
    expect(search(p, "").hits).toEqual([]);
    // An exact ID beats types and sheets that only start with it.
    expect(names(search(p, "Textured").hits)[0]).toBe("entity Textured");
    expect(names(search(p, "texture").hits).slice(0, 2)).toEqual(["type Texture", "sheet Textures"]);
  });

  it("cuts long lists, counting the rest; commented-out entities after live ones", () => {
    const p = krbsg();
    const r = search(p, "s", { types: 5, sheets: 5, entities: 3 });
    expect(r.hits.filter((h) => h.kind === "entity").length).toBe(3);
    expect(r.moreEntities).toBeGreaterThan(0);
    const s = new Sapwood(p);
    s.commentOut("tex_star1");
    const after = names(search(p, "tex_star").hits).filter((x) => x.startsWith("entity"));
    expect(after.at(-1)).toBe("entity tex_star1");
  });

  it("inside cells: part of a string, a token's uses, formulas, and what each cell holds", () => {
    const p = krbsg();
    const idx = cellIndex(p);
    const lua = searchCells(p, idx, ".lua");
    expect(lua.hits.map((h) => h.text).sort()).toEqual(["Flyoff.lua", "blaster.lua", "blaster_bolt.lua", "enemyShip.lua"]);
    expect(lua.hits[0]).toMatchObject({ kind: "cell", text: "enemyShip.lua", entity: { id: "basic_enemy", type: "Enemy", field: "script" } });
    // Sheets in the pack tree's order: the root's first.
    const level1 = new Sapwood(p);
    level1.apply([{ op: "createPack", name: "level1" }, { op: "createSheet", name: "Extra", pack: "level1" }, { op: "create", type: "Enemy", sheet: "Extra", pack: "level1", fields: { $id: "e_late", sprite: "spr_ship", script: "late.lua", collider: "house" } }]);
    const tree = searchCells(p, cellIndex(p), ".lua").hits.map((h) => h.address);
    expect(tree.at(-1)).toBe("level1 / Extra!D1");
    // A token: the cells that are exactly it first (its uses, and its own ID), then those that contain it.
    const tex = searchCells(p, idx, "Textured");
    expect(tex.hits[0]!.text).toBe("Textured");
    expect(tex.hits.every((h) => /textured/i.test(h.text))).toBe(true);
    expect(tex.hits.some((h) => h.entity?.field === "shader")).toBe(true);
    expect(tex.hits.some((h) => h.entity?.field === "$id" && h.entity.type === "Shader")).toBe(true);
    // Every word must be there; the limit cuts the list and counts the rest.
    expect(searchCells(p, idx, "blaster lua").hits.map((h) => h.text)).toEqual(["blaster.lua", "blaster_bolt.lua"]);
    const few = searchCells(p, idx, "spr_", 2);
    expect([few.hits.length, few.more > 0]).toEqual([2, true]);
  });

  it("finds a formula by its text, and its value by what it shows", () => {
    const p = loadProject("types:\n  T: { fields: { n: float } }\n", { sheets: [{ name: "S", rows: [["T", "a", 4], ["T", "b", "=C1*2.5"]] }] }).project;
    const idx = cellIndex(p);
    expect(searchCells(p, idx, "C1*2").hits).toMatchObject([{ text: "10", formula: "=C1*2.5", entity: { id: "b", field: "n" } }]);
    expect(searchCells(p, idx, "10").hits.map((h) => h.address)).toEqual(["S!C2"]);
  });
});
