import { describe, expect, it } from "vitest";
import { Sapwood } from "@thek42/sapwood-core";
import { entityDiff, restoreFields } from "./historyView.ts";

const s = () => Sapwood.load(`types:\n  W: { fields: { damage: float, twice: float, tags: "list<string>" } }\n`, { sheets: [{ name: "S", rows: [["W", "w1", 10, "=C1*2", '["a"]']] }] });

describe("entity history, shown and restored", () => {
  it("what changed, where and its ID first", () => {
    const a = s();
    const before = a.get("w1");
    a.set("w1", { damage: 12, tags: null, $id: "w9", $active: false });
    expect(entityDiff(before, a.get("w9"))).toEqual([
      { field: "id", before: "w1", after: "w9" },
      { field: "active", before: "active", after: "commented out" },
      { field: "damage", before: "10", after: "12" },
      { field: "twice", before: "=C1*2 (20)", after: "=C1*2 (24)" },
      { field: "tags", before: '["a"]', after: null },
    ]);
    expect(entityDiff(null, before)[0]).toEqual({ field: "id", before: null, after: "w1" });
  });

  it("put back as it was, formulas as formulas", () => {
    const a = s();
    const was = a.get("w1");
    a.set("w1", { damage: 1, twice: 3, tags: ["b"], $active: false }, { force: true });
    const { fields, skipped } = restoreFields(a.project.schema, was);
    a.set("w1", fields, { force: true }); // it may put a formula back, or replace one
    expect(a.get("w1")).toEqual(was);
    expect(skipped).toEqual([]);
  });
});
