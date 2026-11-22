import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyOps, docsEqual, Sapwood, type Op, type Patch } from "@thek42/sapwood-core";
import { Db } from "./db.ts";
import { PROJECT, SCHEMA } from "./fixtures.ts";
import { Repo, RepoError } from "./repo.ts";

function setup() {
  const db = new Db(":memory:");
  const repo = new Repo(db, { snapshotEvery: 3 });
  repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
  repo.createBranch("dev", "main", "ada");
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

/** The branch's base plus its net change is its head, exactly. */
function netHolds(db: Db, repo: Repo, name: string): boolean {
  const r = db.one<{ base_commit: string; net: string }>("SELECT base_commit, net FROM branches WHERE name = ?", name)!;
  const doc = repo.stateAt(r.base_commit);
  applyOps(doc, JSON.parse(r.net) as Op[]);
  return docsEqual(doc, repo.head(name).doc);
}

const ids = (repo: Repo, branch: string) => repo.head(branch).query("Ammo").map((e) => `${e.$id}:${e.speed}`);

describe("merge and sync", () => {
  it("merges a branch's changes into its parent, as one commit with two parents", () => {
    const { db, repo, land } = setup();
    land("dev", { op: "create", type: "Ammo", fields: { $id: "a3", speed: 3 } });
    land("dev", { op: "set", id: "a1", fields: { speed: 1 } });
    expect(repo.compare("dev")).toMatchObject({ behind: 0, ahead: 2, conflicts: [] });
    expect(netHolds(db, repo, "dev")).toBe(true);
    const devHead = repo.branch("dev").head;
    const m = repo.merge("dev", "bob");
    expect(m.sync).toBeNull();
    expect(m.merge).toMatchObject({ branch: "main", author: "bob", message: "Merge dev into main", parents: [repo.log("main")[1]!.id, devHead] });
    expect(ids(repo, "main")).toEqual(["a1:1", "a2:600", "a3:3"]);
    expect(docsEqual(repo.head("main").doc, repo.head("dev").doc)).toBe(true);
    expect(repo.compare("dev")).toMatchObject({ behind: 0, ahead: 0 });
    expect(code(() => repo.merge("dev", "bob"))).toBe("state"); // nothing new
    // Merging again brings only what's new: rows aren't made twice.
    land("dev", { op: "create", type: "Ammo", fields: { $id: "a4", speed: 4 } });
    repo.merge("dev", "bob");
    expect(ids(repo, "main")).toEqual(["a1:1", "a2:600", "a3:3", "a4:4"]);
    expect(repo.log("dev").map((c) => c.message)).toHaveLength(4); // the branch keeps its commits
  });

  it("syncs the parent's changes into a branch", () => {
    const { db, repo, land } = setup();
    land("dev", { op: "set", id: "a1", fields: { speed: 1 } });
    land("main", { op: "set", id: "a2", fields: { speed: 2 } }, { op: "create", type: "Ammo", fields: { $id: "m1", speed: 7 } });
    expect(repo.compare("dev")).toMatchObject({ behind: 1, ahead: 1, conflicts: [] });
    const s = repo.sync("dev", "ada");
    expect(s.commit).toMatchObject({ branch: "dev", message: "Sync dev from main", parents: [expect.any(String), repo.branch("main").head] });
    expect(ids(repo, "dev")).toEqual(["a1:1", "a2:2", "m1:7"]);
    expect(ids(repo, "main")).toEqual(["a1:900", "a2:2", "m1:7"]);
    expect(netHolds(db, repo, "dev")).toBe(true);
    expect(repo.compare("dev")).toMatchObject({ behind: 0, ahead: 1 });
    expect(repo.sync("dev", "ada").commit).toBeNull(); // up to date
    // The sync commit holds just main's changes, so it replays like any other.
    expect(repo.commitOps(s.commit!.id).length).toBeLessThan(6);
    expect(docsEqual(new Repo(db).head("dev").doc, repo.head("dev").doc)).toBe(true);
  });

  it("a merge syncs first when the parent has moved on", () => {
    const { repo, land } = setup();
    land("dev", { op: "set", id: "a1", fields: { speed: 1 } });
    land("main", { op: "set", id: "a2", fields: { speed: 2 } });
    const m = repo.merge("dev", "ada", { message: "Ship it" });
    expect(m.sync).not.toBeNull();
    expect(m.merge.message).toBe("Ship it");
    expect(ids(repo, "main")).toEqual(["a1:1", "a2:2"]);
    expect(docsEqual(repo.head("main").doc, repo.head("dev").doc)).toBe(true);
  });

  it("conflicts block a sync or merge until settled; mine is the branch", () => {
    const { repo, land } = setup();
    land("dev", { op: "set", id: "a1", fields: { speed: 1 } });
    land("main", { op: "set", id: "a1", fields: { speed: 2 } });
    const st = repo.compare("dev");
    expect(st.conflicts).toHaveLength(1);
    expect(st.conflicts[0]!.where).toEqual({ sheet: "Ammo", cell: "C1" });
    const head = repo.branch("dev").head;
    expect(code(() => repo.merge("dev", "ada"))).toBe("conflict");
    expect(repo.branch("dev").head).toBe(head); // nothing written
    repo.sync("dev", "ada", { resolutions: { [st.conflicts[0]!.id]: "mine" } });
    expect(ids(repo, "dev")).toEqual(["a1:1", "a2:600"]);
    repo.merge("dev", "ada");
    expect(ids(repo, "main")).toEqual(["a1:1", "a2:600"]);
  });

  it("theirs wins when chosen", () => {
    const { repo, land } = setup();
    land("dev", { op: "set", id: "a1", fields: { speed: 1 } }, { op: "set", id: "a2", fields: { speed: 5 } });
    land("main", { op: "set", id: "a1", fields: { speed: 2 } });
    const [c] = repo.compare("dev").conflicts;
    repo.merge("dev", "ada", { resolutions: { [c!.id]: "theirs" } });
    expect(ids(repo, "main")).toEqual(["a1:2", "a2:5"]);
  });

  it("open tasks on the branch rebase across a sync", () => {
    const { repo, land } = setup();
    const t = repo.createTask("dev", "bob");
    repo.write(t.id, "bob", (s) => s.set("w1", { damage: 99 }));
    land("main", { op: "set", id: "a2", fields: { speed: 2 } });
    repo.sync("dev", "ada");
    expect(repo.view(t.id).get("a2").speed).toBe(2);
    expect(repo.task(t.id).base).toBe(repo.branch("dev").head);
    repo.land(t.id, "bob");
    expect(repo.head("dev").get("w1").damage).toBe(99);
  });

  it("refuses what can't be merged or synced", () => {
    const { repo, land } = setup();
    expect(code(() => repo.sync("main", "ada"))).toBe("bad-request");
    expect(code(() => repo.merge("dev", "ada"))).toBe("state"); // no changes
    land("dev", { op: "set", id: "w1", fields: { shots: ["a2"] } });
    land("main", { op: "delete", id: "a2" });
    expect(code(() => repo.merge("dev", "ada"))).toBe("invalid"); // the ref is broken together
    repo.createBranch("dev2", "dev", "ada");
    repo.discardBranch("dev2");
    expect(code(() => repo.sync("dev2", "ada"))).toBe("state");
  });

  it("branches of branches", () => {
    const { db, repo, land } = setup();
    repo.createBranch("feature", "dev", "ada");
    land("feature", { op: "create", type: "Ammo", fields: { $id: "f1", speed: 1 } });
    repo.merge("feature", "ada");
    expect(ids(repo, "dev")).toContain("f1:1");
    expect(ids(repo, "main")).not.toContain("f1:1");
    expect(netHolds(db, repo, "dev")).toBe(true); // the merge commit joined dev's net change
    repo.merge("dev", "ada");
    expect(ids(repo, "main")).toContain("f1:1");
  });
});

describe("merge and sync, at random", () => {
  it("keep each branch's net change exact, and a restarted server reads the same", () => {
    const edit = fc.oneof(
      fc.record({ id: fc.constantFrom("w1", "a1", "a2"), n: fc.integer({ min: 0, max: 3 }) }).map(({ id, n }): Patch => ({ op: "set", id, fields: id === "w1" ? { damage: n } : { speed: n }, force: true })),
      fc.constantFrom<Patch>(
        { op: "create", type: "Ammo", fields: { $id: "a3", speed: 5 } },
        { op: "create", type: "Ammo", fields: { $id: "a4", speed: 6 }, after: "a1" },
        { op: "delete", id: "a2" },
        { op: "commentOut", id: "a1" },
        { op: "setSingleton", type: "Config", fields: { lives: 7 } },
      ),
    );
    const step = fc.oneof(
      { weight: 3, arbitrary: fc.record({ kind: fc.constant("land" as const), branch: fc.constantFrom("main", "dev", "feat"), p: edit }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant("sync" as const), branch: fc.constantFrom("dev", "feat"), mine: fc.boolean() }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant("merge" as const), branch: fc.constantFrom("dev", "feat"), mine: fc.boolean() }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant("task" as const), p: edit }) },
    );
    const runs = Number(process.env.SAPWOOD_RUNS ?? 80);
    const seen: Record<string, number> = {};
    fc.assert(
      fc.property(fc.array(step, { minLength: 5, maxLength: 25 }), (steps) => {
        const { db, repo } = setup();
        repo.createBranch("feat", "dev", "ada");
        const task = repo.createTask("dev", "bob"); // stays open across syncs
        for (const st of steps) {
          try {
            if (st.kind === "land") {
              const t = repo.createTask(st.branch, "ada");
              repo.write(t.id, "ada", (s) => s.apply([st.p]));
              repo.land(t.id, "ada");
            } else if (st.kind === "task") repo.write(task.id, "bob", (s) => s.apply([st.p]));
            else {
              const resolutions = Object.fromEntries(repo.compare(st.branch).conflicts.map((c) => [c.id, st.mine ? "mine" : "theirs"] as const));
              if (Object.keys(resolutions).length) seen.conflicts = (seen.conflicts ?? 0) + 1;
              if (st.kind === "sync") {
                if (repo.sync(st.branch, "ada", { resolutions }).commit) seen.sync = (seen.sync ?? 0) + 1;
              } else {
                const m = repo.merge(st.branch, "ada", { resolutions });
                seen.merge = (seen.merge ?? 0) + 1;
                const parent = repo.branch(st.branch).parent!;
                expect(docsEqual(repo.head(parent).doc, repo.head(st.branch).doc)).toBe(true);
                expect(m.merge.parents[1]).toBe(repo.branch(st.branch).head);
              }
            }
          } catch (e) {
            if (!(e instanceof RepoError) && (e as { code?: string }).code === undefined) throw e;
            // refused: a taken ID, nothing to merge, validation errors
          }
          for (const b of ["dev", "feat"]) expect(netHolds(db, repo, b)).toBe(true);
          const fresh = new Repo(db);
          for (const b of ["main", "dev", "feat"]) expect(docsEqual(fresh.head(b).doc, repo.head(b).doc)).toBe(true);
          if (repo.task(task.id).state === "open") expect(docsEqual(fresh.view(task.id).doc, repo.view(task.id).doc)).toBe(true);
        }
      }),
      { numRuns: runs },
    );
    expect(seen.sync ?? 0).toBeGreaterThan(runs / 4);
    expect(seen.merge ?? 0).toBeGreaterThan(runs / 4);
    expect(seen.conflicts ?? 0).toBeGreaterThan(0);
  }, 600_000);
});
