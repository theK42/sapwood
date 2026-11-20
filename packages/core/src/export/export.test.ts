import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject, type ProjectDef } from "../project/load.ts";
import { exportJson, ExportRefused } from "./json.ts";
import { sha256 } from "./sha256.ts";

const fixture = (f: string) => readFileSync(new URL(`../../fixtures/krbsg/${f}`, import.meta.url), "utf8");
const KRBSG_SCHEMA = fixture("schema.yaml");
const KRBSG = fixture("project.yaml");
const krbsg = () => loadProject(KRBSG_SCHEMA, KRBSG).project;
const file = (files: { path: string; content: string }[], path: string) => files.find((f) => f.path === path)!.content;

describe("SHA-256", () => {
  it("matches the standard test vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("agrees with Node's crypto across block boundaries and multi-byte text", () => {
    for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      for (const text of ["a".repeat(n), "é".repeat(n), "🌲".repeat(n)])
        expect(sha256(text), `${n}`).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});

describe("M1: KRBSG export", () => {
  it("produces exactly the expected JSON", () => {
    const files = exportJson(krbsg(), { branch: "main" });
    expect(files.map((f) => f.path)).toEqual(["manifest.json", "root.json"]);
    expect(file(files, "root.json")).toBe(fixture("export/root.json"));
    expect(file(files, "manifest.json")).toBe(fixture("export/manifest.json"));
  });

  it("is deterministic, and the manifest hashes the files", () => {
    const a = exportJson(krbsg(), { branch: "main" });
    const b = exportJson(krbsg(), { branch: "main" });
    expect(a).toEqual(b);
    const manifest = JSON.parse(file(a, "manifest.json"));
    expect(manifest.packs[0].sha256).toBe(sha256(file(a, "root.json")));
  });

  it("row order on the sheet doesn't change the bytes", () => {
    const p = krbsg();
    const s = p.sheetId("Textures");
    const rows = p.wb.sheet(s).rows;
    p.move(s, "row", 2, 1, 15); // move the first texture to the end
    expect(rows.liveIds().length).toBeGreaterThan(0);
    expect(file(exportJson(p, { branch: "main" }), "root.json")).toBe(fixture("export/root.json"));
  });

  it("refs can be bare IDs (§10.2)", () => {
    const root = JSON.parse(file(exportJson(krbsg(), { refs: "id" }), "root.json"));
    expect(root.types.Weapon.Blaster.projectiles).toEqual(["BlasterBolt"]);
    expect(root.types.Sprite.spr_ship.texture).toBe("tex_ship");
  });

  it("computed values are exported, not formulas", () => {
    const p = krbsg();
    p.set(p.sheetId("Weapons"), "F2", '=ENTITY("Blaster").cooldown * 4');
    expect(JSON.parse(file(exportJson(p), "root.json")).types.Weapon.Blaster.damage).toBe(2);
  });

  it("refuses to export with validation errors, unless asked", () => {
    const p = krbsg();
    p.set(p.sheetId("Sprites"), "D2", "tex_missing");
    expect(() => exportJson(p)).toThrow(ExportRefused);
    const files = exportJson(p, { allowInvalid: true });
    expect(JSON.parse(file(files, "manifest.json")).invalid).toEqual({ errors: 1 });
    expect(JSON.parse(file(files, "root.json")).types.Sprite.spr_ship.texture).toEqual({ type: null, id: "tex_missing" });
  });
});

describe("export rules", () => {
  const schema = `
structs:
  Cost: { fields: { currency: string, amount: { type: int, default: 1 } } }
types:
  GameConfig:
    singleton: true
    fields:
      maxLives: { type: int, default: 3 }
      title: string
      reviveCost: "struct<Cost>"
      lastDay: datetime
  Weapon:
    fields:
      damage: { type: float, default: 1 }
      note: string
      cooldown: duration
  Empty: { singleton: true, fields: { x: int } }
`;
  const def: ProjectDef = {
    packs: [{ name: "zeta" }, { name: "alpha" }, { name: "deep", parent: "alpha" }],
    sheets: [
      {
        name: "Root",
        rows: [
          ["GameConfig"],
          [".title", "Sapwood"],
          [".reviveCost.currency", "gems"],
          ["GameConfig.lastDay", "2026-12-31 23:00+01:00"],
          ["Weapon", "w_b", "", "", "1m 30s"],
          ["Weapon", "w_a", 5, "sharp"],
          ["#Weapon", "w_off", 9],
          ["", "scratch", "never exported"],
        ],
      },
      { name: "Deep", pack: "deep", rows: [["Weapon", "w_deep", 2]] },
    ],
  };
  const files = exportJson(loadProject(schema, def).project, { branch: "main", commit: "c_1", exportedAt: "2026-11-19T12:00:00Z", schemaVersion: "c_0" });
  const root = JSON.parse(file(files, "root.json"));

  it("one file per pack, in tree order, with a manifest", () => {
    expect(files.map((f) => f.path)).toEqual(["manifest.json", "root.json", "alpha.json", "deep.json", "zeta.json"]);
    const m = JSON.parse(file(files, "manifest.json"));
    expect(Object.keys(m)).toEqual(["branch", "commit", "exportedAt", "schemaVersion", "packs"]);
    expect(m.packs.map((p: { name: string; parent: string | null }) => [p.name, p.parent])).toEqual([["root", null], ["alpha", "root"], ["deep", "alpha"], ["zeta", "root"]]);
    expect(JSON.parse(file(files, "deep.json"))).toEqual({ pack: "deep", parent: "alpha", commit: "c_1", types: { Weapon: { w_deep: { damage: 2 } } } });
    expect(JSON.parse(file(files, "zeta.json")).types).toEqual({});
  });

  it("blank optional fields are omitted; blanks with a default export it; inactive rows and scratch never", () => {
    expect(root.types.Weapon).toEqual({ w_a: { damage: 5, note: "sharp" }, w_b: { damage: 1, cooldown: 90 } });
    expect(Object.keys(root.types.Weapon)).toEqual(["w_a", "w_b"]); // sorted by ID
  });

  it("singletons go under their own key, rebuilt from field rows; empty ones are omitted", () => {
    expect(root.singletons).toEqual({
      GameConfig: { maxLives: 3, title: "Sapwood", reviveCost: { currency: "gems", amount: 1 }, lastDay: "2026-12-31T22:00:00Z" },
    });
  });
});
