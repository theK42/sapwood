import { describe, expect, it } from "vitest";
import { routeFromPath, routePath, type Route } from "./routes.ts";

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
