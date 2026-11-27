import { describe, expect, it } from "vitest";
import { loadProject, Sapwood, type Entity, type Project } from "@thek42/sapwood-core";
import { canon, differing, markAll, multiFormOf, setAll } from "./multi.ts";

const schema = `structs:
  Cost: { fields: { amount: { type: int }, coin: { type: string } } }
types:
  Item:
    fields:
      price: { type: "struct<Cost>" }
      weight: { type: float, min: 0 }
      double: { type: float }
      rare: { type: bool }
  Other: { fields: { note: string } }
`;

const project = () =>
  loadProject(schema, {
    sheets: [
      {
        name: "Items",
        layouts: { Item: ["price", "weight", "double", "rare"] },
        rows: [
          ["Item", "sword", '{"amount":3,"coin":"gold"}', 2.5, "=D1*2", "TRUE"],
          ["Item", "axe", '{"coin":"gold","amount":3}', 4, 1, "TRUE"],
          ["Item", "bow", '{"amount":5,"coin":"gold"}', -1, "=D3*2"],
          ["Other", "o1", "hi"],
        ],
      },
    ],
  }).project;

const pick = (p: Project, ...ids: string[]) => ids.map((id) => p.project().entities.find((e) => e.id === id)!) as Entity[];

describe("several entities as one form", () => {
  it("shared values, differing ones, formulas and issues", () => {
    const p = project();
    const f = multiFormOf(p, pick(p, "sword", "axe", "bow"));
    expect(f.type).toBe("Item");
    const by = (n: string) => f.fields.find((x) => x.def.name === n)!;
    // Key order doesn't make values differ.
    expect(by("price")).toMatchObject({ same: false, values: [{ amount: 3, coin: "gold" }, { amount: 5, coin: "gold" }] });
    expect(multiFormOf(p, pick(p, "sword", "axe")).fields.find((x) => x.def.name === "price")).toMatchObject({ same: true, value: { amount: 3, coin: "gold" } });
    expect(by("weight")).toMatchObject({ same: false, values: [2.5, 4, -1], withIssues: 1 });
    expect(by("double")).toMatchObject({ same: false, computed: ["sword", "bow"] });
    expect(by("rare")).toMatchObject({ same: false, values: [true, undefined] });
    expect([f.errors, f.inactive, f.kept]).toEqual([1, 0, 0]);
    // Of different types: no fields.
    expect(multiFormOf(p, pick(p, "sword", "o1"))).toMatchObject({ type: null, fields: [] });
  });

  it("setting a field writes it to each, as one change, leaving formulas alone", () => {
    const p = project();
    const s = new Sapwood(p);
    const items = pick(p, "sword", "axe", "bow");
    const double = multiFormOf(p, items).fields.find((x) => x.def.name === "double")!;
    const change = s.apply(setAll(items, "double", 9, double.computed));
    expect(s.get("axe").double).toBe(9);
    expect(s.get("sword").double).toMatchObject({ $formula: "=D1*2" });
    s.apply(setAll(items, "weight", 1));
    expect(items.map((e) => s.get(e.id!).weight)).toEqual([1, 1, 1]);
    expect(multiFormOf(p, pick(p, "sword", "axe", "bow")).errors).toBe(0);
    // Blank for all.
    s.apply(setAll(items, "rare", undefined));
    expect(items.map((e) => s.get(e.id!).rare)).toEqual([undefined, undefined, undefined]);
    expect(change.ops.length).toBeGreaterThan(0);
    // One undo step takes back one whole write.
    s.undo();
    expect(items.map((e) => s.get(e.id!).rare)).toEqual([true, true, undefined]);
  });

  it("commenting out, uncommenting and the don't-suggest mark for all", () => {
    const p = project();
    const s = new Sapwood(p);
    s.apply(markAll(pick(p, "sword", "axe"), "active", false));
    let f = multiFormOf(p, pick(p, "sword", "axe", "bow"));
    expect(f.inactive).toBe(2);
    // Only those not yet so are written.
    expect(markAll(f.entities, "active", false).map((x) => (x as { id: string }).id)).toEqual(["bow"]);
    s.apply(markAll(f.entities, "active", true));
    s.apply(markAll(pick(p, "sword", "bow"), "keepHere", true));
    f = multiFormOf(p, pick(p, "sword", "axe", "bow"));
    expect([f.inactive, f.kept]).toEqual([0, 2]);
  });

  it("says how they differ, briefly", () => {
    const show = (v: unknown) => String(v);
    expect(differing([1, 2], show)).toBe("1 and 2");
    expect(differing([1, undefined, 3], show)).toBe("1, blank and 3");
    expect(differing([1, 2, 3, 4, 5], show)).toBe("1, 2, 3 and 2 more");
    expect(differing([1, 2, 3, 4], show)).toBe("1, 2, 3 and 4");
    expect(canon({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canon({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
});
