// Engine and validation timings at scale, on S2's workload: one Projectile, then four
// Weapons that use it, repeated. Each weapon computes dps (=C/D) and impact
// (=ENTITY(E).speed*C); a scratch sheet sums every weapon's dps.
//
//   node packages/core/bench/engine.bench.ts [rows]

import { Project } from "../src/project/project.ts";
import { validate } from "../src/project/validate.ts";
import { resolveSchema } from "../src/schema/resolve.ts";
import { parseSchema } from "../src/schema/yaml.ts";

const N = Number(process.argv[2] ?? 100_000);

const SCHEMA = `
types:
  Projectile:
    fields: { speed: int, lifetime: float, sprite: string }
  Weapon:
    fields:
      damage: float
      cooldown: float
      projectile: "ref<Projectile>"
      dps: float
      impact: float
`;

function time<T>(label: string, fn: () => T): T {
  const t = performance.now();
  const out = fn();
  console.log(`${label.padEnd(44)} ${(performance.now() - t).toFixed(1).padStart(9)} ms`);
  return out;
}

const rows: string[][] = [];
for (let g = 0; rows.length < N; g++) {
  const p = `p${g}`;
  rows.push(["Projectile", p, String(300 + (g % 700)), String(1 + (g % 4)), `${p}.png`]);
  for (let k = 0; k < 4 && rows.length < N; k++) {
    const r = rows.length + 1;
    rows.push(["Weapon", `w${g}_${k}`, String(5 + ((g * 7 + k * 3) % 90)), String(0.25 * (1 + ((g + k) % 8))), p, `=C${r}/D${r}`, `=ENTITY(E${r}).speed*C${r}`]);
  }
}

const schema = resolveSchema(parseSchema(SCHEMA).schema);
const p = new Project(schema);
const data = p.addSheet("Weapons");
const calc = p.addSheet("Totals", p.wb.root, "scratch");
console.log(`${N} rows`);
time("load (setRows, everything recalculates)", () => p.setRows(data, rows));
time("total formulas", () => p.setRows(calc, [['=SUM(ENTITIES("Weapon", "dps"))', '=ROWS(ENTITIES("Weapon"))']]));
const total = () => p.engine.get(calc, "A1");
console.log("  total dps", total(), "weapons", p.engine.get(calc, "B1"));
time("validate", () => validate(p));
time("validate again", () => validate(p));

const edit = (label: string, a1: string, input: string) => {
  const before = p.engine.get(data, a1);
  time(`edit ${label}`, () => p.set(data, a1, input));
  console.log(`  evaluations ${p.engine.lastEvaluations}`);
  time(`  edit ${label} + validate`, () => {
    p.set(data, a1, String(before));
    validate(p);
  });
};
edit("projectile sprite (nothing reads it)", "E1", "x.png");
edit("projectile speed (four weapons read it)", "C1", "999");
edit("weapon damage", "C2", "50");
edit("weapon ID", "B2", "renamed");
console.log("  total dps", total());
const structure = (label: string, fn: () => unknown) => {
  time(label, fn);
  time("  then validate", () => validate(p));
};
structure("insert a row at the top", () => p.insert(data, "row", 1));
structure("delete it", () => p.remove(data, "row", 1));
structure("move a weapon to the end", () => p.move(data, "row", 2, 1, N));
console.log("  total dps", total());
time("fromDoc (rebuild the engine from the document)", () => Project.fromDoc(p.doc));

if (process.env.REPEAT) {
  const n = Number(process.env.REPEAT);
  time(`${n} weapon damage edits`, () => {
    for (let i = 0; i < n; i++) p.set(data, "C2", String(i));
  });
}
