// Profiling aid: build a 100k-row project, then rebuild it from its document.
//   node --cpu-prof --cpu-prof-dir=<dir> packages/core/bench/fromdoc.prof.ts [rows]
import { cloneDoc } from "../src/ops/doc.ts";
import { Project } from "../src/project/project.ts";
import { resolveSchema } from "../src/schema/resolve.ts";
import { parseSchema } from "../src/schema/yaml.ts";

const N = Number(process.argv[2] ?? 100_000);
const SCHEMA = `
types:
  Projectile:
    fields: { speed: int, lifetime: float, sprite: string }
  Weapon:
    fields: { damage: float, cooldown: float, projectile: "ref<Projectile>", dps: float, impact: float }
`;
const rows: string[][] = [];
for (let g = 0; rows.length < N; g++) {
  const p = `p${g}`;
  rows.push(["Projectile", p, String(300 + (g % 700)), String(1 + (g % 4)), `${p}.png`]);
  for (let k = 0; k < 4 && rows.length < N; k++) {
    const r = rows.length + 1;
    rows.push(["Weapon", `w${g}_${k}`, String(5 + ((g * 7 + k * 3) % 90)), String(0.25 * (1 + ((g + k) % 8))), p, `=C${r}/D${r}`, `=ENTITY(E${r}).speed*C${r}`]);
  }
}
const p = new Project(resolveSchema(parseSchema(SCHEMA).schema));
const data = p.addSheet("Weapons");
p.setRows(data, rows);
const doc = cloneDoc(p.doc);
const t = performance.now();
Project.fromDoc(doc);
console.log(`fromDoc ${(performance.now() - t).toFixed(0)} ms`);
