import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonDoc, cloneDoc, docFromJson, docToJson } from "../ops/doc.ts";
import { ApiError, Sapwood, type ApiErrorCode, type Patch } from "./sapwood.ts";

const fixture = (f: string) => readFileSync(new URL(`../../fixtures/krbsg/${f}`, import.meta.url), "utf8");
const krbsg = () => Sapwood.load(fixture("schema.yaml"), fixture("project.yaml"));

function fails(code: ApiErrorCode, fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe(code);
    return (e as ApiError).message;
  }
  throw new Error(`expected ${code}`);
}

const SMALL = `
enums:
  Element: { members: [fire, ice] }
structs:
  Cost: { fields: { amount: int, currency: string } }
types:
  Weapon:
    fields:
      damage: float
      price: "struct<Cost>"
      shots: "list<ref<Ammo>>"
      element: "enum<Element>"
      released: datetime
      reload: duration
  Ammo: { fields: { speed: float } }
  Config:
    singleton: true
    fields: { lives: int, cost: "struct<Cost>", best: "ref<Weapon>", tags: "list<string>" }
`;
const small = () =>
  Sapwood.load(SMALL, {
    sheets: [
      {
        name: "Weapons",
        layouts: { Weapon: ["damage", "price.amount", "price.currency", "shots[0]", "shots[1]", "element", "released", "reload"] },
        rows: [["Weapon", "w1", 10, 5, "gold", "a1", "", "fire", "2026-11-14", "90s"]],
      },
      { name: "Ammo", rows: [["Ammo", "a1", 900], ["Ammo", "a2", 600]] },
    ],
  });

/** small, plus a Config block (with a split struct) on a third sheet, and a qualified row. */
const sing = () =>
  Sapwood.load(SMALL, {
    sheets: [
      {
        name: "Weapons",
        layouts: { Weapon: ["damage", "price.amount", "price.currency", "shots[0]", "shots[1]", "element", "released", "reload"] },
        rows: [["Weapon", "w1", 10, 5, "gold", "a1", "", "fire", "2026-11-14", "90s"]],
      },
      { name: "Ammo", rows: [["Ammo", "a1", 900], ["Ammo", "a2", 600], ["Config.best", "w1"]] },
      { name: "Settings", rows: [["Config"], [".lives", 3], ["", "a note"], [".cost.amount", 5], ["Ammo", "a3", 100]] },
    ],
  });

/** Column A of a sheet, top to bottom. */
const colA = (s: Sapwood, sheet: string): unknown[] => {
  const wb = s.project.wb;
  const sh = [...wb.sheets.values()].find((x) => x.name === sheet)!;
  return sh.rows.liveIds().map((r) => s.project.engine.cellById(sh.id, r, sh.cols.idAt(1)).value);
};

describe("reads", () => {
  it("an entity as JSON (§9.4)", () => {
    expect(krbsg().get("Blaster")).toEqual({
      $type: "Weapon", $id: "Blaster", $pack: "root", $sheet: "Weapons", $active: true,
      projectiles: ["BlasterBolt"], script: "blaster.lua", cooldown: 0.5, damage: 1,
    });
  });

  it("split structs and repeated columns read as one value", () => {
    expect(small().get("w1")).toMatchObject({ price: { amount: 5, currency: "gold" }, shots: ["a1"], element: "fire", released: "2026-11-14T00:00:00Z", reload: 90 });
  });

  it("a formula field shows its value and formula; a bad cell shows what it holds", () => {
    const s = krbsg();
    s.set("Blaster", { damage: { $formula: "=E2*4" } });
    expect(s.get("Blaster").damage).toEqual({ $value: 2, $formula: "=E2*4" });
    s.set("Blaster", { damage: { $formula: '="lots"' } });
    expect(s.get("Blaster").damage).toEqual({ $value: null, $formula: '="lots"' });
  });

  it("unknown and mistyped IDs", () => {
    const s = krbsg();
    expect(fails("not-found", () => s.get("blaster"))).toContain('did you mean "Blaster"');
  });

  it("query by type or trait, with a predicate and a pack", () => {
    const s = krbsg();
    const visual = s.query("Visual").map((e) => e.$type);
    expect(new Set(visual)).toEqual(new Set(["Enemy", "PlayerShip", "Projectile"]));
    expect(s.query("Sprite", { where: (e) => e.width === 50 }).map((e) => e.$id)).toEqual(["spr_galaxy", "spr_galaxy2", "spr_nebula"]);
    expect(s.query("Sprite", { pack: "root" }).length).toBe(s.query("Sprite").length);
    fails("not-found", () => s.query("Sprite", { pack: "dlc" }));
    fails("unknown-type", () => s.query("Sprit"));
  });
});

describe("writes", () => {
  it("set writes the field's cell, and undo and redo work", () => {
    const s = krbsg();
    const before = canonDoc(cloneDoc(s.doc));
    s.set("Blaster", { cooldown: 0.25, projectiles: ["BlasterBolt", "BlasterBolt"] });
    expect(s.get("Blaster")).toMatchObject({ cooldown: 0.25, projectiles: ["BlasterBolt", "BlasterBolt"] });
    expect(s.undo()).toBe(true);
    expect(canonDoc(s.doc)).toEqual(before);
    expect(s.redo()).toBe(true);
    expect(s.get("Blaster").cooldown).toBe(0.25);
    expect(s.redo()).toBe(false);
  });

  it("writing back what get returns changes no value", () => {
    const s = small();
    const { $type, $id, $pack, $sheet, $active, ...fields } = s.get("w1");
    s.set("w1", fields);
    expect(s.get("w1")).toEqual({ $type, $id, $pack, $sheet, $active, ...fields });
  });

  it("values are checked as cells are read", () => {
    const s = small();
    expect(fails("bad-value", () => s.set("w1", { damage: "lots" }))).toBe("damage: Expected a number, got \"lots\"");
    expect(fails("bad-value", () => s.set("w1", { element: "Fire" }))).toContain('did you mean "fire"');
    fails("unknown-field", () => s.set("w1", { dmg: 1 }));
    fails("bad-value", () => s.set("w1", { $type: "Ammo" }));
  });

  it("split structs, repeated columns, dates and durations write to their cells", () => {
    const s = small();
    s.set("w1", { price: { amount: 7 }, shots: ["a2", "a1"], released: "2026-11-14 18:00+02:00", reload: 150 });
    expect(s.get("w1")).toMatchObject({ price: { amount: 7 }, shots: ["a2", "a1"], released: "2026-11-14T16:00:00Z", reload: 150 });
    expect(fails("bad-value", () => s.set("w1", { shots: ["a1", "a2", "a1"] }))).toContain("the layout has 2 columns");
    expect(fails("bad-value", () => s.set("w1", { price: { gems: 1 } }))).toContain("Cost has no field gems");
    s.set("w1", { shots: null });
    expect(s.get("w1").shots).toBeUndefined();
  });

  it("replacing a formula needs force", () => {
    const s = krbsg();
    s.set("Blaster", { damage: { $formula: "=E2*4" } });
    expect(fails("formula", () => s.set("Blaster", { damage: 3 }))).toContain("=E2*4");
    s.set("Blaster", { damage: 3 }, { force: true });
    expect(s.get("Blaster").damage).toBe(3);
  });

  it("create goes after the last of its type, on that sheet", () => {
    const s = krbsg();
    s.create("Sprite", { $id: "spr_new", shader: "Textured", texture: "tex_ship", width: 8, height: 8 });
    const sprites = s.query("Sprite").map((e) => e.$id);
    expect(sprites.at(-1)).toBe("spr_new");
    expect(s.get("spr_new")).toMatchObject({ $sheet: "Sprites", width: 8 });
    expect(s.validate().errors).toBe(0);
    s.create("Sprite", { $id: "spr_first", shader: "Textured", texture: "tex_ship", width: 1, height: 1 }, { after: "spr_ship" });
    expect(s.query("Sprite").map((e) => e.$id).slice(0, 2)).toEqual(["spr_ship", "spr_first"]);
  });

  it("create refuses taken IDs, singletons, and unknown sheets", () => {
    const s = krbsg();
    expect(fails("exists", () => s.create("Sprite", { $id: "SPR_SHIP" }))).toContain("regardless of case");
    fails("bad-value", () => s.create("Sprite", {}));
    fails("not-found", () => s.create("Sprite", { $id: "x" }, { sheet: "Nowhere" }));
    fails("unknown-type", () => s.create("Sprit", { $id: "x" }));
  });

  it("a new type's first entity needs a sheet, which gets the columns it needs", () => {
    const s = Sapwood.load(SMALL, { sheets: [{ name: "A", rows: [] }, { name: "B", rows: [] }] });
    fails("no-sheet", () => s.create("Ammo", { $id: "a1", speed: 3 }));
    const before = canonDoc(cloneDoc(s.doc));
    s.create("Ammo", { $id: "a1", speed: 3 }, { sheet: "B" });
    expect(s.get("a1")).toMatchObject({ $sheet: "B", speed: 3 });
    s.undo();
    expect(canonDoc(s.doc)).toEqual(before);
  });

  it("the only data sheet is used for a new type, unless it's named after another type", () => {
    const s = Sapwood.load(SMALL, { sheets: [{ name: "Data", rows: [] }] });
    s.create("Ammo", { $id: "a1", speed: 3 });
    expect(s.get("a1").$sheet).toBe("Data");

    const t = Sapwood.load(SMALL, { sheets: [{ name: "Weapon", rows: [["Weapon", "w1", 10]] }] });
    const before = canonDoc(cloneDoc(t.doc));
    t.create("Ammo", { $id: "a1", speed: 3 });
    expect(t.get("a1")).toMatchObject({ $sheet: "Ammo", speed: 3 });
    expect(t.validate().errors).toBe(0);
    t.undo();
    expect(canonDoc(t.doc)).toEqual(before);
    t.redo();
    expect(t.get("a1").$sheet).toBe("Ammo");

    const u = Sapwood.load(SMALL, { sheets: [{ name: "Ammo", rows: [] }] });
    u.create("Ammo", { $id: "a1", speed: 3 });
    expect(u.get("a1").$sheet).toBe("Ammo");
    const v = Sapwood.load(SMALL, { sheets: [{ name: "Weapon", rows: [] }, { name: "Ammo", kind: "scratch", rows: [] }] });
    fails("no-sheet", () => v.create("Ammo", { $id: "a1" }));
  });

  it("renaming through $id rewrites refs and lists the formulas that mention it", () => {
    const s = krbsg();
    s.set("Blaster", { damage: { $formula: '=ENTITY("BlasterBolt").id="x"' } });
    const c = s.set("BlasterBolt", { $id: "BlasterShot" });
    expect(s.get("Blaster").projectiles).toEqual(["BlasterShot"]);
    expect(c.formulas).toEqual([{ sheet: "Weapons", cell: "F2" }]);
    fails("exists", () => s.set("BlasterShot", { $id: "Blaster" }));
  });

  it("comment out, uncomment and delete", () => {
    const s = krbsg();
    s.commentOut("BlasterBolt");
    expect(s.get("BlasterBolt").$active).toBe(false);
    expect(s.query("Projectile")).toEqual([]);
    expect(s.validate().issues.map((i) => i.code)).toEqual(["ref.inactive"]);
    s.uncomment("BlasterBolt");
    s.delete("BlasterBolt");
    fails("not-found", () => s.get("BlasterBolt"));
    expect(s.validate().issues.map((i) => i.code)).toEqual(["ref.missing"]);
  });

  it("patches apply all or nothing, as one undo step", () => {
    const s = krbsg();
    const before = canonDoc(cloneDoc(s.doc));
    fails("unknown-field", () =>
      s.apply([
        { op: "set", id: "Blaster", fields: { cooldown: 1 } },
        { op: "set", id: "Blaster", fields: { nope: 1 } },
      ]),
    );
    expect(canonDoc(s.doc)).toEqual(before);
    s.apply([
      { op: "create", type: "Weapon", fields: { $id: "Rifle", projectiles: ["BlasterBolt"], cooldown: 1, damage: 2 } },
      { op: "set", id: "Rifle", fields: { damage: 3 } },
      { op: "commentOut", id: "Blaster" },
    ]);
    expect(s.get("Rifle").damage).toBe(3);
    s.undo();
    expect(canonDoc(s.doc)).toEqual(before);
  });
});

describe("packs and sheets", () => {
  it("a DLC pack with its own sheets, whose entities refer to root's", () => {
    const s = krbsg();
    const before = canonDoc(cloneDoc(s.doc));
    s.apply([
      { op: "createPack", name: "dlc" },
      { op: "createSheet", name: "DLC Weapons", pack: "dlc" },
      { op: "createSheet", name: "Notes", pack: "dlc", kind: "scratch" },
      { op: "create", type: "Projectile", sheet: "DLC Weapons", pack: "dlc", fields: { $id: "LanceBolt", sprite: "spr_blaster", script: "lance_bolt.lua", collider: "bolt" } },
      { op: "create", type: "Weapon", sheet: "DLC Weapons", pack: "dlc", fields: { $id: "Lance", projectiles: ["LanceBolt"], script: "lance.lua", cooldown: 1.2, damage: 4 } },
    ]);
    expect(s.get("Lance")).toMatchObject({ $pack: "dlc", $sheet: "DLC Weapons", projectiles: ["LanceBolt"] });
    expect(s.query("Weapon", { pack: "dlc" }).map((e) => e.$id)).toEqual(["Lance"]);
    expect(s.validate().errors).toBe(0);
    expect(s.export().map((f) => f.path)).toContain("dlc.json");
    // A sub-pack, and what's refused.
    s.createPack("dlc2", "dlc");
    fails("exists", () => s.createPack("dlc"));
    fails("not-found", () => s.createPack("x", "nope"));
    fails("bad-value", () => s.createPack("a/b"));
    fails("exists", () => s.createSheet("Notes", { pack: "dlc" }));
    fails("bad-value", () => s.createSheet("Bad!Name"));
    fails("bad-value", () => s.apply([{ op: "createSheet", name: "X", kind: "pivot" as "data" }]));
    // root's entities can't refer to the DLC's (§7.2).
    s.set("Blaster", { projectiles: ["LanceBolt"] });
    expect(s.validate().errors).toBeGreaterThan(0);
    while (s.undo());
    expect(canonDoc(s.doc)).toEqual(before);
  });
});

describe("singletons", () => {
  it("read from blocks and qualified rows, with split structs as one object", () => {
    const s = sing();
    expect(s.singleton("Config")).toEqual({ $type: "Config", $pack: "root", lives: 3, cost: { amount: 5 }, best: "w1" });
    expect(fails("singleton", () => s.get("Config"))).toContain('singleton("Config")');
    fails("unknown-type", () => s.singleton("Weapon"));
    fails("unknown-type", () => s.singleton("Nope"));
  });

  it("writes go to a field's row; new fields join the block", () => {
    const s = sing();
    const before = canonDoc(cloneDoc(s.doc));
    s.setSingleton("Config", { lives: 4, cost: { amount: 6, currency: "gold" }, tags: ["a", "b"], best: null });
    expect(s.singleton("Config")).toEqual({ $type: "Config", $pack: "root", lives: 4, cost: { amount: 6, currency: "gold" }, tags: ["a", "b"] });
    // After the block's last field row, before the entity that ends it; schema order.
    expect(colA(s, "Settings")).toEqual(["Config", ".lives", null, ".cost.amount", ".cost.currency", ".tags", "Ammo"]);
    expect(colA(s, "Ammo")).toEqual(["Ammo", "Ammo", "Config.best"]); // cleared, not removed
    expect(s.validate().errors).toBe(0);
    expect(s.get("a3").$active).toBe(true);
    s.undo();
    expect(canonDoc(s.doc)).toEqual(before);
  });

  it("formulas, and what's refused", () => {
    const s = sing();
    s.setSingleton("Config", { lives: { $formula: "=2+2" } });
    expect(s.singleton("Config").lives).toEqual({ $value: 4, $formula: "=2+2" });
    expect(fails("formula", () => s.setSingleton("Config", { lives: 5 }))).toContain("=2+2");
    s.setSingleton("Config", { lives: 5 }, { force: true });
    expect(s.singleton("Config").lives).toBe(5);
    expect(fails("bad-value", () => s.setSingleton("Config", { cost: 5 }))).toContain("split into rows");
    expect(fails("bad-value", () => s.setSingleton("Config", { cost: { gems: 1 } }))).toContain("Cost has no field gems");
    expect(fails("bad-value", () => s.setSingleton("Config", { lives: "many" }))).toContain("Config.lives");
    fails("bad-value", () => s.setSingleton("Config", { $active: false }));
    fails("unknown-field", () => s.setSingleton("Config", { nope: 1 }));
    const d = Sapwood.load(SMALL, { sheets: [{ name: "Data", rows: [["Config"], [".lives", 1], ["Config.lives", 2]] }] });
    expect(fails("ambiguous", () => d.setSingleton("Config", { lives: 3 }))).toContain("Data row 2, Data row 3");
  });

  it("with no block, one is added on the only data sheet or a sheet of its own", () => {
    const d = Sapwood.load(SMALL, { sheets: [{ name: "Data", rows: [["Ammo", "a1", 1], [], ["", "a note"]] }] });
    d.setSingleton("Config", { tags: ["x"], lives: 2 });
    expect(colA(d, "Data")).toEqual(["Ammo", null, null, "Config", ".lives", ".tags"]);
    expect(d.singleton("Config")).toMatchObject({ lives: 2, tags: ["x"] });

    const s = small();
    const before = canonDoc(cloneDoc(s.doc));
    s.setSingleton("Config", { lives: 2 });
    expect(colA(s, "Config")).toEqual(["Config", ".lives"]);
    expect(s.validate().errors).toBe(0);
    s.undo();
    expect(canonDoc(s.doc)).toEqual(before);
  });

  it("in patches and the export", () => {
    const s = small();
    s.apply([{ op: "setSingleton", type: "Config", fields: { lives: 3, best: "w1" } }, { op: "set", id: "w1", fields: { damage: 12 } }]);
    const root = JSON.parse(s.export().find((f) => f.path === "root.json")!.content);
    expect(root.singletons).toEqual({ Config: { lives: 3, best: { type: "Weapon", id: "w1" } } });
    s.undo();
    expect(s.singleton("Config")).toEqual({ $type: "Config", $pack: "root" });
  });
});

describe("validation", () => {
  it("issues are located by sheet, cell and entity", () => {
    const s = krbsg();
    s.set("Blaster", { projectiles: ["BlasterBolt", "PlasmaBolt"] });
    expect(s.validate()).toEqual({
      errors: 1,
      warnings: 0,
      issues: [{
        level: "error", code: "ref.missing", message: 'projectiles[1]: no entity "PlasmaBolt"',
        sheet: "Weapons", row: 2, cell: "C2", entity: { type: "Weapon", id: "Blaster" },
      }],
    });
  });

  it("export refuses an invalid project unless asked", () => {
    const s = krbsg();
    expect(s.export().map((f) => f.path)).toContain("manifest.json");
    s.set("Blaster", { projectiles: ["PlasmaBolt"] });
    expect(() => s.export()).toThrow(/Export refused/);
    expect(s.export({ allowInvalid: true }).length).toBeGreaterThan(1);
  });
});

describe("the API (properties)", () => {
  const RUNS = Number(process.env.RUNS ?? 300);
  const IDS = ["w1", "w2", "a1", "a2", "a3", "W1"];
  const VALUES: Record<string, unknown[]> = {
    damage: [1, 2.5, "x", null, { $formula: "=1+1" }, { $formula: '=ENTITY("a1").speed' }],
    price: [{ amount: 1, currency: "gold" }, { amount: 2 }, { gems: 1 }, null],
    shots: [["a1"], ["a1", "a2"], ["a1", "a2", "a3"], [], null, ["nope"]],
    element: ["fire", "ice", "Fire", null],
    released: ["2026-11-14", "nope", null],
    reload: [90, "5m", "x", null],
    speed: [1, 900, "fast", null],
    nope: [1],
  };
  const SINGLE: Record<string, unknown[]> = {
    lives: [1, "x", null, { $formula: "=1+2" }],
    cost: [{ amount: 1 }, { amount: 1, currency: "g" }, { gems: 1 }, 5, null],
    best: ["w1", "nope", null],
    tags: [["a"], [], null, "x"],
    $id: ["x"],
  };

  it("every change undoes exactly, failures change nothing, and a rebuilt project agrees", () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const pick = <T,>(xs: readonly T[]): T => xs[g(fc.integer, { min: 0, max: xs.length - 1 })]!;
        const s = pick([small, sing])();
        const start = canonDoc(cloneDoc(s.doc));
        let changes = 0;
        for (let i = g(fc.integer, { min: 1, max: 8 }); i > 0; i--) {
          const before = canonDoc(cloneDoc(s.doc));
          const field = pick(Object.keys(VALUES));
          const patch = pick([
            () => ({ op: "set", id: pick(IDS), fields: { [field]: pick(VALUES[field]!) }, force: pick([true, false]) }),
            () => ({ op: "set", id: pick(IDS), fields: { $id: pick(IDS) } }),
            () => ({ op: "create", type: pick(["Weapon", "Ammo"]), fields: { $id: pick(IDS), [field]: pick(VALUES[field]!) } }),
            () => ({ op: pick(["commentOut", "uncomment", "delete"]), id: pick(IDS) }),
            () => {
              const f = pick(Object.keys(SINGLE));
              return { op: "setSingleton", type: "Config", fields: { [f]: pick(SINGLE[f]!) }, force: pick([true, false]) };
            },
          ])() as Patch;
          try {
            s.apply(pick([[patch], [patch, patch]]));
            changes++;
          } catch (e) {
            if (!(e instanceof ApiError)) throw e;
            expect(canonDoc(s.doc)).toEqual(before);
          }
          if (pick([true, false])) s.validate();
        }
        const fresh = Sapwood.fromDoc(docFromJson(JSON.parse(JSON.stringify(docToJson(s.doc))))); // as a saved file is
        expect(fresh.validate()).toEqual(s.validate());
        expect(canonDoc(fresh.doc)).toEqual(canonDoc(s.doc));
        for (const id of IDS) {
          const read = (x: Sapwood) => { try { return x.get(id); } catch (e) { return (e as ApiError).code; } };
          expect(read(fresh)).toEqual(read(s));
        }
        expect(fresh.singleton("Config")).toEqual(s.singleton("Config"));
        for (; changes > 0; changes--) expect(s.undo()).toBe(true);
        expect(canonDoc(s.doc)).toEqual(start);
      }),
      { numRuns: RUNS },
    );
  });
});
