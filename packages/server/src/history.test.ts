import { describe, expect, it } from "vitest";
import { Sapwood } from "@thek42/sapwood-core";
import { Db } from "./db.ts";
import { PROJECT, SCHEMA } from "./fixtures.ts";
import { Repo } from "./repo.ts";

/** A project with a few commits landed: w1's damage set twice, w1 renamed, a2 changed. */
function project() {
  const repo = new Repo(new Db(":memory:"), { snapshotEvery: 2 });
  repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
  const land = (message: string, fn: (s: Sapwood) => { ops: unknown[] }) => {
    const t = repo.createTask("main", "ada");
    repo.write(t.id, "ada", fn as never);
    repo.land(t.id, "ada", { message });
  };
  land("Harder", (s) => s.set("w1", { damage: 12 }));
  land("Slower ammo", (s) => s.set("a2", { speed: 500 }));
  land("Harder still", (s) => s.set("w1", { damage: 15 }));
  land("Name it", (s) => s.set("w1", { $id: "blaster" }));
  return repo;
}

describe("history of one entity or cell (§8.7)", () => {
  it("an entity: each commit that changed it, before and after, through a rename", () => {
    const h = project().entityHistory("main", "blaster");
    expect(h.map((x) => x.commit.message)).toEqual(["Name it", "Harder still", "Harder", "Start the project"]);
    expect(h[0]).toMatchObject({ before: { $id: "w1", damage: 15 }, after: { $id: "blaster", damage: 15 } });
    expect(h[1]).toMatchObject({ before: { damage: 12 }, after: { damage: 15 } });
    expect(h[3]).toMatchObject({ before: null, after: { $id: "w1", damage: 10 } });
  });

  it("a cell: each commit that changed it, as typed and as shown", () => {
    const repo = project();
    const s = repo.head("main");
    const sheet = s.project.sheetId("Weapons");
    const sh = s.project.wb.sheet(sheet);
    const [row, col] = [sh.rows.idAt(1), sh.cols.idAt(3)]; // w1's damage, C1
    const h = repo.cellHistory("main", sheet, row, col);
    expect(h.map((x) => [x.commit.message, x.before?.input ?? null, x.after?.input ?? null])).toEqual([
      ["Harder still", "12", "15"],
      ["Harder", "10", "12"],
      ["Start the project", null, "10"],
    ]);
    expect(h[0]!.after!.cell).toBe("Weapons!C1");
    // w2's damage is a formula: as typed, and as shown.
    const f = repo.cellHistory("main", sheet, sh.rows.idAt(2), col);
    expect(f.at(-1)!.after).toMatchObject({ input: "=C1*2", shown: "20" });
  });
});
