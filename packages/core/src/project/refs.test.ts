import { describe, expect, it } from "vitest";
import { loadProject } from "./load.ts";
import { findReferences, refsIn } from "./refs.ts";

const SCHEMA = `
structs:
  Drop: { fields: { item: "ref<Weapon>", chance: float } }
types:
  Weapon: { fields: { damage: float, next: "ref<Weapon>", shots: "list<ref<Weapon>>" } }
  Enemy: { fields: { drops: "list<struct<Drop>>" } }
  Config: { singleton: true, fields: { starter: "ref<Weapon>" } }
`;

describe("find references", () => {
  it("finds refs in fields, lists and structs, formulas and singletons, and the definition", () => {
    const { project: p } = loadProject(SCHEMA, {
      sheets: [
        {
          name: "W",
          rows: [
            ["Weapon", "blaster", 1],
            ["Weapon", "laser", 2, "Blaster", '["laser", "blaster"]'],
            ["#Weapon", "old", 3, "blaster"],
            ["Weapon", "calc", '=ENTITY("blaster").damage*2'],
            ["Config.starter", "blaster"],
          ],
        },
        { name: "E", rows: [["Enemy", "grunt", '[{"item": "blaster", "chance": 0.5}]'], ["Enemy", "boss", "[]"]] },
      ],
    });
    const u = findReferences(p, "blaster");
    expect(u.definitions.map((d) => d.id)).toEqual(["blaster"]);
    const where = (x: (typeof u.references)[number]) => `${p.wb.sheet(x.at.sheet).name} ${x.owner?.id ?? x.owner?.type} ${x.field ?? x.kind} ${x.active ? "" : "inactive"}`.trim();
    expect(u.references.map(where)).toEqual([
      "W laser next", // a different case still names it
      "W laser shots[1]",
      "W old next inactive",
      "E grunt drops[0].item",
      "W Config starter",
      "W calc formula",
    ]);
    // Each points at its own cell: laser's next (D2) and shots (E2) are two.
    const laser = u.references.filter((x) => x.owner?.id === "laser").map((x) => x.at.col);
    expect(new Set(laser).size).toBe(2);
    expect(findReferences(p, "nothing")).toEqual({ definitions: [], references: [] });
  });

  it("lists the IDs a value names", () => {
    const { project: p } = loadProject(SCHEMA, { sheets: [{ name: "W", rows: [["Weapon", "a", 1, "b", '["c", "d"]']] }] });
    const e = p.project().entities[0]!;
    expect(refsIn(e.fields.get("next")!.value)).toEqual(["b"]);
    expect(refsIn(e.fields.get("shots")!.value)).toEqual(["c", "d"]);
  });
});
