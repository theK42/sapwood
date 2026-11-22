import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { docsEqual, Sapwood, type Patch } from "@thek42/sapwood-core";
import { Db } from "./db.ts";
import { PROJECT, SCHEMA } from "./fixtures.ts";
import { Repo, RepoError } from "./repo.ts";

function setup() {
  const db = new Db(":memory:");
  const repo = new Repo(db, { snapshotEvery: 3 });
  repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
  /** Land patches on a branch, as one task. */
  const land = (branch: string, ...patches: Patch[]) => {
    const t = repo.createTask(branch, "ada");
    repo.write(t.id, "ada", (s) => s.apply(patches));
    return repo.land(t.id, "ada").commit;
  };
  return { db, repo, land };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RepoError) return e.code;
    throw e;
  }
  return "ok";
};

const ids = (repo: Repo, branch: string) => repo.head(branch).query("Ammo").map((e) => `${e.$id}:${e.speed}`);

describe("revert", () => {
  it("reverts the latest commit: a task that, landed, gives the state before it", () => {
    const { repo, land } = setup();
    const before = repo.branch("main").head;
    const c = land("main", { op: "set", id: "a1", fields: { speed: 1 } }, { op: "create", type: "Ammo", fields: { $id: "a3", speed: 3 } });
    const st = repo.revert(c.id, "bob");
    expect(st.task).toMatchObject({ branch: "main", owner: "bob", name: `Revert "${c.message}"`, state: "open" });
    expect(st.conflicts).toEqual([]);
    expect(repo.currentTask("main", "bob", false)?.id).toBe(st.task.id);
    expect(repo.view(st.task.id).query("Ammo").map((e) => e.$id)).toEqual(["a1", "a2"]);
    const landed = repo.land(st.task.id, "bob");
    expect(landed.commit.message).toBe(`Revert "${c.message}"`);
    expect(docsEqual(repo.head("main").doc, repo.stateAt(before))).toBe(true);
    expect(repo.log("main")).toHaveLength(3); // history isn't rewritten
  });

  it("reverts an older commit, keeping what came after", () => {
    const { repo, land } = setup();
    const c = land("main", { op: "set", id: "a1", fields: { speed: 1 } });
    land("main", { op: "set", id: "a2", fields: { speed: 2 } }, { op: "create", type: "Ammo", fields: { $id: "a3", speed: 3 } });
    const st = repo.revert(c.id, "ada");
    expect(st.behind).toBe(0); // rebased onto the head straight away
    repo.land(st.task.id, "ada");
    expect(ids(repo, "main")).toEqual(["a1:900", "a2:2", "a3:3"]);
  });

  it("brings back a deleted row, and removes a created one", () => {
    const { repo, land } = setup();
    const del = land("main", { op: "delete", id: "a2" });
    const add = land("main", { op: "create", type: "Ammo", fields: { $id: "a3", speed: 3 } });
    repo.land(repo.revert(del.id, "ada").task.id, "ada");
    expect(ids(repo, "main")).toEqual(["a1:900", "a3:3", "a2:600"]); // a3 went in before a2's tombstone
    repo.land(repo.revert(add.id, "ada").task.id, "ada");
    expect(ids(repo, "main")).toEqual(["a1:900", "a2:600"]);
  });

  it("a later change to the same cell is a conflict to settle before landing", () => {
    const { repo, land } = setup();
    const c = land("main", { op: "set", id: "a1", fields: { speed: 1 } });
    land("main", { op: "set", id: "a1", fields: { speed: 2 } });
    const st = repo.revert(c.id, "ada");
    expect(st.behind).toBe(1);
    expect(st.conflicts).toHaveLength(1);
    expect(st.conflicts[0]!.where).toEqual({ sheet: "Ammo", cell: "C1" });
    expect(code(() => repo.land(st.task.id, "ada"))).toBe("conflict");
    // Mine is the revert: a1 goes back to its value before the reverted commit.
    repo.land(st.task.id, "ada", { resolutions: { [st.conflicts[0]!.id]: "mine" } });
    expect(ids(repo, "main")).toEqual(["a1:900", "a2:600"]);
  });

  it("refuses what can't be reverted", () => {
    const { repo, land } = setup();
    expect(code(() => repo.revert(repo.branch("main").head, "ada"))).toBe("bad-request"); // the first commit
    repo.createBranch("dev", "main", "ada");
    const onDev = land("dev", { op: "set", id: "a1", fields: { speed: 1 } });
    expect(code(() => repo.revert(onDev.id, "ada", { branch: "main" }))).toBe("bad-request"); // not on main
    expect(code(() => repo.revert("nope", "ada"))).toBe("not-found");
    // On its own branch, by default.
    expect(repo.revert(onDev.id, "ada").task.branch).toBe("dev");
  });
});

describe("restore", () => {
  it("takes a branch back to an earlier commit, exactly, as one task", () => {
    const { repo, land } = setup();
    const point = land("main", { op: "set", id: "a1", fields: { speed: 1 } });
    land("main", { op: "delete", id: "a2" }, { op: "create", type: "Ammo", fields: { $id: "a3", speed: 3 } });
    land("main", { op: "set", id: "w1", fields: { damage: 77 } }, { op: "setSingleton", type: "Config", fields: { lives: 9 } });
    const st = repo.restore("main", point.id, "bob");
    expect(st.task.name).toBe(`Restore to ${point.id.slice(0, 8)} "${point.message}"`);
    // The difference, said plainly: not every op since, undone one by one.
    const ops = repo.taskOps(st.task.id);
    expect(ops.length).toBeLessThan(12);
    expect(ops.some((op) => op.kind === "purge")).toBe(true); // a3's row was added since
    repo.land(st.task.id, "bob");
    expect(docsEqual(repo.head("main").doc, repo.stateAt(point.id))).toBe(true);
    expect(repo.log("main")).toHaveLength(5);
  });

  it("refuses a commit that isn't an earlier one on the branch", () => {
    const { repo, land } = setup();
    expect(code(() => repo.restore("main", repo.branch("main").head, "ada"))).toBe("state");
    const first = repo.branch("main").head;
    land("main", { op: "set", id: "a1", fields: { speed: 1 } });
    land("main", { op: "set", id: "a1", fields: { speed: 900 } });
    expect(code(() => repo.restore("main", first, "ada"))).toBe("state"); // already as it was then
    repo.createBranch("dev", "main", "ada");
    const onDev = land("dev", { op: "set", id: "a1", fields: { speed: 5 } });
    expect(code(() => repo.restore("main", onDev.id, "ada"))).toBe("bad-request");
  });
});

describe("revert and restore, at random", () => {
  it("restoring to any point lands exactly that state; reverting the latest commit undoes it", () => {
    const edit = fc.oneof(
      fc.record({ id: fc.constantFrom("w1", "a1", "a2"), n: fc.integer({ min: 0, max: 3 }) }).map(({ id, n }): Patch => ({ op: "set", id, fields: id === "w1" ? { damage: n } : { speed: n }, force: true })),
      fc.constantFrom<Patch>(
        { op: "create", type: "Ammo", fields: { $id: "a3", speed: 5 } },
        { op: "create", type: "Ammo", fields: { $id: "a4", speed: 6 }, after: "a1" },
        { op: "delete", id: "a2" },
        { op: "delete", id: "a3" },
        { op: "commentOut", id: "a1" },
        { op: "setSingleton", type: "Config", fields: { lives: 7 } },
        { op: "set", id: "a1", fields: { $id: "a5" } },
        { op: "set", id: "w1", fields: { shots: ["a1"] } },
      ),
    );
    const runs = Number(process.env.SAPWOOD_RUNS ?? 80);
    let restored = 0, reverted = 0;
    fc.assert(
      fc.property(fc.array(fc.array(edit, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 8 }), fc.nat(), fc.nat(), (commits, pick, pick2) => {
        const { db, repo } = setup();
        for (const patches of commits) {
          const t = repo.createTask("main", "ada");
          try {
            repo.write(t.id, "ada", (s) => s.apply(patches));
            repo.land(t.id, "ada");
          } catch (e) {
            if (!(e instanceof RepoError) && (e as { code?: string }).code === undefined) throw e;
            repo.abandon(t.id, "ada");
          }
        }
        const log = repo.log("main", 100);
        // Revert the latest commit: back to its parent, exactly.
        const latest = log[0]!;
        if (latest.parents[0]) {
          try {
            repo.land(repo.revert(latest.id, "ada").task.id, "ada");
            expect(docsEqual(repo.head("main").doc, repo.stateAt(latest.parents[0]))).toBe(true);
            reverted++;
          } catch (e) {
            if (!(e instanceof RepoError)) throw e; // changed nothing; or invalid on its own
          }
        }
        // Restore to any earlier point: that state, exactly.
        const all = repo.log("main", 100);
        const point = all[(pick % (all.length - 1)) + 1];
        if (point) {
          try {
            repo.land(repo.restore("main", point.id, "bob").task.id, "bob");
            expect(docsEqual(repo.head("main").doc, repo.stateAt(point.id))).toBe(true);
            restored++;
          } catch (e) {
            if (!(e instanceof RepoError) || e.code !== "state") throw e; // already as it was
          }
        }
        // An older revert lands, settling any conflicts for the revert.
        const again = repo.log("main", 100);
        const old = again[pick2 % again.length]!;
        if (old.parents[0]) {
          try {
            let st = repo.revert(old.id, "ada");
            const resolutions = Object.fromEntries(st.conflicts.map((c) => [c.id, "mine"] as const));
            repo.land(st.task.id, "ada", { resolutions });
            st = repo.status(st.task.id);
            expect(st.task.state).toBe("landed");
          } catch (e) {
            if (!(e instanceof RepoError)) throw e; // changed nothing, or invalid together
          }
        }
        expect(docsEqual(new Repo(db).head("main").doc, repo.head("main").doc)).toBe(true);
      }),
      { numRuns: runs },
    );
    expect(restored).toBeGreaterThan(runs / 3);
    expect(reverted).toBeGreaterThan(runs / 3);
  }, 600_000);
});
