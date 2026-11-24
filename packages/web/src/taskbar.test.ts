import { readFileSync } from "node:fs";
import { describe as group, expect, it } from "vitest";
import { loadProject } from "@thek42/sapwood-core";
import type { ConflictJson } from "./api.ts";
import { describe } from "./TaskBar.tsx";

const fixture = (f: string) => readFileSync(new URL(`../../core/fixtures/krbsg/${f}`, import.meta.url), "utf8");

group("a conflict in words", () => {
  it("names an entity's cell for the entity and field, with its address", () => {
    const p = loadProject(fixture("schema.yaml"), fixture("project.yaml")).project;
    const sheet = p.sheetId("Weapons");
    const s = p.wb.sheet(sheet);
    const cell = (row: number, col: number): ConflictJson => ({
      id: "c",
      where: { sheet: "Weapons", cell: `${"ABCDEF"[col]}${row + 1}` },
      conflict: { kind: "cell", sheet, row: s.rows.liveIds()[row]!, col: s.cols.liveIds()[col]!, base: null, mine: { v: 0.4 }, theirs: { v: 0.45 } } as ConflictJson["conflict"],
    });
    expect(describe(cell(1, 4), p)).toBe("Blaster's cooldown (Weapons!E2): yours 0.4, the branch's 0.45");
    // Not an entity's field: the address alone.
    expect(describe(cell(0, 4), p)).toBe("Weapons!E1: yours 0.4, the branch's 0.45");
    expect(describe(cell(1, 4))).toBe("Weapons!E2: yours 0.4, the branch's 0.45");
  });
});
