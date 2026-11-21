import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./cli.ts";
import { parseValue, parseWhere } from "./values.ts";

const SCHEMA = `
enums:
  Element: { members: [fire, ice] }
structs:
  Cost: { fields: { amount: int, currency: string } }
types:
  Weapon:
    fields:
      damage: float
      element: "enum<Element>"
      shots: "list<ref<Ammo>>"
      price: "struct<Cost>"
      released: datetime
  Ammo: { fields: { speed: float } }
  Config:
    singleton: true
    fields: { lives: int }
`;
const PROJECT = `
sheets:
  - name: Weapons
    layouts: { Weapon: [damage, element, shots, price.amount, price.currency, released] }
    rows:
      - [Weapon, w1, 10, fire, '["a1"]', 5, gold, 2026-11-14]
      - [Weapon, w2, "=C1*2", ice]
  - name: Ammo
    rows:
      - [Ammo, a1, 900]
      - [Ammo, a2, 600]
      - [Config]
      - [.lives, 3]
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A folder with the schema and project files, and a project started from them. */
function setup(init = true) {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-"));
  dirs.push(dir);
  writeFileSync(join(dir, "schema.yaml"), SCHEMA);
  writeFileSync(join(dir, "project.yaml"), PROJECT);
  const sw = (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(argv, { cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const json = (...argv: string[]) => {
    const r = sw(...argv);
    expect(r.err).toBe("");
    return JSON.parse(r.out);
  };
  const file = () => readFileSync(join(dir, "sapwood.json"), "utf8");
  if (init) expect(sw("init", "--schema", "schema.yaml", "--from", "project.yaml").code).toBe(0);
  return { dir, sw, json, file };
}

describe("the sapwood command", () => {
  it("init, get and query", () => {
    const { sw, json } = setup();
    expect(json("get", "w1")).toMatchObject({ $type: "Weapon", damage: 10, element: "fire", shots: ["a1"], price: { amount: 5, currency: "gold" } });
    expect(json("get", "w2").damage).toEqual({ $value: 20, $formula: "=C1*2" });
    expect(json("get", "Config")).toEqual({ $type: "Config", $pack: "root", lives: 3 });
    expect(sw("query", "Ammo", "--ids").out).toBe("a1\na2");
    expect(sw("query", "Weapon", "--where", "damage>15", "--ids").out).toBe("w2");
    expect(sw("query", "Weapon", "--where", "shots=a1", "--where", "price.currency~GOL", "--ids").out).toBe("w1");
    expect(sw("query", "Weapon", "--where", "released=", "--ids").out).toBe("w2");
    expect(JSON.parse(sw("query", "Ammo").out.split("\n")[1]!)).toMatchObject({ $id: "a2", speed: 600 });
    expect(sw("init").code).toBe(2); // already there
  });

  it("set types values for their fields, and saves", () => {
    const { sw, json } = setup();
    expect(sw("set", "w1", "damage=12.5", "element=ice", "shots=a1,a2", "price.amount=7", "released=2026-12-01 10:00").out).toBe("Set damage, element, shots, price, released on w1.");
    expect(json("get", "w1")).toMatchObject({ damage: 12.5, element: "ice", shots: ["a1", "a2"], price: { amount: 7, currency: "gold" }, released: "2026-12-01T10:00:00Z" });
    expect(json("get", "w2").damage.$value).toBe(25);
    sw("set", "w1", "damage==3*4", "price.currency=");
    expect(json("get", "w1")).toMatchObject({ damage: { $value: 12, $formula: "=3*4" }, price: { amount: 7 } });
    const r = sw("set", "w1", "damage=1");
    expect([r.code, r.err]).toEqual([1, expect.stringContaining("pass force to replace it [formula]")]);
    expect(sw("set", "w1", "damage=1", "--force").code).toBe(0);
    sw("set", "Config", "lives=5");
    expect(json("get", "Config").lives).toBe(5);
  });

  it("renames, comments out, deletes and creates", () => {
    const { sw, json } = setup();
    sw("set", "w1", "damage==ENTITY(\"a1\").speed");
    const r = sw("set", "a1", "$id=bolt");
    expect(r.out).toBe("Set $id on a1 (now bolt).\nFormulas that mention the old name, left as they are: Weapons!C1");
    expect(json("get", "w1").shots).toEqual(["bolt"]);
    expect(sw("comment-out", "a2").out).toBe("Commented out a2.");
    expect(sw("query", "Ammo", "--ids").out).toBe("bolt");
    sw("uncomment", "a2");
    sw("delete", "a2");
    expect(sw("get", "a2").code).toBe(1);
    expect(sw("create", "Ammo", "a3", "speed=50").out).toBe("Created Ammo a3 on Ammo.");
    expect(sw("query", "Ammo", "--ids").out).toBe("bolt\na3");
  });

  it("a project's first entity gets a sheet of its own", () => {
    const { sw, json } = setup(false);
    expect(sw("init", "--schema", "schema.yaml").out).toContain("0 entities, 0 errors");
    sw("create", "Ammo", "a1", "speed=1");
    expect(json("get", "a1").$sheet).toBe("Ammo");
  });

  it("apply runs a patch file all or nothing", () => {
    const { dir, sw, json, file } = setup();
    writeFileSync(join(dir, "p.jsonl"), ['{"op":"set","id":"w1","fields":{"damage":3}}', "", '{"op":"create","type":"Ammo","fields":{"$id":"a3","speed":1}}'].join("\n"));
    expect(sw("apply", "p.jsonl").out).toBe("Applied 2 patches.");
    expect(json("get", "a3").speed).toBe(1);
    const before = file();
    writeFileSync(join(dir, "bad.jsonl"), '{"op":"set","id":"w1","fields":{"damage":4}}\n{"op":"delete","id":"nope"}\n');
    expect(sw("apply", "bad.jsonl").code).toBe(1);
    expect(file()).toBe(before);
    writeFileSync(join(dir, "typo.jsonl"), "{op:set}\n");
    expect(sw("apply", "typo.jsonl")).toMatchObject({ code: 2, err: expect.stringContaining("typo.jsonl line 1") });
  });

  it("schema get and schema apply", () => {
    const { dir, sw, json } = setup();
    const text = sw("schema", "get").out;
    expect(text).toContain("speed: { id:");
    writeFileSync(join(dir, "edited.yaml"), text.replace("speed:", "velocity:"));
    expect(sw("schema", "apply", "edited.yaml").out).toBe("Schema updated.");
    expect(json("get", "a1").velocity).toBe(900);
    expect(sw("schema", "apply", "edited.yaml").out).toBe("The schema is unchanged.");
    writeFileSync(join(dir, "removed.yaml"), sw("schema", "get").out.replace(/\n *velocity: \{[^}]*\}/, ""));
    expect(sw("schema", "apply", "removed.yaml").err).toContain("pass force to go ahead [confirm]");
    expect(sw("schema", "apply", "removed.yaml", "--force").out).toBe("Schema updated.\nCells of removed fields, scratch now: Ammo!C1, Ammo!C2");
  });

  it("validate and export", () => {
    const { dir, sw, json } = setup();
    expect(sw("validate")).toMatchObject({ code: 0, out: "0 errors, 0 warnings." });
    expect(sw("export", "--out", "out").out).toContain("Exported 2 files");
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["manifest.json", "root.json"]);
    expect(JSON.parse(readFileSync(join(dir, "out", "root.json"), "utf8")).singletons).toEqual({ Config: { lives: 3 } });
    sw("set", "w1", "shots=nope");
    expect(sw("validate")).toEqual({ code: 1, out: 'error Weapons!E1 (w1) ref.missing: shots[0]: no entity "nope"\n1 error, 0 warnings.', err: "" });
    expect(json("validate", "--json").errors).toBe(1);
    expect(sw("export", "--out", "out2").code).toBe(1);
    expect(sw("export", "--out", "out2", "--allow-invalid").code).toBe(0);
  });

  it("finds the project above, or as given; says what was typed wrong", () => {
    const { dir, sw } = setup();
    const r = run(["get", "w1", "--project", dir], { cwd: tmpdir(), out: () => {}, err: () => {} });
    expect(r).toBe(0);
    expect(sw("get")).toMatchObject({ code: 2, err: expect.stringContaining("Expected <id>") });
    expect(sw("get", "w1", "--nope").code).toBe(2);
    expect(sw("frobnicate").code).toBe(2);
    expect(sw("set", "w1", "damage")).toMatchObject({ code: 2, err: expect.stringContaining("Expected field=value") });
    expect(sw("help").out).toContain("Usage: sapwood");
    const lost = run(["get", "w1"], { cwd: mkdtempSync(join(tmpdir(), "sapwood-none-")), out: () => {}, err: () => {} });
    expect(lost).toBe(2);
  });
});

describe("values on the command line", () => {
  it("are read for the field's type", () => {
    expect(parseValue({ kind: "float" }, "1.5")).toBe(1.5);
    expect(parseValue({ kind: "float" }, "lots")).toBe("lots"); // refused by the project, with its message
    expect(parseValue({ kind: "string" }, "12")).toBe("12");
    expect(parseValue({ kind: "string" }, '"=not a formula"')).toBe("=not a formula");
    expect(parseValue({ kind: "int" }, "=1+1")).toEqual({ $formula: "=1+1" });
    expect(parseValue({ kind: "bool" }, "TRUE")).toBe(true);
    expect(parseValue({ kind: "duration" }, "5m")).toBe("5m");
    expect(parseValue({ kind: "list", of: { kind: "int" } }, "1, 2")).toEqual([1, 2]);
    expect(parseValue({ kind: "list", of: { kind: "string" } }, '["a,b"]')).toEqual(["a,b"]);
    expect(parseValue({ kind: "string" }, "")).toBeNull();
    expect(() => parseValue({ kind: "json" }, "{oops")).toThrow(/Expected JSON/);
  });

  it("--where conditions", () => {
    const e = { $type: "W", $id: "w1", $pack: "root", $sheet: "S", $active: true, n: 5, tags: ["a", "b"], when: "2026-11-14T00:00:00Z", f: { $value: 3, $formula: "=1+2" } };
    const t = (c: string) => parseWhere(c)(e);
    expect([t("n=5"), t("n!=5"), t("n<6"), t("n>=5"), t("n>5")]).toEqual([true, false, true, true, false]);
    expect([t("tags=b"), t("tags~A"), t("tags=c")]).toEqual([true, true, false]);
    expect([t("when<2026-12-01"), t("$id=w1"), t("f=3"), t("missing="), t("missing!=")]).toEqual([true, true, true, true, false]);
    expect(() => parseWhere("n==")).not.toThrow();
    expect(() => parseWhere("5")).toThrow(/Expected field<op>value/);
  });
});
