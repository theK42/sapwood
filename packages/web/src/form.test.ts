import { describe, expect, it } from "vitest";
import { loadProject, Sapwood } from "@thek42/sapwood-core";
import { aOrAn, entityAt, entityList, formOf, placing } from "./form.ts";

const schema = `structs:
  Cost: { fields: { currency: { type: "ref<Coin>" }, amount: { type: int } } }
types:
  Coin: { fields: {} }
  Item:
    fields:
      price: { type: "struct<Cost>" }
      weight: { type: float }
      double: { type: float }
      tags: { type: "list<ref<Coin>>" }
`;

const project = () =>
  loadProject(schema, {
    packs: [{ name: "dlc" }],
    sheets: [
      { name: "Items", layouts: { Item: ["price.currency", "price.amount", "weight", "double", "tags"] }, rows: [["Coin", "gold"], ["Item", "sword", "gold", 3, 2.5, "=E2*2", "[\"gold\"]"], ["#Item", "old"]] },
      { name: "More", rows: [["Item", "axe"]] },
      { name: "Notes", pack: "dlc", rows: [["Coin", "gem"]] },
    ],
  }).project;

describe("an entity as a form", () => {
  it("each field's value, with formulas and cells", () => {
    const p = project();
    const s = p.sheetId("Items");
    const sheet = p.wb.sheet(s);
    const e = entityAt(p, s, sheet.rows.idAt(2))!;
    expect(e.id).toBe("sword");
    const f = formOf(p, e);
    const by = Object.fromEntries(f.fields.map((x) => [x.def.name, x]));
    expect(by.price!.value).toEqual({ currency: "gold", amount: 3 });
    expect(by.weight!.formula).toBeNull();
    expect(by.double!.formula).toBe("=E2*2");
    expect(by.double!.value).toBe(5);
    expect(by.tags!.value).toEqual(["gold"]);
    expect(entityAt(p, s, sheet.rows.idAt(1))!.type).toBe("Coin");
    expect(entityAt(p, s, sheet.rows.idAt(3))!.active).toBe(false);
  });

  it("issues go to their field", () => {
    const p = project();
    const s = p.sheetId("Items");
    new Sapwood(p).set("sword", { price: { currency: "silver", amount: 3 } });
    const f = formOf(p, entityAt(p, s, p.wb.sheet(s).rows.idAt(2))!);
    const price = f.fields.find((x) => x.def.name === "price")!;
    expect(price.issues.length).toBe(1);
    expect(f.fields.find((x) => x.def.name === "weight")!.issues).toEqual([]);
  });
});

describe("where a new entity goes (§9.3)", () => {
  it("the only sheet with the type, a pick of several, or the type-named sheet", () => {
    const p = project();
    const root = p.wb.root;
    const dlc = [...p.wb.packs.entries()].find(([, x]) => x.name === "dlc")![0];
    const items = placing(p, "Item", root);
    expect(items.sheets.map((s) => s.name)).toEqual(["Items", "More"]);
    expect(items).toMatchObject({ pick: true, default: "Item", typeNamed: { exists: false } });
    expect(placing(p, "Coin", root)).toMatchObject({ pick: false, default: "Items" });
    // No sheet in the pack has one: the sheet named after it, made new.
    expect(placing(p, "Item", dlc)).toMatchObject({ sheets: [], pick: false, default: "Item", typeNamed: { exists: false } });
  });

  it("the form's create: a new type-named sheet, then the entity on it", () => {
    const p = project();
    const api = new Sapwood(p);
    api.apply([
      { op: "createSheet", name: "Item", pack: "dlc" },
      { op: "create", type: "Item", fields: { $id: "bow", weight: 1 }, sheet: "Item", pack: "dlc" },
    ]);
    expect(api.get("bow")).toMatchObject({ $sheet: "Item", $pack: "dlc", weight: 1 });
  });
});

describe("the entity page's list", () => {
  it("a type's entities, with where they are, issues, and a search", () => {
    const p = project();
    new Sapwood(p).set("axe", { price: { currency: "silver", amount: 1 } });
    const all = entityList(p, "Item");
    expect(all.map((e) => [e.id, e.where, e.active, e.errors])).toEqual([
      ["sword", "Items", true, 0],
      ["old", "Items", false, 0],
      ["axe", "More", true, 1],
    ]);
    expect(entityList(p, "Item", "AX").map((e) => e.id)).toEqual(["axe"]);
    expect(entityList(p, "Item", "more").map((e) => e.id)).toEqual(["axe"]); // by sheet too
    expect(entityList(p, "Coin").map((e) => e.where)).toEqual(["Items", "dlc / Notes"]);
  });
});

it("a or an before a type", () => {
  expect([aOrAn("Enemy"), aOrAn("Weapon"), aOrAn("item")]).toEqual(["an Enemy", "a Weapon", "an item"]);
});
