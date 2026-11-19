// S1 benchmark: the same workbooks in our engine and in IronCalc (native Node addon
// and WASM). Run with `npm run bench -w spikes/s1-formula`.
//
// Every "edit" time includes the recalculation needed to make all values correct.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { Engine } from "./engine.ts";
import { Workbook } from "./model.ts";

type CellIn = [sheet: number, row: number, col: number, input: string];

interface Adapter {
  name: string;
  load(sheets: string[], cells: CellIn[]): void;
  edit(sheet: number, row: number, col: number, input: string): void;
  get(sheet: number, row: number, col: number): unknown;
  insertRow(sheet: number, row: number): void;
}

// ------------------------------------------------------------------ adapters

function sapwood(): Adapter & { engine: () => Engine; sheetIds: () => string[] } {
  let e: Engine;
  let ids: string[] = [];
  return {
    name: "sapwood (TS)",
    engine: () => e,
    sheetIds: () => ids,
    load(sheets, cells) {
      const wb = new Workbook();
      ids = sheets.map((n) => wb.addSheet(n, wb.root, n === "Weapon" ? "data" : "scratch"));
      e = new Engine(wb);
      e.batch(() => {
        for (const [s, r, c, v] of cells) e.setAt(ids[s]!, r, c, v);
      });
    },
    edit: (s, r, c, v) => e.setAt(ids[s]!, r, c, v),
    get: (s, r, c) => e.getAt(ids[s]!, r, c),
    insertRow: (s, r) => void e.insertRows(ids[s]!, r),
  };
}

const require = createRequire(import.meta.url);

function ironcalcNode(): Adapter {
  const { Model } = require("@ironcalc/nodejs") as typeof import("@ironcalc/nodejs");
  let m: InstanceType<typeof Model>;
  return {
    name: "IronCalc (native addon)",
    load(sheets, cells) {
      m = new Model("bench", "en", "UTC", "en");
      sheets.forEach((n, i) => (i === 0 ? m.renameSheet(0, n) : m.addSheet(n)));
      for (const [s, r, c, v] of cells) m.setUserInput(s, r, c, v);
      m.evaluate();
    },
    edit(s, r, c, v) {
      m.setUserInput(s, r, c, v);
      m.evaluate();
    },
    get: (s, r, c) => m.getCellValue(s, r, c),
    insertRow(s, r) {
      m.insertRows(s, r, 1);
      m.evaluate();
    },
  };
}

async function ironcalcWasm(): Promise<Adapter> {
  const mod = (await import("@ironcalc/wasm")) as typeof import("@ironcalc/wasm");
  const wasmPath = require.resolve("@ironcalc/wasm/wasm_bg.wasm");
  mod.initSync({ module: readFileSync(wasmPath) });
  let m: InstanceType<typeof mod.Model>;
  return {
    name: "IronCalc (WASM)",
    load(sheets, cells) {
      m = new mod.Model("bench", "en", "UTC", "en");
      m.pauseEvaluation();
      sheets.forEach((n, i) => {
        if (i > 0) m.newSheet();
        m.renameSheet(i, n);
      });
      for (const [s, r, c, v] of cells) m.setUserInput(s, r, c, v);
      m.resumeEvaluation();
      m.evaluate();
    },
    edit: (s, r, c, v) => m.setUserInput(s, r, c, v), // UserModel evaluates on every edit
    get: (s, r, c) => m.getFormattedCellValue(s, r, c),
    insertRow: (s, r) => m.insertRows(s, r, 1),
  };
}

// ------------------------------------------------------------------ workbooks

const N = Number(process.env.N ?? 10_000);

function chain(): CellIn[] {
  const out: CellIn[] = [[0, 1, 1, "1"]];
  for (let r = 2; r <= N; r++) out.push([0, r, 1, `=A${r - 1}+1`]);
  return out;
}

function fan(): CellIn[] {
  const out: CellIn[] = [[0, 1, 1, "1"]];
  for (let r = 1; r <= N; r++) {
    out.push([0, r, 3, String(r)]);
    out.push([0, r, 2, `=$A$1*C${r}+1`]);
  }
  return out;
}

/** Sheets: 0 Weapon, 1 Tuning, 2 Summary. 3 formulas per weapon row plus whole-column aggregates. */
function weapons(): CellIn[] {
  const out: CellIn[] = [[1, 1, 2, "1.5"]];
  for (let i = 1; i <= 50; i++) {
    out.push([1, i, 4, String((i - 1) * 2)]);
    out.push([1, i, 5, `T${i}`]);
  }
  for (let r = 1; r <= N; r++) {
    out.push([0, r, 1, "Weapon"], [0, r, 2, `w${r}`]);
    out.push([0, r, 3, String((r % 97) + 1)], [0, r, 4, String(0.1 + (r % 7) / 10)]);
    out.push([0, r, 5, `=C${r}/D${r}`]);
    out.push([0, r, 6, `=E${r}*Tuning!$B$1`]);
    out.push([0, r, 7, `=VLOOKUP(C${r},Tuning!$D$1:$E$50,2,TRUE)`]);
  }
  out.push([2, 1, 1, "=SUM(Weapon!F:F)"], [2, 2, 1, "=MAX(Weapon!E:E)"], [2, 3, 1, '=COUNTIF(Weapon!G:G,"T5")']);
  return out;
}

// ------------------------------------------------------------------ harness

interface Row {
  engine: string;
  scenario: string;
  ms: number;
  check: string;
}
const rows: Row[] = [];

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

/** Median of `reps` timed runs (after one warm-up). */
function median(reps: number, fn: (i: number) => void): number {
  fn(-1);
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) ts.push(time(() => fn(i)));
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)]!;
}

function record(engine: string, scenario: string, ms: number, check: unknown): void {
  rows.push({ engine, scenario, ms, check: String(check) });
}

function run(a: Adapter): void {
  // Chain: a 10k-deep dependency chain, edit the head.
  record(a.name, "chain: load", time(() => a.load(["S"], chain())), a.get(0, N, 1));
  record(a.name, "chain: edit head", median(9, (i) => a.edit(0, 1, 1, String(i + 2))), a.get(0, N, 1));

  // Fan-out: 10k formulas read one cell.
  record(a.name, "fan: load", time(() => a.load(["S"], fan())), a.get(0, N, 2));
  record(a.name, "fan: edit shared input", median(9, (i) => a.edit(0, 1, 1, String(i + 2))), a.get(0, N, 2));
  record(a.name, "fan: edit one leaf input", median(9, (i) => a.edit(0, 5000, 3, String(i + 2))), a.get(0, 5000, 2));

  // Realistic: weapon table with lookups and whole-column aggregates.
  record(a.name, "weapons: load (30k formulas)", time(() => a.load(["Weapon", "Tuning", "Summary"], weapons())), a.get(2, 1, 1));
  record(a.name, "weapons: edit global multiplier", median(9, (i) => a.edit(1, 1, 2, String(1 + i / 10))), a.get(2, 1, 1));
  record(a.name, "weapons: edit one damage cell", median(9, (i) => a.edit(0, 5000, 3, String(i + 10))), a.get(2, 1, 1));
  record(a.name, "weapons: edit lookup table", median(9, (i) => a.edit(1, 5, 5, `T5${i % 2 ? "x" : ""}`)), a.get(2, 3, 1));
  record(a.name, "weapons: insert row at top", median(5, () => a.insertRow(0, 1)), a.get(2, 1, 1));
}

function runEntities(): void {
  const a = sapwood();
  const cells = weapons();
  // Sheet 3: 10k ENTITY() reads, one per weapon.
  for (let r = 1; r <= N; r++) cells.push([3, r, 1, `=ENTITY("w${r}").damage*2`]);
  record(a.name, "entity: load (+10k ENTITY())", time(() => a.load(["Weapon", "Tuning", "Summary", "Calc"], cells)), "layout not set yet");
  const e = a.engine();
  const [weapon] = a.sheetIds() as [string];
  record(a.name, "entity: set layout (re-resolves 10k)", time(() => e.setLayout(weapon, "Weapon", ["damage", "cooldown"])), a.get(3, 1, 1));
  record(a.name, "entity: edit one damage cell", median(9, (i) => a.edit(0, 5000, 3, String(i + 10))), a.get(3, 5000, 1));
  record(a.name, "entity: move 100 rows", median(5, () => e.moveRows(weapon, 1, 100, 5000)), a.get(3, 1, 1));
  record(a.name, "entity: rename one ID", median(5, (i) => a.edit(0, 9000, 2, i % 2 ? "w9000" : "w9000x")), a.get(3, 9000, 1));
}

const adapters: Adapter[] = [sapwood(), ironcalcNode(), await ironcalcWasm()];
for (const a of adapters) if (!process.env.ONLY || a.name.includes(process.env.ONLY)) run(a);

/** Same as runEntities, but every ID is computed: B = Tuning!$A$1 & K. */
function runFormulaIds(): void {
  const a = sapwood();
  const cells: CellIn[] = weapons().map(([s, r, c, v]): CellIn =>
    s === 0 && c === 2 ? [0, r, 2, `=Tuning!$A$1&K${r}`] : [s, r, c, v]);
  cells.push([1, 1, 1, "w"]);
  for (let r = 1; r <= N; r++) cells.push([0, r, 11, String(r)], [3, r, 1, `=ENTITY("w${r}").damage*2`]);
  cells.push([3, 1, 2, '=ROWS(ENTITIES("Weapon"))']);
  const name = "sapwood, formula IDs";
  record(name, "fid: load (+10k ID formulas)", time(() => a.load(["Weapon", "Tuning", "Summary", "Calc"], cells)), "layout not set yet");
  const e = a.engine();
  const [weapon] = a.sheetIds() as [string];
  record(name, "fid: set layout (re-resolves 10k)", time(() => e.setLayout(weapon, "Weapon", ["damage", "cooldown"])), a.get(3, 1, 1));
  record(name, "fid: edit one damage cell", median(9, (i) => a.edit(0, 5000, 3, String(i + 10))), a.get(3, 5000, 1));
  record(name, "fid: rename one (edit its K)", median(9, (i) => a.edit(0, 9000, 11, i % 2 ? "9000" : "90000")), a.get(3, 9000, 1));
  record(name, "fid: rename all 10k (edit prefix)", median(5, (i) => a.edit(1, 1, 1, i % 2 ? "w" : "v")), `${String(a.get(3, 1, 1))}, ROWS=${String(a.get(3, 1, 2))}, ${e.lastEvaluations} evals`);
  record(name, "fid: move 100 rows", median(5, () => e.moveRows(weapon, 1, 100, 5000)), a.get(3, 1, 1));
}
runEntities();
runFormulaIds();

const width = Math.max(...rows.map((r) => r.scenario.length));
let last = "";
for (const r of rows) {
  if (r.engine !== last) console.log(`\n${(last = r.engine)}`);
  console.log(`  ${r.scenario.padEnd(width)}  ${(r.ms < 1 ? r.ms.toFixed(2) : r.ms.toFixed(1)).padStart(9)} ms   (${r.check})`);
}
