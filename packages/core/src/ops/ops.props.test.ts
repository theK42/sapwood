// Property tests for ops on the real model. Random edits go through the project's own
// edit API (by position, as a user or an LLM would make them), and then:
//
//  - undo: applying the inverses gives back exactly the document we started from;
//  - replay: the recorded ops, applied to a copy of the base document, give the same document;
//  - mirror: the engine, updated op by op, agrees with an engine built from scratch
//    from the final document (values, validation and export). Validation runs at random
//    points along the way too, so what it keeps between runs is tested against a fresh one.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { exportJson } from "../export/json.ts";
import { isErr } from "../formula/values.ts";
import { loadProject } from "../project/load.ts";
import type { Edit, Project } from "../project/project.ts";
import { Project as P } from "../project/project.ts";
import { validate } from "../project/validate.ts";
import { canonDoc, cloneDoc, docFromJson, docsEqual, docToJson, isLive, splitCellKey } from "./doc.ts";
import { checkOps } from "./check.ts";
import { applyOp, OpError, type Op } from "./ops.ts";

const RUNS = Number(process.env.RUNS ?? 300);
type Gen = fc.GeneratorValue;
const int = (g: Gen, max: number): number => g(fc.integer, { min: 0, max });
const pick = <T,>(g: Gen, xs: readonly T[]): T => xs[int(g, xs.length - 1)]!;

const SCHEMA = `
structs:
  Hit: { fields: { target: "ref<Projectile>", n: int } }
types:
  Weapon: { fields: { damage: float, shots: "list<ref<Projectile>>", main: "ref<Projectile>", hit: "struct<Hit>" } }
  Projectile: { fields: { speed: float } }
`;

const IDS = ["a", "b", "c", "d"];
const CONTENT = [
  "", "1", "2.5", "TRUE", "text", ...IDS, '["a", "b"]', '[ "c" ]', '{"target": "a", "n": 1}',
  "=C2+1", "=SUM(C:C)", '=ENTITY("a").speed', "=T!C2*2", "=#REF!", "=1+", "=Nowhere!A1",
  '=SUM(ENTITIES("Projectile", "speed"))', '=INDEX(ENTITIES("Projectile", "speed"), 2)', '=ROWS(ENTITIES("Weapon"))',
  '=INDEX(ENTITIES("Weapon", "damage"), 1)', '=INDEX(ENTITIES("Projectile"), 1)',
];

function base(): Project {
  return loadProject(SCHEMA, {
    sheets: [
      { name: "S", rows: [["Weapon", "w1", 1, '["a"]', "b"], ["Projectile", "a", 3], ["Projectile", "b", 4], ["Weapon", "w2", "=C1*2"]] },
      { name: "T", rows: [["Projectile", "c", 5], ["Projectile", "d", 6], ["#Projectile", "a", 7]] },
      { name: "Notes", kind: "scratch", rows: [["x", "=S!C1"]] },
    ],
  }).project;
}

/** One random edit by position. Null when the chosen edit can't apply here. */
function genEdit(g: Gen, p: Project): Edit | null {
  const sheets = [...p.wb.sheets.values()];
  const s = pick(g, sheets);
  const rows = s.rows.length;
  const cols = s.cols.length;
  const data = s.kind === "data";
  const kind = pick(g, ["set", "set", "set", "set", "format", "insert", "remove", "move", "rename", "sheet"] as const);
  const axis = int(g, 3) === 0 ? "col" : "row";
  const len = axis === "row" ? rows : cols;
  const first = axis === "col" && data ? 3 : 1; // A and B stay put on data sheets
  try {
    switch (kind) {
      case "set": {
        const col = 1 + int(g, cols + 1);
        const input = col === 1 && data ? pick(g, ["", "Weapon", "Projectile", "#Weapon", "# note"]) : col === 2 ? pick(g, ["", ...IDS, "e"]) : pick(g, CONTENT);
        return p.set(s.id, `${String.fromCharCode(64 + col)}${1 + int(g, rows + 1)}`, input);
      }
      case "format":
        return p.setFormat(s.id, `${String.fromCharCode(65 + int(g, cols))}${1 + int(g, rows)}`, pick(g, [null, { bold: true }, { fill: "#f00" }]));
      case "insert":
        return p.insert(s.id, axis, first + int(g, Math.max(0, len + 1 - first)), 1 + int(g, 1));
      case "remove":
        return len >= first ? p.remove(s.id, axis, first + int(g, len - first), 1 + int(g, 1)) : null;
      case "move":
        return len > first ? p.move(s.id, axis, first + int(g, len - first), 1, first + int(g, len - first)) : null;
      case "rename": {
        const from = pick(g, IDS);
        return p.renameId(from, pick(g, [...IDS, "e"].filter((x) => x !== from)));
      }
      case "sheet":
        return editOps(p, pick(g, [
          { kind: "renameSheet", sheet: s.id, name: pick(g, ["S", "T", "U", "Notes"]) },
          { kind: "createPack", pack: "pk", name: "pk", parent: "root" },
          { kind: "setSheetPack", sheet: s.id, pack: pick(g, ["root", "pk"]) },
        ] as Op[]));
    }
  } catch (e) {
    if (e instanceof OpError) return null; // e.g. moving column A, or a duplicate sheet name
    throw e;
  }
}

function editOps(p: Project, op: Op): Edit {
  return { ops: [op], inverse: p.apply([op]) };
}

/** Everything observable about a project, rendered as text. */
function observe(p: Project): unknown {
  const values: string[] = [];
  for (const s of p.doc.sheets.values())
    for (const k of s.cells.keys()) {
      const [row, col] = splitCellKey(k);
      if (!isLive(s.rows, row) || !isLive(s.cols, col)) continue;
      const v = p.engine.cellById(s.id, row, col).value;
      values.push(`${s.id}!${k}=${isErr(v) ? v.code : JSON.stringify(v)}`);
    }
  return {
    values: values.sort(),
    issues: validate(p).issues.map((i) => `${i.code} ${i.message} ${JSON.stringify(i.at ?? null)}`).sort(),
    export: exportJson(p, { allowInvalid: true }),
  };
}

function explain<T>(ctx: () => unknown, body: () => T): T {
  try {
    return body();
  } catch (e) {
    throw new Error(`${(e as Error).message}\n${JSON.stringify(ctx(), null, 1).slice(0, 4000)}`);
  }
}

const prop = (name: string, body: (g: Gen) => void) => it(name, () => fc.assert(fc.property(fc.gen(), body), { numRuns: RUNS }), 300_000);

describe("ops on the real model (properties)", () => {
  prop("undo, replay and mirror", (g) => {
    const p = base();
    const start = cloneDoc(p.doc);
    const edits: Edit[] = [];
    for (let i = int(g, 8); i >= 0; i--) {
      const e = genEdit(g, p);
      if (e) edits.push(e);
      if (int(g, 2) === 0) validate(p);
    }
    const ops = edits.flatMap((e) => e.ops);
    explain(() => ({ ops }), () => {
      // replay
      const doc = cloneDoc(start);
      for (const op of ops) applyOp(doc, op);
      expect(canonDoc(doc)).toEqual(canonDoc(p.doc));
      // docsEqual says what comparing canonDoc()s says, for equal documents and for unequal
      // ones: the start, a replay part way, the end, and copies made by JSON (no shared cells).
      const part = cloneDoc(start);
      for (const op of ops.slice(0, int(g, ops.length))) applyOp(part, op);
      const canon = (d: typeof doc) => JSON.stringify(canonDoc(d));
      for (const [x, y] of [[doc, p.doc], [start, p.doc], [part, p.doc], [start, part], [docFromJson(JSON.parse(JSON.stringify(docToJson(p.doc)))), doc]] as const)
        expect(docsEqual(x, y)).toBe(canon(x) === canon(y));
      // checkOps takes every op as it comes over HTTP, unchanged
      expect(checkOps(JSON.parse(JSON.stringify(ops)))).toEqual(ops);
      // mirror
      expect(observe(P.fromDoc(cloneDoc(p.doc)))).toEqual(observe(p));
      // undo
      for (const e of [...edits].reverse()) p.apply(e.inverse);
      expect(canonDoc(p.doc)).toEqual(canonDoc(start));
      expect(docsEqual(p.doc, start)).toBe(true);
      expect(observe(p)).toEqual(observe(base()));
    });
  });
});

describe("the generator", () => {
  it("covers every kind of op, and edits that fail as well as ones that apply", () => {
    const kinds = new Map<string, number>();
    let failed = 0;
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const p = base();
        for (let i = 0; i < 8; i++) {
          const e = genEdit(g, p);
          if (!e) failed++;
          for (const op of e?.ops ?? []) kinds.set(op.kind, (kinds.get(op.kind) ?? 0) + 1);
        }
      }),
      { numRuns: 200 },
    );
    for (const k of ["setCell", "setFormat", "insert", "delete", "move", "renameId", "renameSheet", "createPack", "setSheetPack"]) expect(kinds.get(k) ?? 0, k).toBeGreaterThan(10);
    expect(failed).toBeGreaterThan(0);
  });
});
