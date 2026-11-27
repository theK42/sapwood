import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject, Sapwood } from "@thek42/sapwood-core";
import { rank, score, search } from "./search.ts";

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
});
