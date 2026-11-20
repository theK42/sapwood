import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSchema } from "../schema/yaml.ts";
import { resolveSchema } from "../schema/resolve.ts";
import { loadProject } from "./load.ts";
import type { Projection } from "./project.ts";
import { classify } from "./rows.ts";
import { datetime, duration, Json, parseCell, Ref, serialToIso } from "./values.ts";

const fixture = (f: string) => readFileSync(new URL(`../../fixtures/krbsg/${f}`, import.meta.url), "utf8");
const KRBSG_SCHEMA = fixture("schema.yaml");
const KRBSG = fixture("project.yaml");

const schemaOf = (yaml: string) => resolveSchema(parseSchema(yaml).schema);

const SMALL = `
enums:
  DamageType: { members: [kinetic, energy, fire] }
structs:
  Cost: { fields: { currency: string, amount: int } }
types:
  Weapon:
    fields:
      damage: float
      cooldown: float
      kind: "enum<DamageType>"
      projectiles: "list<ref<Weapon>>"
      price: "struct<Cost>"
  GameConfig:
    singleton: true
    fields:
      maxLives: int
      startingWeapon: "ref<Weapon>"
      reviveCost: "struct<Cost>"
`;
const small = schemaOf(SMALL);

const codes = (p: Projection) => p.issues.map((i) => `${i.code}: ${i.message}`);
const entity = (p: Projection, id: string) => p.entities.find((e) => e.id === id)!;
const value = (p: Projection, id: string, field: string) => entity(p, id).fields.get(field)?.value;

describe("row classification (§6.2)", () => {
  const c = (a: string) => classify(small, a);
  it("covers every form", () => {
    expect(c("")).toEqual({ kind: "scratch" });
    expect(c("Weapon")).toEqual({ kind: "entity", type: "Weapon", active: true });
    expect(c("#Weapon")).toEqual({ kind: "entity", type: "Weapon", active: false });
    expect(c("GameConfig")).toEqual({ kind: "header", type: "GameConfig", active: true });
    expect(c("#GameConfig")).toEqual({ kind: "header", type: "GameConfig", active: false });
    expect(c(".maxLives")).toEqual({ kind: "field", type: null, path: ["maxLives"], active: true });
    expect(c(".reviveCost.amount")).toEqual({ kind: "field", type: null, path: ["reviveCost", "amount"], active: true });
    expect(c("GameConfig.maxLives")).toEqual({ kind: "field", type: "GameConfig", path: ["maxLives"], active: true });
    expect(c("#.maxLives")).toEqual({ kind: "field", type: null, path: ["maxLives"], active: false });
    expect(c("#GameConfig.maxLives")).toEqual({ kind: "field", type: "GameConfig", path: ["maxLives"], active: false });
    expect(c("# notes about weapons")).toEqual({ kind: "comment" });
    expect(c("#Weapn")).toEqual({ kind: "comment" });
    expect(c("# Weapon rows below")).toEqual({ kind: "comment" }); // a space after # makes it prose
    expect(c("# Weapon")).toEqual({ kind: "comment" });
  });

  it("anything else is an error, with a hint", () => {
    expect(c("Weapn")).toMatchObject({ kind: "error", message: expect.stringContaining('Did you mean "Weapon"') });
    expect(c("weapon")).toMatchObject({ kind: "error", message: expect.stringContaining("case-sensitive") });
    expect(c("Weapon.damage")).toMatchObject({ kind: "error", message: expect.stringContaining("isn't a singleton") });
    expect(c("Totally unrelated")).toMatchObject({ kind: "error", message: expect.stringContaining("Put # in front") });
  });
});

describe("cell parsing (§5.3)", () => {
  const p = (type: string, v: string | number | boolean | null, formula = false) => {
    const s = schemaOf(`${SMALL}\n  T: { fields: { f: "${type}" } }`);
    return parseCell(s, s.types.get("T")!.fields[0]!.def.type, v, formula);
  };
  it("numbers, bools and enums", () => {
    expect(p("int", 3)).toEqual({ ok: true, value: 3 });
    expect(p("int", 3.0000000001, true)).toEqual({ ok: true, value: 3 });
    expect(p("int", 2.5)).toMatchObject({ ok: false, message: expect.stringContaining("whole number") });
    expect(p("float", "fifty")).toMatchObject({ ok: false });
    for (const [v, want] of [[true, true], ["yes", true], ["No", false], [1, true], [0, false]] as const) expect(p("bool", v)).toEqual({ ok: true, value: want });
    expect(p("bool", "maybe")).toMatchObject({ ok: false });
    expect(p("enum<DamageType>", "fire")).toEqual({ ok: true, value: "fire" });
    expect(p("enum<DamageType>", "Fire")).toMatchObject({ ok: false, message: expect.stringContaining('did you mean "fire"') });
    expect(p("string", 12)).toEqual({ ok: true, value: "12" });
    expect(p("int", null)).toBeUndefined();
  });

  it("dates are UTC; durations are seconds", () => {
    expect(datetime("2026-11-14 18:00")).toEqual({ ok: true, value: "2026-11-14T18:00:00Z" });
    expect(datetime("2026-11-14T20:00+02:00")).toEqual({ ok: true, value: "2026-11-14T18:00:00Z" });
    expect(datetime("2026-11-14")).toEqual({ ok: true, value: "2026-11-14T00:00:00Z" });
    expect(datetime("2026-02-30")).toMatchObject({ ok: false });
    expect(serialToIso(46340.75)).toBe("2026-11-14T18:00:00Z");
    expect(p("datetime", 46340.75, true)).toEqual({ ok: true, value: "2026-11-14T18:00:00Z" });
    expect(p("datetime", 46340)).toMatchObject({ ok: false }); // a bare number typed in: ambiguous
    expect(duration("1d 2h 30m")).toEqual({ ok: true, value: 95400 });
    expect(duration("90s")).toEqual({ ok: true, value: 90 });
    expect(duration("PT1H30M")).toEqual({ ok: true, value: 5400 });
    expect(duration("1.5h")).toEqual({ ok: true, value: 5400 });
    expect(duration("250ms")).toEqual({ ok: true, value: 0.25 });
    expect(duration("soon")).toMatchObject({ ok: false });
    expect(p("duration", 0.5, true)).toEqual({ ok: true, value: 43200 }); // formulas see days
    expect(p("duration", 90)).toMatchObject({ ok: false, message: expect.stringContaining("unit") });
  });

  it("lists, structs, unions and json are JSON in one cell", () => {
    expect(p("list<ref<Weapon>>", '["a", "b"]')).toEqual({ ok: true, value: [new Ref("a"), new Ref("b")] });
    expect(p("list<ref<Weapon>>", "a")).toMatchObject({ ok: false, message: expect.stringContaining('["a", "b"]') });
    expect(p("list<int>", "[1, 2.5]")).toMatchObject({ ok: false, message: expect.stringContaining("[1]") });
    expect(p("struct<Cost>", '{"currency": "gems", "amount": 5}')).toEqual({ ok: true, value: { currency: "gems", amount: 5 } });
    expect(p("struct<Cost>", '{"curency": "gems"}')).toMatchObject({ ok: false, message: expect.stringContaining('Unknown field "curency"') });
    expect(p("json", '{"anything": [1, {}]}')).toEqual({ ok: true, value: new Json({ anything: [1, {}] }) });
    expect(p("json", "{nope")).toMatchObject({ ok: false });
  });
});

describe("KRBSG fixture", () => {
  const { project, schemaIssues } = loadProject(KRBSG_SCHEMA, KRBSG);
  const proj = project.project();

  it("loads with no schema or projection issues", () => {
    expect(schemaIssues).toEqual([]);
    expect(codes(proj)).toEqual([]);
  });

  it("has every entity of the original sheet", () => {
    const count = (type: string) => proj.entities.filter((e) => e.type === type).length;
    expect([count("Texture"), count("Shader"), count("Sprite"), count("CollisionShape"), count("Enemy"), count("PlayerShip"),
      count("Weapon"), count("Projectile"), count("FlyoffStyle"), count("Font"), count("StarfieldLayer")]).toEqual([14, 1, 11, 2, 1, 1, 1, 1, 1, 2, 3]);
    expect(proj.entities.every((e) => e.active && e.id)).toBe(true);
  });

  it("parses each field by its type", () => {
    expect(value(proj, "tex_galaxy", "isPixelArt")).toBe(false);
    expect(value(proj, "spr_ship", "texture")).toEqual(new Ref("tex_ship"));
    expect(value(proj, "spr_ship", "width")).toBe(40);
    expect(value(proj, "Blaster", "projectiles")).toEqual([new Ref("BlasterBolt")]);
    expect(value(proj, "Blaster", "cooldown")).toBe(0.5);
    expect(value(proj, "house", "shapes")).toEqual([
      { kind: "Box", size: { x: 40, y: 20 }, offset: { x: 0, y: 10 } },
      { kind: "Box", size: { x: 40, y: 20 }, offset: { x: 0, y: 10 }, rotation: 0.785 },
    ]);
    expect(value(proj, "cellphone", "glyphs")).toBe(" !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~");
    expect(value(proj, "far", "stars")).toEqual([new Ref("spr_galaxy"), new Ref("spr_galaxy2"), new Ref("spr_nebula")]);
    // Trait fields are the entity's own (§5.5).
    expect(value(proj, "BlasterBolt", "sprite")).toEqual(new Ref("spr_blaster"));
    expect(value(proj, "BlasterBolt", "collider")).toEqual(new Ref("bolt"));
  });

  it("a custom layout leaves unmapped fields out (PlayerShips has no script column)", () => {
    const ship = entity(proj, "basic_ship");
    expect([...ship.fields.keys()]).toEqual(["sprite", "collider"]);
    expect(value(proj, "basic_ship", "collider")).toEqual(new Ref("house"));
  });

  it("formulas can read entity fields through the layout", () => {
    const sheet = project.sheetId("Weapons");
    project.set(sheet, "F2", '=ENTITY("Blaster").cooldown * 4');
    expect(value(project.project(), "Blaster", "damage")).toBe(2);
    expect(entity(project.project(), "Blaster").fields.get("damage")!.formula).toBe(true);
  });
});

describe("projection details", () => {
  const load = (rows: unknown[][], layouts?: Record<string, string[]>) =>
    loadProject(SMALL, { sheets: [{ name: "S", rows, ...(layouts ? { layouts } : {}) }] }).project.project();

  it("reports unknown types, number IDs and parse errors, at the cell", () => {
    const p = load([
      ["Weapn", "x"],
      ["Weapon", 42, "lots"],
      ["#Weapon", "off", "also bad"], // inactive rows aren't validated
    ]);
    expect(codes(p)).toEqual([
      expect.stringMatching(/^row\.unknown-type: .*Did you mean "Weapon"/),
      expect.stringMatching(/^id\.not-text: .*'42/),
      expect.stringMatching(/^cell\.parse: damage: Expected a number/),
    ]);
    expect(entity(p, "off").active).toBe(false);
  });

  it("split struct columns and repeated list columns (§5.6, §6.4)", () => {
    const layout = { Weapon: ["damage", "price.currency", "price.amount", "projectiles[0]", "projectiles[1]", "projectiles[2]"] };
    const p = load([
      ["Weapon", "a", 1, "gems", 5, "b", "c"],
      ["Weapon", "b", 2, "", 3, "a"],
      ["Weapon", "c", 3, "", "", "", "a"],
    ], layout);
    expect(value(p, "a", "price")).toEqual({ currency: "gems", amount: 5 });
    expect(value(p, "a", "projectiles")).toEqual([new Ref("b"), new Ref("c")]);
    expect(value(p, "b", "price")).toEqual({ amount: 3 });
    expect(value(p, "b", "projectiles")).toEqual([new Ref("a")]); // trailing blanks trimmed
    expect(value(p, "c", "projectiles")).toBeUndefined();
    expect(codes(p)).toEqual([expect.stringMatching(/^cell\.list-gap: projectiles\[0\] is blank/)]);
  });

  it("bad layouts are refused", () => {
    expect(() => load([], { Weapon: ["damge"] })).toThrow(/no field "damge"/);
    expect(() => load([], { Weapon: ["damage.x"] })).toThrow(/isn't a struct/);
    expect(() => load([], { Weapon: ["price", "price.amount"] })).toThrow(/whole column and split columns/);
  });

  it("singletons: blocks and qualified rows (§6.8)", () => {
    const p = load([
      ["GameConfig"],
      [".maxLives", 3, "", "lives at start of a run"],
      ["", "scratch row inside the block"],
      [".reviveCost.amount", "=B2*2"],
      ["Weapon", "w1", 1],
      ["GameConfig.startingWeapon", "w1"],
      ["#GameConfig"],
      [".maxLives", 9],
      [".nope", 1],
    ]);
    const s = (path: string) => p.singletons.filter((e) => e.path.join(".") === path);
    expect(s("maxLives").map((e) => [e.value, e.active])).toEqual([[3, true], [9, false]]);
    expect(s("reviveCost.amount")[0]!.value).toBe(6);
    expect(s("reviveCost.amount")[0]!.formula).toBe(true);
    expect(s("startingWeapon")[0]).toMatchObject({ value: new Ref("w1"), qualified: true, active: true });
    expect(codes(p)).toEqual([]); // .nope is in an inactive block, so it isn't reported
    const q = load([[".maxLives", 3], ["GameConfig"], [".maxLifes", 1]]);
    expect(codes(q)).toEqual([expect.stringMatching(/^row\.field-outside-block/), expect.stringMatching(/^row\.unknown-field: GameConfig has no field "maxLifes"/)]);
  });

  it("a block ends at the next bound row, active or not", () => {
    const p = load([["GameConfig"], ["#Weapon", "w"], [".maxLives", 3]]);
    expect(codes(p)).toEqual([expect.stringMatching(/^row\.field-outside-block/)]);
  });

  it("column A can't be a formula", () => {
    expect(codes(load([['="Weapon"', "x"]]))).toEqual([expect.stringMatching(/^row\.formula-type/)]);
  });
});
