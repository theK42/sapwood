import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatType, parseType, TypeSyntaxError } from "./model.ts";
import { refAccepts, resolveSchema } from "./resolve.ts";
import { formatSchema, parseSchema } from "./yaml.ts";

const KRBSG = readFileSync(new URL("../../fixtures/krbsg/schema.yaml", import.meta.url), "utf8");

/** Parse and resolve; return every issue as "path: message". */
function problems(yaml: string): string[] {
  const { schema, issues } = parseSchema(yaml);
  return [...issues, ...resolveSchema(schema).issues].map((i) => `${i.path}: ${i.message}`);
}
const has = (list: string[], path: string, text: string) =>
  expect(list.some((p) => p.startsWith(path + ":") && p.includes(text)), `${path} ~ ${text}\n${list.join("\n")}`).toBe(true);

describe("type expressions", () => {
  it("parse and format round-trip", () => {
    for (const t of ["string", "int", "float", "bool", "datetime", "duration", "json", "enum<DamageType>", "ref<Projectile>",
      "ref<Enemy|PlayerShip>", "ref<any>", "list<ref<Sprite>>", "struct<Cost>", "union<Shape>", "list<union<Condition>>"])
      expect(formatType(parseType(t))).toBe(t);
    expect(formatType(parseType(" list < ref < A | B > > "))).toBe("list<ref<A|B>>");
  });

  it("reject what isn't a type", () => {
    for (const t of ["", "list", "list<>", "list<list<int>>", "ref<any|A>", "map<string>", "int<3>", "ref<A", "string extra"])
      expect(() => parseType(t), t).toThrow(TypeSyntaxError);
  });
});

describe("YAML text form", () => {
  it("the KRBSG schema parses and resolves with no issues", () => {
    expect(problems(KRBSG)).toEqual([]);
  });

  it("prints deterministically and reads back the same", () => {
    const { schema } = parseSchema(KRBSG);
    const text = formatSchema(schema);
    expect(parseSchema(text).schema).toEqual(schema);
    expect(formatSchema(parseSchema(text).schema)).toBe(text);
  });

  it("keeps IDs, and gives fresh ones to items written without", () => {
    const { schema, issues } = parseSchema(`
types:
  Weapon:
    id: t1
    fields:
      damage: { id: f1, type: float }
      range: { type: float }
  Shield: { fields: { hp: int } }
`);
    expect(issues).toEqual([]);
    const ids = [schema.types[0]!.id, ...schema.types[0]!.fields.map((f) => f.id), schema.types[1]!.id, schema.types[1]!.fields[0]!.id];
    expect(ids[0]).toBe("t1");
    expect(ids[1]).toBe("f1");
    expect(new Set(ids).size).toBe(ids.length); // fresh ones don't collide with t1 or f1
  });

  it("a rename in the text is a rename: the ID stays", () => {
    const before = parseSchema(`types:\n  Weapon: { id: t1, fields: { dmg: { id: f1, type: float } } }`).schema;
    const after = parseSchema(`types:\n  Gun: { id: t1, fields: { damage: { id: f1, type: float } } }`).schema;
    expect(after.types[0]!.id).toBe(before.types[0]!.id);
    expect(after.types[0]!.fields[0]!.id).toBe(before.types[0]!.fields[0]!.id);
  });

  it("quotes only what needs quoting", () => {
    const text = formatSchema(parseSchema(`enums:\n  Answer: { id: e1, members: [yes, no, "maybe so", "3"] }`).schema);
    expect(text).toContain('members: ["yes", "no", "maybe so", "3"]');
    expect(parseSchema(text).schema.enums[0]!.members.map((m) => m.name)).toEqual(["yes", "no", "maybe so", "3"]);
  });

  it("an item with no ID is written without one, and read back with a new one", () => {
    const s = parseSchema(`types:
  Weapon: { id: t1, fields: { dmg: { id: f1, type: float } } }`).schema;
    s.types.push({ id: "", name: "Boss", traits: [], fields: [] });
    s.types[0]!.fields.push({ id: "", name: "speed", type: { kind: "int" } });
    s.enums.push({ id: "", name: "Mood", members: [{ name: "calm" }] });
    s.rules.push({ id: "", severity: "warning", expr: "=1", message: "m" });
    const text = formatSchema(s);
    expect(text).toContain("  Boss: {}");
    expect(text).toContain("speed: { type: int }");
    const back = parseSchema(text, { existing: parseSchema(`types:
  Weapon: { id: t1, fields: { dmg: { id: f1, type: float } } }`).schema });
    expect(back.issues).toEqual([]);
    expect([back.schema.types[1]!.name, back.schema.types[1]!.id === "", back.schema.enums[0]!.id === "", back.schema.rules[0]!.id === ""]).toEqual(["Boss", false, false, false]);
  });

  it("reports text problems with a path", () => {
    const list = problems(`
types:
  Weapon:
    id: t1
    colour: red
    fields:
      damage: { type: flaot }
      cooldown: { type: float, min: fast }
      script: { type: string, required: "yes" }
widgets: {}
`);
    has(list, "types.Weapon.colour", 'Unknown property "colour"');
    has(list, "types.Weapon.fields.damage.type", 'unknown type "flaot"');
    has(list, "types.Weapon.fields.cooldown", "min and max must be numbers");
    has(list, "types.Weapon.fields.script.required", "true/false");
    has(list, "widgets", 'Unknown section "widgets"');
  });

  it("reports duplicate keys and broken YAML instead of throwing", () => {
    expect(problems("types:\n  A: {}\n  A: {}\n").length).toBeGreaterThan(0);
    expect(problems("types: [unclosed").length).toBeGreaterThan(0);
  });
});

describe("resolution", () => {
  const krbsg = resolveSchema(parseSchema(KRBSG).schema);

  it("flattens traits: trait fields first, then the type's own", () => {
    expect(krbsg.types.get("Projectile")!.fields.map((f) => `${f.def.name}<${f.from}`)).toEqual([
      "sprite<trait Visual",
      "script<trait Visual",
      "collider<trait Collidable",
    ]);
    expect([...krbsg.types.get("Enemy")!.traits].sort()).toEqual(["Collidable", "Visual"]);
  });

  it("ref<Trait> accepts every type that has it, directly or through another trait", () => {
    expect(refAccepts(krbsg, ["Visual"], "Enemy")).toBe(true);
    expect(refAccepts(krbsg, ["Visual"], "Weapon")).toBe(false);
    expect(refAccepts(krbsg, ["Weapon"], "Weapon")).toBe(true);
    expect(refAccepts(krbsg, "any", "Sprite")).toBe(true);
  });

  it("a trait included by two paths contributes its fields once", () => {
    expect(problems(`
traits:
  A: { fields: { a: int } }
  B: { traits: [A] }
  C: { traits: [A] }
types:
  T: { traits: [B, C], fields: { t: int } }
`)).toEqual([]);
  });

  it("field names may not collide across a type and its traits", () => {
    has(problems(`
traits:
  A: { fields: { hp: int } }
types:
  T: { traits: [A], fields: { hp: float } }
`), "types.T", 'Field "hp" comes from both trait A and T');
  });

  it("trait cycles are reported once", () => {
    const list = problems(`
traits:
  A: { traits: [B] }
  B: { traits: [C] }
  C: { traits: [A] }
types:
  T: { traits: [A] }
`);
    expect(list.filter((p) => p.includes("cycle"))).toHaveLength(1);
    has(list, "traits.A.traits", "A → B → C → A");
  });

  it("checks every name a type expression uses", () => {
    const list = problems(`
enums:
  Colour: { members: [red] }
structs:
  Cost: { fields: { amount: int } }
types:
  Config: { singleton: true, fields: { lives: int } }
  T:
    fields:
      a: "enum<Cost>"
      b: "struct<Nope>"
      c: "ref<Config>"
      d: "ref<Colour>"
      e: "union<Cost>"
      f: "list<ref<Ghost>>"
`);
    has(list, "types.T.fields.a.type", '"Cost" is a struct, not a enum');
    has(list, "types.T.fields.b.type", 'Unknown struct "Nope"');
    has(list, "types.T.fields.c.type", "singleton");
    has(list, "types.T.fields.d.type", "refs point at types or traits");
    has(list, "types.T.fields.e.type", "not a union");
    has(list, "types.T.fields.f.type", 'Unknown type or trait "Ghost"');
  });

  it("one namespace for all names, one for all IDs", () => {
    const list = problems(`
enums:
  Weapon: { id: x1, members: [a] }
types:
  Weapon: { id: x2, fields: { f: { id: x1, type: int } } }
  my.type: { fields: {} }
`);
    has(list, "types.Weapon", 'already used by a enum');
    has(list, "types.Weapon.fields.f", 'ID "x1" is already used by enums.Weapon');
    has(list, "types.my.type", "isn't a valid name");
  });

  it("constraints must fit the field type", () => {
    const list = problems(`
enums:
  E: { members: [a, b] }
types:
  T:
    fields:
      a: { type: string, min: 1 }
      b: { type: int, minItems: 2 }
      c: { type: float, reach: descendants }
      d: { type: int, min: 5, max: 1 }
      e: { type: int, required: true, default: 3 }
      f: { type: "enum<E>", default: c }
      g: { type: "list<int>", default: 1 }
      h: { type: int, default: 1.5 }
      i: { type: string, pattern: "([" }
      j: { type: "list<ref<T>>", reach: descendants, minItems: 1, unique: true }
`);
    has(list, "types.T.fields.a.min", "only applies to int, float");
    has(list, "types.T.fields.b.minItems", "only applies to list");
    has(list, "types.T.fields.c.reach", "only applies to ref");
    has(list, "types.T.fields.d", "min (5) is greater than max (1)");
    has(list, "types.T.fields.e", "both required and have a default");
    has(list, "types.T.fields.f.default", "a member of E");
    has(list, "types.T.fields.g.default", "can't have a default");
    has(list, "types.T.fields.h.default", "a whole number");
    has(list, "types.T.fields.i.pattern", "Not a valid regular expression");
    expect(list.some((p) => p.startsWith("types.T.fields.j"))).toBe(false);
  });

  it("unions: variants are structs, and the discriminator is free", () => {
    const list = problems(`
structs:
  Box: { fields: { kind: string } }
  Circle: { fields: { radius: float } }
enums:
  E: { members: [a] }
unions:
  Shape: { variants: [Box, Circle, E] }
  Empty: { variants: [] }
`);
    has(list, "unions.Shape.variants", 'Struct "Box" has a field named "kind"');
    has(list, "unions.Shape.variants", '"E" is a enum');
    has(list, "unions.Empty.variants", "at least one variant");
  });

  it("recursive unions through struct fields are fine (§5.6)", () => {
    expect(problems(`
structs:
  HasItem: { fields: { item: string } }
  AllOf: { fields: { conditions: "list<union<Condition>>" } }
  Not: { fields: { condition: "union<Condition>" } }
unions:
  Condition: { variants: [HasItem, AllOf, Not] }
types:
  Quest: { fields: { requires: "union<Condition>" } }
`)).toEqual([]);
  });

  it("singletons: pack only on singletons; rules name a type or trait", () => {
    const list = problems(`
types:
  GameConfig: { singleton: true, pack: root, fields: { lives: int } }
  Weapon: { pack: root, fields: {} }
rules:
  - { type: Ghost, expr: "=1", message: m }
  - { expr: "1", message: m }
`);
    has(list, "types.Weapon.pack", "only applies to singletons");
    has(list, "rules.r1.type", 'Unknown type or trait "Ghost"');
    has(list, "rules.1.expr", 'starting with "="');
  });
});
