// Server timings at scale: loading a branch, and landing (DESIGN §12.3: a land under 2 s),
// on the engine bench's workload: one Projectile, then four Weapons that use it, repeated.
// Each weapon computes dps (=C/D) and impact (=ENTITY(E).speed*C).
//
//   node packages/server/bench/land.bench.ts [rows]

import { Project, resolveSchema, parseSchema, Sapwood } from "@thek42/sapwood-core";
import { Db } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

const N = Number(process.argv[2] ?? 10_000);

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
  console.log(`${label.padEnd(52)} ${(performance.now() - t).toFixed(1).padStart(9)} ms`);
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
const p = new Project(resolveSchema(parseSchema(SCHEMA).schema));
p.setRows(p.addSheet("Weapons"), rows);
const doc = p.doc;
console.log(`${N} rows`);

const db = new Db(":memory:");
let repo = new Repo(db);
time("init (the first snapshot)", () => repo.init(doc, "ada"));
repo = new Repo(db);
time("cold: load main's head", () => repo.head("main"));

const edit = (who: string, a1: string, value: number) => {
  const t = repo.createTask("main", who);
  repo.write(t.id, who, (s) => s.set(a1, { damage: value }));
  return t.id;
};
// A task's first read builds its own project from the base.
let t = time("a task's first edit (builds its project)", () => edit("ada", "w0_0", 50));
time("land, up to date", () => repo.land(t, "ada"));

// Two tasks open; one lands, the other is behind.
const a = edit("ada", "w1_0", 51);
const b = edit("bob", "w2_0", 52);
time("land, up to date (bob's task is open too)", () => repo.land(a, "ada"));
time("bob's next read: rebased onto the new head", () => repo.view(b));
// bob edits again, then ada lands first: bob's land rebases.
repo.write(b, "bob", (s) => s.set("w2_1", { damage: 54 }));
const c = edit("ada", "w3_0", 53);
repo.land(c, "ada");
time("land, rebased first", () => repo.land(b, "bob"));

// Lands until one writes a snapshot (every 50 commits along a branch).
let worst = 0;
for (let i = 0; i < 50; i++) {
  t = edit("ada", `w${4 + i}_0`, 60 + i);
  const s = performance.now();
  repo.land(t, "ada");
  worst = Math.max(worst, performance.now() - s);
}
console.log(`${"worst of 50 lands (one writes a snapshot)".padEnd(52)} ${worst.toFixed(1).padStart(9)} ms`);

repo = new Repo(db);
time("cold: load main's head again (snapshot + ops)", () => repo.head("main"));
time("Sapwood.fromDoc of the head (the engine rebuilt)", () => Sapwood.fromDoc(repo.stateAt(repo.branch("main").head)));
time("stateAt the head (the document alone)", () => repo.stateAt(repo.branch("main").head));
