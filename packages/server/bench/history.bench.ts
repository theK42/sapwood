// History of one entity and one cell (DESIGN §8.7) on a branch with many commits.
//   node packages/server/bench/history.bench.ts [rows] [commits]
import { Project, resolveSchema, parseSchema } from "@thek42/sapwood-core";
import { Db } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

const N = Number(process.argv[2] ?? 100_000);
const C = Number(process.argv[3] ?? 100);
const rows: string[][] = [];
for (let g = 0; rows.length < N; g++) {
  const p = `p${g}`;
  rows.push(["Projectile", p, String(300 + (g % 700)), String(1 + (g % 4)), `${p}.png`]);
  for (let k = 0; k < 4 && rows.length < N; k++) {
    const r = rows.length + 1;
    rows.push(["Weapon", `w${g}_${k}`, String(5 + ((g * 7 + k * 3) % 90)), String(0.25 * (1 + ((g + k) % 8))), p, `=C${r}/D${r}`, `=ENTITY(E${r}).speed*C${r}`]);
  }
}
const p = new Project(resolveSchema(parseSchema(`types:\n  Projectile: { fields: { speed: int, lifetime: float, sprite: string } }\n  Weapon: { fields: { damage: float, cooldown: float, projectile: "ref<Projectile>", dps: float, impact: float } }\n`).schema));
p.setRows(p.addSheet("Weapons"), rows);
const repo = new Repo(new Db(":memory:"));
repo.init(p.doc, "ada");
for (let i = 0; i < C; i++) {
  const t = repo.createTask("main", "ada");
  repo.write(t.id, "ada", (s) => s.set(i % 10 === 0 ? "w0_0" : `w${i}_1`, { damage: 100 + i }));
  repo.land(t.id, "ada");
}
const time = (label: string, fn: () => unknown) => {
  const t = performance.now();
  const out = fn();
  console.log(`${label.padEnd(40)} ${(performance.now() - t).toFixed(0).padStart(7)} ms`);
  return out;
};
console.log(`${N} rows, ${C} commits`);
const h = time("entity history (w0_0)", () => repo.entityHistory("main", "w0_0")) as unknown[];
console.log(`  ${h.length} changes`);
time("entity history again", () => repo.entityHistory("main", "w0_0"));
const s = repo.head("main");
const sheet = s.project.sheetId("Weapons");
const sh = s.project.wb.sheet(sheet);
time("cell history (w0_0's damage)", () => repo.cellHistory("main", sheet, sh.rows.idAt(2), sh.cols.idAt(3)));
