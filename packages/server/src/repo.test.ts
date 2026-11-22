import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { docsEqual, Sapwood, type Patch } from "@thek42/sapwood-core";
import { Db } from "./db.ts";
import { PROJECT, SCHEMA } from "./fixtures.ts";
import { Repo, RepoError } from "./repo.ts";

function setup(opts: { snapshotEvery?: number } = {}) {
  const db = new Db(":memory:");
  const repo = new Repo(db, opts);
  repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
  return { db, repo };
}

const set = (id: string, fields: Patch extends infer P ? P extends { op: "set"; fields: infer F } ? F : never : never): Patch => ({ op: "set", id, fields });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RepoError) return e.code;
    throw e;
  }
  return "ok";
};

describe("the repo", () => {
  it("starts on main, and a landed task moves the head", () => {
    const { repo } = setup();
    expect(repo.branches().map((b) => b.name)).toEqual(["main"]);
    expect(repo.head("main").get("w1").damage).toBe(10);
    const t = repo.createTask("main", "ada", "Buff");
    repo.write(t.id, "ada", (s) => s.set("w1", { damage: 12 }));
    expect(repo.view(t.id).get("w2").damage).toEqual({ $value: 24, $formula: "=C1*2" });
    expect(repo.head("main").get("w1").damage).toBe(10);
    const { commit } = repo.land(t.id, "ada");
    expect(commit).toMatchObject({ branch: "main", task: t.id, author: "ada", message: "Buff" });
    expect(repo.head("main").get("w1").damage).toBe(12);
    expect(repo.log("main").map((c) => c.message)).toEqual(["Buff", "Start the project"]);
    expect(repo.task(t.id)).toMatchObject({ state: "landed", landedCommit: commit.id });
    expect(code(() => repo.write(t.id, "ada", (s) => s.set("w1", { damage: 1 })))).toBe("state");
  });

  it("each user has a current task per branch, made on first use", () => {
    const { repo } = setup();
    const a = repo.currentTask("main", "ada")!;
    expect(repo.currentTask("main", "ada")!.id).toBe(a.id);
    expect(repo.currentTask("main", "bob", false)).toBeNull();
    const b = repo.createTask("main", "ada", "Second");
    expect(repo.currentTask("main", "ada")!.id).toBe(b.id);
    repo.switchTask(a.id, "ada");
    expect(repo.currentTask("main", "ada")!.id).toBe(a.id);
    expect(code(() => repo.write(a.id, "bob", (s) => s.set("w1", { damage: 1 })))).toBe("forbidden");
    repo.write(a.id, "ada", (s) => s.set("w1", { damage: 1 }));
    repo.land(a.id, "bob"); // any Editor may land
    expect(repo.currentTask("main", "ada", false)).toBeNull();
  });

  it("undo and redo within a task, kept across a restart", () => {
    const { db, repo } = setup();
    const t = repo.createTask("main", "ada");
    repo.write(t.id, "ada", (s) => s.set("w1", { damage: 1 }));
    repo.write(t.id, "ada", (s) => s.set("w1", { damage: 2 }));
    expect(repo.undo(t.id, "ada")).toBe(true);
    expect(repo.view(t.id).get("w1").damage).toBe(1);
    const again = new Repo(db);
    expect(again.view(t.id).get("w1").damage).toBe(1);
    expect(again.task(t.id)).toMatchObject({ changes: 1, canUndo: true, canRedo: true });
    expect(again.redo(t.id, "ada")).toBe(true);
    expect(again.view(t.id).get("w1").damage).toBe(2);
    again.undo(t.id, "ada");
    again.write(t.id, "ada", (s) => s.set("w1", { damage: 3 })); // a new change drops the redo
    expect(again.task(t.id).canRedo).toBe(false);
    expect(again.undo(t.id, "ada") && again.undo(t.id, "ada")).toBe(true);
    expect(again.undo(t.id, "ada")).toBe(false);
    expect(again.view(t.id).get("w1").damage).toBe(10);
  });

  it("a task behind the head is rebased when that has no conflicts", () => {
    const { repo } = setup();
    const a = repo.createTask("main", "ada");
    const b = repo.createTask("main", "bob");
    repo.write(a.id, "ada", (s) => s.set("w1", { damage: 20 }));
    repo.write(b.id, "bob", (s) => s.set("a2", { speed: 1 }));
    repo.land(a.id, "ada");
    expect(repo.status(b.id)).toMatchObject({ behind: 0, conflicts: [] }); // reading it brought it up to the head
    expect(repo.view(b.id).get("w1").damage).toBe(20);
    expect(repo.task(b.id).base).toBe(repo.branch("main").head);
    repo.land(b.id, "bob");
    expect(repo.head("main").get("w1").damage).toBe(20);
    expect(repo.head("main").get("a2").speed).toBe(1);
  });

  it("conflicts block a land until resolved", () => {
    const { repo } = setup();
    const a = repo.createTask("main", "ada");
    const b = repo.createTask("main", "bob");
    repo.write(a.id, "ada", (s) => s.set("w1", { damage: 20 }));
    repo.write(b.id, "bob", (s) => s.set("w1", { damage: 30 }));
    repo.land(a.id, "ada");
    const st = repo.status(b.id);
    expect(st.behind).toBe(1);
    expect(st.conflicts).toHaveLength(1);
    expect(st.conflicts[0]!.conflict).toMatchObject({ kind: "cell", mine: { v: 30 }, theirs: { v: 20 } });
    expect(st.conflicts[0]!.where).toEqual({ sheet: "Weapons", cell: "C1" });
    expect(repo.view(b.id).get("w1").damage).toBe(30); // still on its own base
    expect(code(() => repo.land(b.id, "bob"))).toBe("conflict");
    repo.land(b.id, "bob", { resolutions: { [st.conflicts[0]!.id]: "mine" } });
    expect(repo.head("main").get("w1").damage).toBe(30);
  });

  it("refuses a land that leaves validation errors", () => {
    const { repo } = setup();
    const a = repo.createTask("main", "ada");
    const b = repo.createTask("main", "bob");
    repo.write(a.id, "ada", (s) => s.create("Ammo", { $id: "a3", speed: 1 }));
    repo.write(b.id, "bob", (s) => s.create("Ammo", { $id: "a3", speed: 2 }));
    repo.land(a.id, "ada");
    let err: RepoError | undefined;
    try {
      repo.land(b.id, "bob");
    } catch (e) {
      err = e as RepoError;
    }
    expect(err?.code).toBe("invalid");
    expect((err?.detail as { validation: { errors: number } }).validation.errors).toBeGreaterThan(0);
    expect(repo.task(b.id).state).toBe("open");
    expect(repo.log("main")).toHaveLength(2);
    repo.abandon(b.id, "bob");
    expect(repo.task(b.id).state).toBe("abandoned");
    repo.reopen(b.id, "bob");
    expect(repo.view(b.id).query("Ammo").map((e) => e.$id)).toEqual(["a1", "a2", "a3", "a3"]); // rebased: both rows
    repo.undo(b.id, "bob");
    repo.write(b.id, "bob", (s) => s.create("Ammo", { $id: "a4", speed: 2 }));
    repo.land(b.id, "bob");
    expect(repo.head("main").query("Ammo").map((e) => e.$id)).toEqual(["a1", "a2", "a3", "a4"]);
  });

  it("branches fork from a head and are discarded, not deleted", () => {
    const { repo } = setup();
    repo.createBranch("staging", "main", "ada");
    const t = repo.createTask("staging", "ada");
    repo.write(t.id, "ada", (s) => s.setSingleton("Config", { lives: 9 }));
    repo.land(t.id, "ada");
    expect(repo.head("staging").singleton("Config").lives).toBe(9);
    expect(repo.head("main").singleton("Config").lives).toBe(3);
    expect(repo.branch("staging")).toMatchObject({ parent: "main", forkCommit: repo.branch("main").head });
    expect(code(() => repo.createBranch("staging", "main", "ada"))).toBe("exists");
    expect(code(() => repo.createBranch("-x", "main", "ada"))).toBe("bad-request");
    repo.discardBranch("staging");
    expect(repo.branches().map((b) => b.name)).toEqual(["main"]);
    expect(code(() => repo.createTask("staging", "ada"))).toBe("state");
    expect(code(() => repo.discardBranch("main"))).toBe("bad-request");
    expect(repo.at(repo.branch("staging").head).singleton("Config").lives).toBe(9);
  });

  it("any commit can be read back, through snapshots and ops", () => {
    const { db, repo } = setup({ snapshotEvery: 3 });
    for (let i = 1; i <= 8; i++) {
      const t = repo.createTask("main", "ada");
      repo.write(t.id, "ada", (s) => s.set("w1", { damage: i }));
      repo.land(t.id, "ada");
    }
    expect(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM snapshots")!.n).toBe(3); // the start, 3 and 6
    const fresh = new Repo(db);
    const log = fresh.log("main");
    expect(log).toHaveLength(9);
    expect(fresh.at(log[0]!.id).get("w1").damage).toBe(8);
    expect(fresh.at(log[4]!.id).get("w1").damage).toBe(4);
    expect(docsEqual(fresh.head("main").doc, repo.head("main").doc)).toBe(true);
  });
});

describe("the repo, at random", () => {
  it("lands random concurrent tasks, and a restarted server reads the same", () => {
    const patch = fc.oneof(
      fc.record({ op: fc.constant("set" as const), id: fc.constantFrom("w1", "w2", "a1"), n: fc.integer({ min: 0, max: 3 }) }),
      fc.record({ op: fc.constant("create" as const), id: fc.constantFrom("a3", "a4"), n: fc.integer({ min: 0, max: 3 }) }),
      fc.record({ op: fc.constant("lives" as const), id: fc.constant(""), n: fc.integer({ min: 0, max: 3 }) }),
      fc.record({ op: fc.constant("delete" as const), id: fc.constantFrom("a2", "a3"), n: fc.constant(0) }),
    );
    const step = fc.oneof(
      { weight: 5, arbitrary: fc.record({ kind: fc.constant("write" as const), who: fc.nat(2), p: patch }) },
      { weight: 2, arbitrary: fc.record({ kind: fc.constant("land" as const), who: fc.nat(2), mine: fc.boolean() }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant("undo" as const), who: fc.nat(2) }) },
    );
    fc.assert(
      fc.property(fc.array(step, { minLength: 8, maxLength: 40 }), (steps) => {
        const { db, repo } = setup({ snapshotEvery: 2 });
        const users = ["ada", "bob", "cy"];
        for (const st of steps) {
          const who = users[st.who]!;
          const t = repo.currentTask("main", who)!;
          if (st.kind === "write") {
            const { p } = st;
            const fields: Record<string, number> = p.op === "set" ? (p.id.startsWith("w") ? { damage: p.n } : { speed: p.n }) : { speed: p.n };
            const patches: Patch[] =
              p.op === "set" ? [{ op: "set", id: p.id, fields, force: true }]
              : p.op === "create" ? [{ op: "create", type: "Ammo", fields: { ...fields, $id: p.id } }]
              : p.op === "lives" ? [{ op: "setSingleton", type: "Config", fields: { lives: p.n } }]
              : [{ op: "delete", id: p.id }];
            try {
              repo.write(t.id, who, (s) => s.apply(patches));
            } catch {
              // refused by the API (a taken ID, a missing entity): nothing changed
            }
          } else if (st.kind === "undo") repo.undo(t.id, who);
          else {
            if (repo.task(t.id).changes === 0) continue;
            const status = repo.status(t.id);
            const resolutions = Object.fromEntries(status.conflicts.map((c) => [c.id, st.mine ? "mine" : "theirs"] as const));
            const before = repo.branch("main").head;
            try {
              repo.land(t.id, who, { resolutions });
            } catch (e) {
              if (!(e instanceof RepoError) || !["invalid", "state"].includes(e.code)) throw e;
              expect(repo.branch("main").head).toBe(before);
              repo.abandon(t.id, who);
            }
          }
          const fresh = new Repo(db);
          expect(docsEqual(fresh.head("main").doc, repo.head("main").doc)).toBe(true);
          const v = repo.view(t.id);
          if (repo.task(t.id).state === "open") expect(docsEqual(fresh.view(t.id).doc, v.doc)).toBe(true);
        }
        expect(repo.head("main").validate().errors).toBe(0);
      }),
      { numRuns: Number(process.env.SAPWOOD_RUNS ?? 60) },
    );
  }, 600_000);
});
