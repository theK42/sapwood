import { describe, expect, it } from "vitest";
import { routeFromPath, routePath, tabOf, tabTarget, type Route } from "./routes.ts";

describe("addresses", () => {
  it("go both ways", () => {
    const all: Route[] = [
      { kind: "home" },
      { kind: "sheet", id: "s7" },
      { kind: "type", name: "Weapon" },
      { kind: "history" },
      { kind: "commit", id: "78ffa689" },
      { kind: "changes", task: 6 },
    ];
    for (const r of all) expect(routeFromPath(routePath("feature/x y", r))).toEqual(r);
    expect(routePath("main", { kind: "changes", task: 6 })).toBe("/branches/main/tasks/6/changes");
    expect(routeFromPath("/branches/main/tasks/x/changes")).toEqual({ kind: "home" });
    expect(routeFromPath("/")).toEqual({ kind: "home" });
  });
});

describe("the entity page's address", () => {
  it("the type and the ID, each optional", () => {
    for (const r of [
      { kind: "entities", type: null, id: null },
      { kind: "entities", type: "Enemy", id: null },
      { kind: "entities", type: "Enemy", id: "basic enemy/2" },
    ] as Route[])
      expect(routeFromPath(routePath("main", r))).toEqual(r);
  });
});

describe("the tabs", () => {
  it("each page belongs to one; a tab goes back where you were in it, or to its first page", () => {
    expect([{ kind: "sheet", id: "s1" }, { kind: "type", name: "Enemy" }, { kind: "entities", type: "Enemy", id: null }, { kind: "commit", id: "c" }].map((r) => tabOf(r as Route))).toEqual(["sheets", "sheets", "entities", "history"]);
    const last = { sheets: { kind: "sheet", id: "s5" } as Route, entities: { kind: "entities", type: "Enemy", id: "basic_enemy" } as Route };
    const onEntity: Route = { kind: "entities", type: "Enemy", id: "basic_enemy" };
    expect(tabTarget("sheets", onEntity, last)).toEqual({ kind: "sheet", id: "s5" }); // back to the sheet
    expect(tabTarget("entities", onEntity, last)).toEqual({ kind: "entities", type: null, id: null }); // in it already: its first page
    expect(tabTarget("schema", onEntity, last)).toEqual({ kind: "schema" }); // not visited yet
  });
});
