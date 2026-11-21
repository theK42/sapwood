import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject, type ProjectDef } from "./load.ts";
import { validate } from "./validate.ts";

const fixture = (f: string) => readFileSync(new URL(`../../fixtures/krbsg/${f}`, import.meta.url), "utf8");
const KRBSG_SCHEMA = fixture("schema.yaml");
const KRBSG = fixture("project.yaml");

const krbsg = () => loadProject(KRBSG_SCHEMA, KRBSG).project;

/** Issues as "code @Sheet!A1: message", for readable assertions. */
function report(project: ReturnType<typeof krbsg>) {
  const v = validate(project);
  return v.issues.map((i) => {
    let where = "";
    if (i.at) {
      const s = project.wb.sheet(i.at.sheet);
      const col = i.at.col ? s.cols.posOf(i.at.col) : null;
      where = ` @${s.name}!${col ? String.fromCharCode(64 + col) : ""}${s.rows.posOf(i.at.row)}`;
    }
    return `${i.level === "warning" ? "warning " : ""}${i.code}${where}: ${i.message}`;
  });
}

describe("KRBSG validates clean", () => {
  it("no errors and no warnings", () => {
    const v = validate(krbsg());
    expect(v.issues).toEqual([]);
    expect(v.errors).toBe(0);
  });
});

describe("M1: injected errors are caught", () => {
  it("a bad ref", () => {
    const p = krbsg();
    p.set(p.sheetId("Weapons"), "C2", '["BlasterBolt", "PlasmaBolt"]');
    expect(report(p)).toEqual(['ref.missing @Weapons!C2: projectiles[1]: no entity "PlasmaBolt"']);
  });

  it("a ref with the wrong case gets a hint", () => {
    const p = krbsg();
    p.set(p.sheetId("Enemies"), "C2", "SPR_SHIP");
    expect(report(p)).toEqual(['ref.missing @Enemies!C2: sprite: no entity "SPR_SHIP" (IDs are case-sensitive: did you mean "spr_ship"?)']);
  });

  it("a duplicate ID, across types and sheets, regardless of case", () => {
    const p = krbsg();
    p.set(p.sheetId("Shaders"), "B3", "spr_Ship");
    p.set(p.sheetId("Shaders"), "A3", "Shader");
    p.set(p.sheetId("Shaders"), "C3", "a.vert");
    p.set(p.sheetId("Shaders"), "D3", "a.frag");
    expect(report(p)).toEqual([
      'id.duplicate @Shaders!B3: ID "spr_Ship" is also used by Sprite on Sprites (IDs are unique regardless of case)',
      'id.duplicate @Sprites!B2: ID "spr_ship" is also used by Shader on Shaders (IDs are unique regardless of case)',
    ]);
  });

  it("a wrong type", () => {
    const p = krbsg();
    p.set(p.sheetId("Sprites"), "E2", "big");
    p.set(p.sheetId("Textures"), "D2", "maybe");
    expect(report(p)).toEqual([
      "cell.parse @Textures!D2: isPixelArt: Expected TRUE or FALSE, got \"maybe\"",
      'cell.parse @Sprites!E2: width: Expected a number, got "big"',
    ]);
  });

  it("a ref to the wrong type", () => {
    const p = krbsg();
    p.set(p.sheetId("Sprites"), "D2", "Textured"); // a Shader, not a Texture
    expect(report(p)).toEqual(['ref.type @Sprites!D2: texture: "Textured" is a Shader, not Texture']);
  });

  it("a cross-sibling pack ref, and the reach rules around it (§7.2)", () => {
    const schema = KRBSG_SCHEMA.replace("\nrules:", `
  EventIndex:
    id: t90
    fields:
      events: { id: f90, type: "list<ref<Enemy>>", reach: descendants }
      featured: { id: f91, type: "ref<Enemy>" }

rules:`);
    const def: ProjectDef = {
      packs: [{ name: "level1" }, { name: "level2" }],
      sheets: [
        { name: "Sprites", rows: [["Sprite", "spr_root", "Textured", "tex"]] },
        { name: "Base", rows: [["Shader", "Textured", "a.vert", "a.frag"], ["Texture", "tex", "t.png"], ["CollisionShape", "box", '[{"kind": "Box"}]']] },
        { name: "Sprites", pack: "level2", rows: [["Sprite", "spr_l2", "Textured", "tex"]] },
        { name: "Enemies", pack: "level1", rows: [["Enemy", "e_ok", "spr_root", "", "box"], ["Enemy", "e_bad", "spr_l2", "", "box"]] },
        { name: "Index", rows: [["EventIndex", "index", '["e_ok"]', "e_ok"]] },
      ],
    };
    const p = loadProject(schema, def).project;
    expect(report(p)).toEqual([
      'ref.reach @Enemies!C2: sprite: "spr_l2" is in pack level2, which level1 can\'t reach. Refs may point at their own pack or its ancestors',
      'ref.reach @Index!D1: featured: "e_ok" is in pack level1, which root can\'t reach. Refs may point at their own pack or its ancestors',
    ]);
  });
});

describe("the rest of the pipeline", () => {
  it("schema problems are reported too, parse errors included", () => {
    const p = loadProject("types:\n  Weapon: { fields: { damage: flaot } }\n", { sheets: [] }).project;
    expect(report(p)).toEqual([expect.stringMatching(/^schema: types\.Weapon\.fields\.damage\.type: unknown type "flaot"/)]);
  });

  it("required fields, inactive targets, constraints", () => {
    const p = krbsg();
    const sprites = p.sheetId("Sprites");
    p.set(sprites, "C3", ""); // spr_blaster loses its shader
    p.set(sprites, "F4", "0"); // height min 1
    p.set(p.sheetId("Textures"), "A2", "#Texture"); // comment out tex_ship
    p.set(p.sheetId("Starfield"), "F3", "[]"); // minItems 1
    p.set(p.sheetId("Fonts"), "H2", " "); // nonEmpty
    expect(report(p)).toEqual([
      "field.required @Sprites!C3: shader is required",
      "field.constraint @Sprites!F4: height: must be at least 1",
      'ref.inactive @Sprites!D2: texture: "tex_ship" is commented out',
      "field.constraint @Fonts!H2: glyphs: must not be empty",
      "field.constraint @Starfield!F3: stars: needs at least 1 item",
    ].sort((a, b) => order(a) - order(b)));
  });

  it("inactive rows aren't validated and don't take part in ID uniqueness", () => {
    const p = krbsg();
    const s = p.sheetId("Weapons");
    p.set(s, "A3", "#Weapon");
    p.set(s, "B3", "Blaster"); // a commented-out duplicate
    p.set(s, "E3", "not a number");
    expect(report(p)).toEqual([]);
  });

  it("structs and unions are checked inside", () => {
    const p = krbsg();
    p.set(p.sheetId("CollisionShapes"), "C3", '[{"kind": "Circle", "radius": -1}]');
    expect(report(p)).toEqual(["field.constraint @CollisionShapes!C3: shapes[0].radius: must be at least 0"]);
    p.set(p.sheetId("CollisionShapes"), "C3", '[{"kind": "Triangle"}]');
    expect(report(p)).toEqual([expect.stringMatching(/^cell\.parse @CollisionShapes!C3: shapes: \[0\]: "kind" must be one of Box, Circle, not "Triangle"/)]);
  });

  it("custom rules, per entity and per trait (§5.7)", () => {
    const p = krbsg();
    p.set(p.sheetId("Weapons"), "E2", "0.01");
    p.set(p.sheetId("Projectiles"), "D2", "blaster_bolt.py");
    expect(report(p)).toEqual([
      "warning rule @Projectiles!2: Scripts are Lua files",
      "warning rule @Weapons!2: Cooldown under 50ms is probably a typo",
    ].sort());
  });

  it("an ID formula using ROW() is a warning; a missing ID is an error", () => {
    const p = krbsg();
    const s = p.sheetId("Shaders");
    p.setRows(s, [["Shader", '="shader_"&ROW()', "b.vert", "b.frag"]], 3);
    expect(report(p)).toEqual(["warning id.positional @Shaders!B3: This ID uses ROW() or COLUMN(): moving the row renames the entity"]);
    p.set(p.sheetId("Textures"), "B2", "");
    expect(report(p)).toContain("id.missing @Textures!B2: This Texture has no ID");
  });

  it("singletons: duplicates, wrong pack, required fields", () => {
    const schema = `types:
  GameConfig: { singleton: true, fields: { maxLives: { type: int, required: true, min: 1 }, title: string, startingWeapon: "ref<Weapon>" } }
  Weapon: { fields: { damage: float } }
`;
    const def: ProjectDef = {
      packs: [{ name: "event" }],
      sheets: [
        { name: "Config", rows: [["GameConfig"], [".title", "One"], ["GameConfig.title", "Two"], [".startingWeapon", "w2"]] },
        { name: "Event", pack: "event", rows: [["Weapon", "w2", 1], ["GameConfig.maxLives", 0]] },
      ],
    };
    expect(report(loadProject(schema, def).project)).toEqual([
      "singleton.duplicate @Config!A2: GameConfig.title has 2 active entries; keep one, or comment the others out",
      "singleton.duplicate @Config!A3: GameConfig.title has 2 active entries; keep one, or comment the others out",
      "singleton.pack @Event!A2: GameConfig lives in pack root; this entry is on a sheet in event",
      "field.constraint @Event!B2: maxLives: must be at least 1",
      'ref.reach @Config!B4: startingWeapon: "w2" is in pack event, which root can\'t reach. Refs may point at their own pack or its ancestors',
    ]);
    const empty = loadProject(schema, { sheets: [{ name: "Config", rows: [] }] }).project;
    expect(report(empty)).toEqual(["field.required: GameConfig.maxLives is required, but has no entry"]);
  });
});

/** Issues come out grouped by pipeline step, then sheet order; mirror that for the expected list. */
function order(line: string): number {
  return ["field.", "ref.", "rule"].findIndex((p) => line.startsWith(p)) * 1000 + ["Sprites", "Fonts", "Starfield"].findIndex((s) => line.includes(`@${s}!`));
}

describe("validation after an edit", () => {
  it("re-reads only the rows the edit changed", () => {
    const p = krbsg();
    const before = validate(p).projection.entities;
    const weapons = p.sheetId("Weapons");
    p.set(weapons, "F2", "-1");
    const after = validate(p).projection.entities;
    const changed = after.filter((e, i) => e !== before[i]);
    expect(changed.map((e) => e.id)).toEqual(["Blaster"]);
    expect(changed[0]!.fields.get("damage")?.value).toBe(-1);
  });

  it("finds what an edit breaks, and forgets it once fixed", () => {
    const p = krbsg();
    validate(p);
    const weapons = p.sheetId("Weapons");
    p.set(weapons, "B2", "BlasterBolt"); // the Weapon takes its projectile's ID
    expect(report(p).filter((l) => l.startsWith("id."))).toHaveLength(2);
    p.set(weapons, "B2", "Blaster");
    expect(report(p)).toEqual([]);
  });
});
