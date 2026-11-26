import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject, Sapwood } from "@thek42/sapwood-core";
import { previewSchema } from "./schema.ts";

const fixture = (f: string) => readFileSync(new URL(`../../core/fixtures/krbsg/${f}`, import.meta.url), "utf8");
const krbsg = () => loadProject(fixture("schema.yaml"), fixture("project.yaml")).project;

describe("the schema editor's preview", () => {
  it("the same text changes nothing", () => {
    const p = krbsg();
    expect(previewSchema(p, new Sapwood(p).schemaYaml())).toMatchObject({ same: true, problems: [] });
  });

  it("text that doesn't parse or resolve: each problem", () => {
    const p = krbsg();
    const yaml = new Sapwood(p).schemaYaml().replace('type: "ref<Shader>"', 'type: "ref<Nope>"');
    const r = previewSchema(p, yaml);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toMatch(/Nope/);
  });

  it("a removed field's data, renames, and new issues; the project isn't changed", () => {
    const p = krbsg();
    const before = new Sapwood(p).schemaYaml();
    // Weapon's cooldown goes; its script becomes required on Sprite... a field every Sprite lacks.
    // (The DLC wizard stops setting it too.)
    const yaml = before.replace(/\n\s*cooldown:[^\n]*/, "").replace(/, cooldown: "\{cooldown\}"/, "").replace(/(\n(\s*)height:[^\n]*)/, "$1\n$2frames: { type: int, required: true }");
    const r = previewSchema(p, yaml);
    expect(r.problems).toEqual([]);
    expect(r.scratch.map((c) => c.sheet)).toContain("Weapons");
    expect(r.issues.some((i) => i.message.includes("frames"))).toBe(true);
    expect(new Sapwood(p).schemaYaml()).toBe(before);
  });

  it("says what it changes", () => {
    const p = krbsg();
    const yaml = new Sapwood(p).schemaYaml().replace("x: { id: f40", "px: { id: f40").replace('width:   { id: f5, type: int, min: 1 }', 'width:   { id: f5, type: float, min: 1 }');
    expect(previewSchema(p, yaml).changes).toEqual(["field Vec2.x renamed to px", "Sprite.width: type set to float"]);
  });
});
