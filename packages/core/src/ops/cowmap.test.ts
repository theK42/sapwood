import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CowMap, differingKeys, forkMap } from "./cowmap.ts";

describe("a copy-on-write map", () => {
  it("behaves as a Map, through any mix of writes, copies and folds", () => {
    // Each step: set or delete a key, or fork (then go on with either the copy or the original).
    const step = fc.oneof(
      fc.record({ kind: fc.constant("set" as const), k: fc.integer({ min: 0, max: 3000 }), v: fc.integer() }),
      fc.record({ kind: fc.constant("delete" as const), k: fc.integer({ min: 0, max: 3000 }) }),
      fc.record({ kind: fc.constant("fork" as const), keep: fc.boolean() }),
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 4000 }), (steps) => {
        let m = new CowMap<number, number>();
        let ref = new Map<number, number>();
        const others: [CowMap<number, number>, Map<number, number>][] = [];
        for (const s of steps) {
          if (s.kind === "set") (m.set(s.k, s.v), ref.set(s.k, s.v));
          else if (s.kind === "delete") expect(m.delete(s.k)).toBe(ref.delete(s.k));
          else {
            const copy = m.fork();
            const copyRef = new Map(ref);
            if (s.keep) others.push([copy, copyRef]);
            else (others.push([m, ref]), (m = copy), (ref = copyRef));
          }
        }
        for (const [x, r] of [[m, ref] as const, ...others]) {
          expect(x.size).toBe(r.size);
          expect(new Map(x)).toEqual(r);
          for (const k of [0, 1, 7, 2999]) expect([x.has(k), x.get(k)]).toEqual([r.has(k), r.get(k)]);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("forkMap wraps a plain map without writing it", () => {
    const plain = new Map([["a", 1]]);
    const f = forkMap(plain);
    f.set("b", 2);
    f.delete("a");
    expect([...plain]).toEqual([["a", 1]]);
    expect([...f]).toEqual([["b", 2]]);
  });

  it("differingKeys never misses a key where two copies differ", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 2500 }), fc.option(fc.integer())), { maxLength: 3000 }), (writes) => {
        const start = new Map(Array.from({ length: 2000 }, (_, i) => [i, i] as [number, number]));
        const a = forkMap(start);
        const b = forkMap(start);
        for (const [left, k, v] of writes) {
          const m = left ? a : b;
          if (v === null) m.delete(k);
          else m.set(k, v);
        }
        const keys = differingKeys(a, b);
        if (keys === null) return; // folded: can't tell, and says so
        const listed = new Set(keys);
        for (let k = 0; k <= 2500; k++) if (a.get(k) !== b.get(k) || a.has(k) !== b.has(k)) expect(listed.has(k)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});
