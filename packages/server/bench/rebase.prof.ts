// Profiling aid: a task read after another lands (rebased onto the new head).
//   node --cpu-prof --cpu-prof-dir=<dir> packages/server/bench/rebase.prof.ts [rows]
import { Project, resolveSchema, parseSchema } from "@thek42/sapwood-core";
import { Db } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

const N = Number(process.argv[2] ?? 100_000);
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
repo.head("main");
const edit = (who: string, id: string, v: number) => {
  const t = repo.createTask("main", who);
  repo.write(t.id, who, (s) => s.set(id, { damage: v }));
  return t.id;
};
const a = edit("ada", "w1_0", 51);
const b = edit("bob", "w2_0", 52);
repo.land(a, "ada");
let t = performance.now();
repo.view(b);
console.log(`rebased read ${(performance.now() - t).toFixed(0)} ms`);
repo.write(b, "bob", (s) => s.set("w2_1", { damage: 54 }));
const c = edit("ada", "w3_0", 53);
repo.land(c, "ada");
t = performance.now();
repo.land(b, "bob");
console.log(`rebased land ${(performance.now() - t).toFixed(0)} ms`);
