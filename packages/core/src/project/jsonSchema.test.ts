import { describe, expect, it } from "vitest";
import { checkJsonSchema } from "./jsonSchema.ts";
import { loadProject } from "./load.ts";
import { validate } from "./validate.ts";

const said = (s: unknown, v: unknown) => checkJsonSchema(s, v).map((i) => `${i.path || "(value)"} ${i.message}`);

describe("JSON Schema for json fields", () => {
  const drop = {
    type: "object",
    required: ["item", "weight"],
    additionalProperties: false,
    properties: {
      item: { type: "string", minLength: 1 },
      weight: { type: "number", minimum: 0, maximum: 1 },
      count: { type: "integer" },
      tags: { type: "array", items: { enum: ["rare", "boss"] }, uniqueItems: true, maxItems: 2 },
    },
  };

  it("passes a good value", () => {
    expect(said(drop, { item: "gem", weight: 0.5, count: 2, tags: ["rare"] })).toEqual([]);
  });

  it("names each problem by its path", () => {
    expect(said(drop, { item: "", weight: 2, count: 1.5, tags: ["rare", "rare", "epic"], extra: 1 })).toEqual([
      ".item must be at least 1 character",
      ".weight must be at most 1",
      ".count must be a whole number, not 1.5",
      ".tags allows at most 2 items",
      '.tags has "rare" twice, but must be unique',
      '.tags[2] must be one of "rare", "boss"',
      ".extra isn't a known key",
    ]);
    expect(said(drop, {})).toEqual([".item is required", ".weight is required"]);
    expect(said(drop, [1])).toEqual(["(value) must be an object, not [1]"]);
  });

  it("anyOf passes on any option, and otherwise says the closest one's problems", () => {
    const s = { anyOf: [{ type: "string" }, { type: "object", required: ["id"] }] };
    expect(said(s, "a")).toEqual([]);
    expect(said(s, { id: 1 })).toEqual([]);
    expect(said(s, {})).toEqual([".id is required"]);
  });

  it("ignores what it doesn't know, and true allows anything", () => {
    expect(said({ $ref: "#/x", format: "email" }, 5)).toEqual([]);
    expect(said(true, 5)).toEqual([]);
    expect(said({ properties: { a: false } }, { a: 1 })).toEqual([".a isn't allowed here"]);
  });

  it("validation reports them on the cell, after the field's name", () => {
    const schema = `types:
  Loot:
    fields:
      drop: { type: json, jsonSchema: { type: object, required: [item], properties: { item: { type: string } } } }
      free: { type: json }
`;
    const p = loadProject(schema, { sheets: [{ name: "Loot", rows: [["Loot", "a", '{"item": 3}', '{"anything": true}'], ["Loot", "b", "{}"]] }] }).project;
    expect(validate(p).issues.map((i) => `${i.code}: ${i.message}`)).toEqual(["field.schema: drop.item: must be text, not 3", "field.schema: drop.item is required"]);
  });
});
