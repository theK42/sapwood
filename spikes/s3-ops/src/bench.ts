// Rebase cost on a realistic sheet: N rows x 12 columns, two tasks of K ops each.
import { applyAll, newSheet, type Op, type State } from "./model.ts";
import { rebase } from "./rebase.ts";

const N = Number(process.env.N ?? 20_000);
const K = Number(process.env.K ?? 200);
const cols = Array.from({ length: 10 }, (_, i) => `c${i}`);
const rows = Array.from({ length: N }, (_, i) => `r${i}`);
const s = newSheet(rows, cols);
for (const r of rows) {
  s.cells.set(`${r}|type`, "Weapon");
  s.cells.set(`${r}|id`, `w${r}`);
  for (const c of cols) s.cells.set(`${r}|${c}`, String(r.length + c.length));
}
const base: State = new Map([["S", s]]);

let seed = 1;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
function task(prefix: string): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < K; i++) {
    const r = `r${rnd(N)}`;
    const k = rnd(20);
    if (k < 16) ops.push({ kind: "setCell", sheet: "S", row: r, col: cols[rnd(10)]!, content: String(i) });
    else if (k < 18) ops.push({ kind: "insert", sheet: "S", axis: "row", after: r, ids: [`${prefix}${i}`] });
    else if (k < 19) ops.push({ kind: "move", sheet: "S", axis: "row", after: `r${rnd(N)}`, ids: [r] });
    else ops.push({ kind: "renameId", from: `w${r}`, to: `${prefix}w${i}` });
  }
  // keep only ops valid in sequence
  const ok: Op[] = [];
  let st = base;
  for (const op of ops) {
    try {
      st = applyAll(st, [op]).state;
      ok.push(op);
    } catch {}
  }
  return ok;
}
const a = task("a"), b = task("b");
for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  const r = rebase(base, a, b);
  console.log(`${N} rows, ${a.length} + ${b.length} ops: rebase ${(performance.now() - t0).toFixed(0)} ms, ${r.conflicts.length} conflicts`);
}
