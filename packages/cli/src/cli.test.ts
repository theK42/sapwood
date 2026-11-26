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
async function setup(init = true) {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-"));
  dirs.push(dir);
  writeFileSync(join(dir, "schema.yaml"), SCHEMA);
  writeFileSync(join(dir, "project.yaml"), PROJECT);
  const env = { SAPWOOD_CONFIG: join(dir, "config.json") };
  const sw = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { cwd: dir, env, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const json = async (...argv: string[]) => {
    const r = await sw(...argv);
    expect(r.err).toBe("");
    return JSON.parse(r.out);
  };
  const file = () => readFileSync(join(dir, "sapwood.json"), "utf8");
  if (init) expect((await sw("init", "--schema", "schema.yaml", "--from", "project.yaml")).code).toBe(0);
  return { dir, env, sw, json, file };
}

describe("the sapwood command", () => {
  it("init, get and query", async () => {
    const { sw, json } = (await setup());
    expect((await json("get", "w1"))).toMatchObject({ $type: "Weapon", damage: 10, element: "fire", shots: ["a1"], price: { amount: 5, currency: "gold" } });
    expect((await json("get", "w2")).damage).toEqual({ $value: 20, $formula: "=C1*2" });
    expect((await json("get", "Config"))).toEqual({ $type: "Config", $pack: "root", lives: 3 });
    expect((await sw("query", "Ammo", "--ids")).out).toBe("a1\na2");
    expect((await sw("query", "Weapon", "--where", "damage>15", "--ids")).out).toBe("w2");
    expect((await sw("query", "Weapon", "--where", "shots=a1", "--where", "price.currency~GOL", "--ids")).out).toBe("w1");
    expect((await sw("query", "Weapon", "--where", "released=", "--ids")).out).toBe("w2");
    expect(JSON.parse((await sw("query", "Ammo")).out.split("\n")[1]!)).toMatchObject({ $id: "a2", speed: 600 });
    expect((await sw("init")).code).toBe(2); // already there
  });

  it("makes packs and sheets, and entities on them", async () => {
    const { sw, json } = await setup();
    expect((await sw("pack", "create", "dlc")).out).toBe("Made pack dlc.");
    expect((await sw("pack", "create", "dlc2", "--parent", "dlc")).out).toBe("Made pack dlc2 in dlc.");
    expect((await sw("sheet", "create", "DLC Ammo", "--pack", "dlc")).out).toBe("Made sheet DLC Ammo in pack dlc.");
    expect((await sw("sheet", "create", "Notes", "--pack", "dlc", "--scratch")).out).toBe("Made scratch sheet Notes in pack dlc.");
    expect((await sw("create", "Ammo", "a9", "speed=50", "--sheet", "DLC Ammo", "--pack", "dlc")).out).toBe("Created Ammo a9 on DLC Ammo.");
    expect(await json("get", "a9")).toMatchObject({ $pack: "dlc", $sheet: "DLC Ammo", speed: 50 });
    const again = await sw("pack", "create", "dlc");
    expect(again.code).toBe(1);
    expect(again.err).toContain("There's a pack called dlc already");
    expect((await sw("pack", "list")).code).toBe(2);
  });

  it("moves entities to another pack, saying first what that breaks", async () => {
    const { sw, json } = await setup();
    await sw("pack", "create", "dlc");
    const dry = await sw("move", "a1", "--to", "dlc", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Would move a1 to dlc (Ammo)");
    expect(dry.out).toContain("w1.shots names a1, and won't reach it there: move w1 too to mend it");
    expect((await json("get", "a1")).$pack).toBe("root");
    const real = await sw("move", "a1", "w1", "--to", "dlc");
    expect(real.out).toContain("Moved 2 entities.");
    expect(await json("get", "a1")).toMatchObject({ $pack: "dlc", $sheet: "Ammo" });
    expect(await json("get", "w1")).toMatchObject({ $pack: "dlc", $sheet: "Weapon" });
    expect((await sw("move", "a1", "--to", "dlc")).out).toContain("Nothing to move");
    expect((await sw("move", "a1")).code).toBe(2);
  });

  it("suggests moves down the tree, and leaves a marked entity out", async () => {
    const { sw, json } = await setup();
    await sw("pack", "create", "dlc");
    expect((await sw("suggest-moves")).out).toContain("No suggestions");
    await sw("move", "w1", "--to", "dlc"); // now only dlc's w1 uses a1
    expect((await sw("suggest-moves")).out).toContain("a1 (Ammo): root → dlc, used by w1");
    expect((await sw("set", "a1", "$keepHere=true")).code).toBe(0);
    expect((await json("get", "a1")).$keepHere).toBe(true);
    expect((await sw("suggest-moves")).out).toContain("No suggestions");
  });

  it("lists and runs wizards, showing first what they make", async () => {
    const { sw, json, dir } = await setup();
    const wizard = `
wizards:
  Pair:
    title: A weapon and its ammo
    params:
      key: { type: string, required: true }
      speeds: { type: "list<float>" }
    sheet: Weapons
    rows:
      - { type: Ammo, id: "{key}_ammo", name: ammo, forEach: speeds, as: s, fields: { speed: "{s.value}" } }
      - { type: Weapon, id: "{key}", fields: { damage: 3, shots: "{ammo.ids}" } }
`;
    writeFileSync(join(dir, "with-wizard.yaml"), SCHEMA + wizard);
    expect((await sw("schema", "apply", "with-wizard.yaml")).code).toBe(0);
    expect((await sw("wizard", "list")).out).toBe(["Pair — A weapon and its ammo", "  key: string (required)", "  speeds: list<float>"].join("\n"));
    const dry = await sw("wizard", "run", "Pair", "key=rifle", "speeds=[700]", "--dry-run");
    expect(dry.err).toBe("");
    expect(dry.out).toContain("Would make Ammo rifle_ammo at Weapons!A3");
    expect(dry.out).toContain("Would make Weapon rifle at Weapons!A4");
    expect((await sw("wizard", "run", "Pair", "key=rifle", "speeds=[700]")).out).toContain("Made 2 entities.");
    expect(await json("get", "rifle_ammo")).toMatchObject({ speed: 700 });
    expect(await json("get", "rifle")).toMatchObject({ damage: 3, shots: ["rifle_ammo"] });
    const bad = await sw("wizard", "run", "Pair");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("key is required");
  });

  it("renames and moves packs and sheets", async () => {
    const { sw, json } = await setup();
    await sw("pack", "create", "dlc");
    await sw("pack", "create", "extra");
    expect((await sw("pack", "rename", "dlc", "season1")).out).toBe("Renamed pack dlc to season1.");
    expect((await sw("pack", "move", "extra", "season1")).out).toBe("Moved pack extra into season1.");
    const bad = await sw("pack", "move", "season1", "extra");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("can't go inside itself");
    expect((await sw("sheet", "rename", "Ammo", "Bullets")).out).toBe("Renamed sheet Ammo to Bullets.");
    expect((await sw("sheet", "move", "Bullets", "season1")).out).toBe("Moved sheet Bullets into season1.");
    expect(await json("get", "a1")).toMatchObject({ $pack: "season1", $sheet: "Bullets" });
    expect((await sw("sheet", "rename", "Bullets", "Shots", "--pack", "season1")).code).toBe(0);
    // w1's shots refer to a1, now in a pack root can't reach.
    const v = await sw("validate");
    expect(v.code).toBe(1);
    expect(v.out + v.err).toMatch(/a1/);
  });

  it("set types values for their fields, and saves", async () => {
    const { sw, json } = (await setup());
    expect((await sw("set", "w1", "damage=12.5", "element=ice", "shots=a1,a2", "price.amount=7", "released=2026-12-01 10:00")).out).toBe("Set damage, element, shots, price, released on w1.");
    expect((await json("get", "w1"))).toMatchObject({ damage: 12.5, element: "ice", shots: ["a1", "a2"], price: { amount: 7, currency: "gold" }, released: "2026-12-01T10:00:00Z" });
    expect((await json("get", "w2")).damage.$value).toBe(25);
    (await sw("set", "w1", "damage==3*4", "price.currency="));
    expect((await json("get", "w1"))).toMatchObject({ damage: { $value: 12, $formula: "=3*4" }, price: { amount: 7 } });
    const r = (await sw("set", "w1", "damage=1"));
    expect([r.code, r.err]).toEqual([1, expect.stringContaining("pass force to replace it [formula]")]);
    expect((await sw("set", "w1", "damage=1", "--force")).code).toBe(0);
    expect(await sw("set", "Config", "lives=5")).toMatchObject({ code: 0, err: "" });
    expect((await json("get", "Config")).lives).toBe(5);
  });

  it("renames, comments out, deletes and creates", async () => {
    const { sw, json } = (await setup());
    (await sw("set", "w1", "damage==ENTITY(\"a1\").speed"));
    const r = (await sw("set", "a1", "$id=bolt"));
    expect(r.out).toBe("Set $id on a1 (now bolt).\nFormulas that mention the old name, left as they are: Weapons!C1");
    expect((await json("get", "w1")).shots).toEqual(["bolt"]);
    expect((await sw("comment-out", "a2")).out).toBe("Commented out a2.");
    expect((await sw("query", "Ammo", "--ids")).out).toBe("bolt");
    (await sw("uncomment", "a2"));
    (await sw("delete", "a2"));
    expect((await sw("get", "a2")).code).toBe(1);
    expect((await sw("create", "Ammo", "a3", "speed=50")).out).toBe("Created Ammo a3 on Ammo.");
    expect((await sw("query", "Ammo", "--ids")).out).toBe("bolt\na3");
  });

  it("a project's first entity gets a sheet of its own", async () => {
    const { sw, json } = (await setup(false));
    expect((await sw("init", "--schema", "schema.yaml")).out).toContain("0 entities, 0 errors");
    expect(await sw("create", "Ammo", "a1", "speed=1")).toMatchObject({ code: 0, err: "" });
    expect((await json("get", "a1")).$sheet).toBe("Ammo");
  });

  it("apply runs a patch file all or nothing", async () => {
    const { dir, sw, json, file } = (await setup());
    writeFileSync(join(dir, "p.jsonl"), ['{"op":"set","id":"w1","fields":{"damage":3}}', "", '{"op":"create","type":"Ammo","fields":{"$id":"a3","speed":1}}'].join("\n"));
    expect((await sw("apply", "p.jsonl")).out).toBe("Applied 2 patches.");
    expect((await json("get", "a3")).speed).toBe(1);
    const before = file();
    writeFileSync(join(dir, "bad.jsonl"), '{"op":"set","id":"w1","fields":{"damage":4}}\n{"op":"delete","id":"nope"}\n');
    expect((await sw("apply", "bad.jsonl")).code).toBe(1);
    expect(file()).toBe(before);
    writeFileSync(join(dir, "typo.jsonl"), "{op:set}\n");
    expect((await sw("apply", "typo.jsonl"))).toMatchObject({ code: 2, err: expect.stringContaining("typo.jsonl line 1") });
  });

  it("schema get and schema apply", async () => {
    const { dir, sw, json } = (await setup());
    const text = (await sw("schema", "get")).out;
    expect(text).toContain("speed: { id:");
    writeFileSync(join(dir, "edited.yaml"), text.replace("speed:", "velocity:"));
    expect((await sw("schema", "apply", "edited.yaml")).out).toBe("Schema updated.");
    expect((await json("get", "a1")).velocity).toBe(900);
    expect((await sw("schema", "apply", "edited.yaml")).out).toBe("The schema is unchanged.");
    writeFileSync(join(dir, "removed.yaml"), (await sw("schema", "get")).out.replace(/\n *velocity: \{[^}]*\}/, ""));
    expect((await sw("schema", "apply", "removed.yaml")).err).toContain("pass force to go ahead [confirm]");
    expect((await sw("schema", "apply", "removed.yaml", "--force")).out).toBe("Schema updated.\nCells of removed fields, scratch now: Ammo!C1, Ammo!C2");
  });

  it("validate and export", async () => {
    const { dir, sw, json } = (await setup());
    expect((await sw("validate"))).toMatchObject({ code: 0, out: "0 errors, 0 warnings." });
    expect((await sw("export", "--out", "out")).out).toContain("Exported 2 files");
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["manifest.json", "root.json"]);
    expect(JSON.parse(readFileSync(join(dir, "out", "root.json"), "utf8")).singletons).toEqual({ Config: { lives: 3 } });
    (await sw("set", "w1", "shots=nope"));
    expect((await sw("validate"))).toEqual({ code: 1, out: 'error Weapons!E1 (w1) ref.missing: shots[0]: no entity "nope"\n1 error, 0 warnings.', err: "" });
    expect((await json("validate", "--json")).errors).toBe(1);
    expect((await sw("export", "--out", "out2")).code).toBe(1);
    expect((await sw("export", "--out", "out2", "--allow-invalid")).code).toBe(0);
  });

  it("finds the project above, or as given; says what was typed wrong", async () => {
    const { dir, sw } = (await setup());
    const r = (await run(["get", "w1", "--project", dir], { cwd: tmpdir(), env: { SAPWOOD_CONFIG: join(dir, "none.json") }, out: () => {}, err: () => {} }));
    expect(r).toBe(0);
    expect((await sw("get"))).toMatchObject({ code: 2, err: expect.stringContaining("Expected <id>") });
    expect((await sw("get", "w1", "--nope")).code).toBe(2);
    expect((await sw("frobnicate")).code).toBe(2);
    expect((await sw("set", "w1", "damage"))).toMatchObject({ code: 2, err: expect.stringContaining("Expected field=value") });
    expect((await sw("help")).out).toContain("Usage: sapwood");
    const lost = (await run(["get", "w1"], { cwd: mkdtempSync(join(tmpdir(), "sapwood-none-")), env: { SAPWOOD_CONFIG: join(dir, "none.json") }, out: () => {}, err: () => {} }));
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
