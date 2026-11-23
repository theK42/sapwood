import fc from "fast-check";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyOps, cloneDoc, docsEqual, Sapwood, type Doc, type Op, type Patch } from "@thek42/sapwood-core";
import { Db } from "./db.ts";
import { PROJECT, SCHEMA } from "./fixtures.ts";
import { Repo, RepoError, type Carried } from "./repo.ts";

const USERS = ["ada", "bob"] as const;

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

/**
 * One round: a user makes a few changes (one patch each) and undoes some; maybe the other
 * user lands changes of their own meanwhile; then the first lands, rebases, or just reads
 * (which rebases when nothing would be lost).
 */
const round = fc.record({
  user: fc.nat(1),
  changes: fc.array(edit, { minLength: 2, maxLength: 4 }),
  undo: fc.integer({ min: 1, max: 3 }),
  redo: fc.nat(1),
  meanwhile: fc.option(fc.array(edit, { minLength: 1, maxLength: 2 }), { freq: 3 }),
  finish: fc.constantFrom("land" as const, "land" as const, "rebase" as const, "read" as const),
  side: fc.constantFrom("mine" as const, "theirs" as const),
});

const refused = (e: unknown) => e instanceof RepoError || (e as { code?: string }).code !== undefined;

describe("what was undone, carried over", () => {
  it("survives lands and rebases: redo goes on where it left off, exactly when nothing landed in between", () => {
    const runs = Number(process.env.SAPWOOD_RUNS ?? 80);
    const seen = { exact: 0, rebased: 0, dropped: 0, auto: 0 };
    fc.assert(
      fc.property(fc.array(round, { minLength: 1, maxLength: 6 }), (rounds) => {
        const db = new Db(":memory:");
        const repo = new Repo(db, { snapshotEvery: 3 });
        repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
        const undone = (task: number) => db.all<{ ops: string }>("SELECT ops FROM task_changes WHERE task = ? AND undone = 1 ORDER BY seq", task).map((r) => JSON.parse(r.ops) as Op[]);
        const attempt = (fn: () => void) => {
          try {
            fn();
          } catch (e) {
            if (!refused(e)) throw e;
          }
        };
        /** The task as it would be with everything redone. */
        const full = (task: number) => {
          const d = cloneDoc(repo.view(task).doc);
          applyOps(d, undone(task).flat());
          return d;
        };
        /** Redo all that was carried, each step working; then undo takes it all back exactly, leaving it to redo again. */
        const check = (c: Carried, exact?: Doc) => {
          if (!c.task) return expect(c.redo).toBe(0);
          const { id: t, owner } = c.task;
          expect(undone(t)).toHaveLength(c.redo);
          const before = cloneDoc(repo.view(t).doc);
          for (let i = 0; i < c.redo; i++) expect(repo.redo(t, owner)).toBe(true);
          expect(repo.redo(t, owner)).toBe(false);
          if (exact) expect(docsEqual(repo.view(t).doc, exact)).toBe(true);
          for (let i = 0; i < c.redo; i++) expect(repo.undo(t, owner)).toBe(true);
          expect(docsEqual(repo.view(t).doc, before)).toBe(true);
          expect(undone(t)).toHaveLength(c.redo);
        };

        for (const r of rounds) {
          const user = USERS[r.user]!;
          const other = USERS[1 - r.user]!;
          const t = repo.currentTask("main", user)!.id;
          for (const p of r.changes) attempt(() => repo.write(t, user, (s) => s.apply([p])));
          for (let i = 0; i < r.undo; i++) repo.undo(t, user);
          for (let i = 0; i < r.redo; i++) repo.redo(t, user);
          if (r.meanwhile) {
            const o = repo.createTask("main", other).id;
            attempt(() => {
              repo.write(o, other, (s) => s.apply(r.meanwhile!));
              repo.land(o, other);
            });
            if (repo.task(o).state === "open") repo.abandon(o, other);
          }
          const n = undone(t).length;
          if (r.finish === "read") {
            // A rebase on read keeps all there is to redo, or doesn't happen. Only a change the
            // head made too goes: redone, it would change nothing.
            const base = repo.task(t).base;
            attempt(() => repo.view(t));
            const m = undone(t).length;
            if (repo.task(t).base === base) expect(m).toBe(n);
            else if (n) {
              expect(m).toBeLessThanOrEqual(n);
              seen.auto++;
              check({ task: repo.task(t), redo: m, dropped: [] });
            }
            continue;
          }
          const upToDate = repo.task(t).base === repo.branch("main").head;
          const exact = n && upToDate ? full(t) : undefined;
          // Without asking first (a read would rebase it): settle conflicts only when refused for them.
          const go = (resolutions = {}) => (r.finish === "land" ? repo.land(t, user, { resolutions }) : repo.rebaseTask(t, user, resolutions));
          let out: ReturnType<typeof go>;
          try {
            try {
              out = go();
            } catch (e) {
              if (!(e instanceof RepoError) || e.code !== "conflict") throw e;
              out = go(Object.fromEntries(repo.status(t).conflicts.map((c) => [c.id, r.side] as const)));
            }
          } catch (e) {
            if (!refused(e)) throw e; // nothing to land, or invalid: the task stays as it was
            expect(undone(t)).toHaveLength(n);
            continue;
          }
          if (!n || (r.finish === "rebase" && upToDate)) {
            expect(out.carried).toBeUndefined();
            expect(undone(t)).toHaveLength(n); // nothing to do: the task stays as it is
            continue;
          }
          const c = out.carried!;
          expect(c).toBeDefined();
          expect(c.redo).toBeLessThanOrEqual(n);
          if (exact) {
            expect([c.redo, c.dropped]).toEqual([n, []]);
            seen.exact++;
          } else seen.rebased++;
          if (c.dropped.length) seen.dropped++;
          if (r.finish === "land" && c.task) expect(repo.currentTask("main", user, false)?.id).toBe(c.task.id);
          check(c, exact);
        }
        // A restarted server reads every open task the same.
        const again = new Repo(db);
        for (const t of repo.tasks({ branch: "main", state: "open" })) {
          expect(docsEqual(again.view(t.id).doc, repo.view(t.id).doc)).toBe(true);
          expect(again.task(t.id).canRedo).toBe(repo.task(t.id).canRedo);
        }
      }),
      { numRuns: runs },
    );
    if (process.env.SAPWOOD_REDO) writeFileSync(process.env.SAPWOOD_REDO, JSON.stringify(seen));
    expect(seen.exact).toBeGreaterThan(runs / 4);
    expect(seen.rebased).toBeGreaterThan(runs / 4);
    expect(seen.auto).toBeGreaterThan(runs / 10);
  }, 600_000);
});
