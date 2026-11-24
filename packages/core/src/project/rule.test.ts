import { describe, expect, it } from "vitest";
import { loadProject } from "./load.ts";
import { checkRule } from "./validate.ts";

const p = () =>
  loadProject(`types:\n  Weapon: { fields: { cooldown: float } }\n  Ammo: { fields: { speed: float } }\n`, {
    sheets: [{ name: "W", rows: [["Weapon", "w1", 0.4], ["Weapon", "w2", 0.9], ["#Weapon", "w3", 0], ["Ammo", "a1", 5]] }],
  }).project;

describe("checking one rule (§5.7)", () => {
  it("a per-entity rule: which active entities of its type it flags", () => {
    const r = checkRule(p(), { id: "x", type: "Weapon", severity: "warning", expr: "=cooldown >= 0.5", message: "too fast" });
    expect(r.checked).toBe(2);
    expect(r.issues.map((i) => [i.level, i.code, i.message])).toEqual([["warning", "rule", "too fast"]]);
    expect(r.entities.map((e) => e?.id)).toEqual(["w1"]);
  });

  it("a global rule runs once", () => {
    expect(checkRule(p(), { id: "g", severity: "error", expr: '=COUNTA(ENTITIES("Weapon")) < 2', message: "too many" })).toMatchObject({ checked: 1, entities: [null] });
  });

  it("an expression that doesn't read, or can't be checked, says why", () => {
    expect(checkRule(p(), { id: "b", type: "Weapon", severity: "error", expr: "=cooldown >=", message: "m" }).issues[0]!.code).toBe("rule.invalid");
    const r = checkRule(p(), { id: "c", type: "Weapon", severity: "error", expr: "=nope > 1", message: "m" });
    expect(r.issues.length).toBe(2);
    expect(r.issues[0]!.code).toMatch(/^rule\.(invalid|error)$/);
  });
});
