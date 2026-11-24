import { describe, expect, it } from "vitest";
import { Sapwood } from "../api/sapwood.ts";
import { cloneDoc } from "./doc.ts";
import { cellTouches, entityTouches, type HistoryStep } from "./history.ts";

const SCHEMA = `types:\n  Weapon: { fields: { damage: float } }\n`;

/** A project and a run of changes to it, each as a "commit": its ops. */
function run() {
  const s = Sapwood.load(SCHEMA, { packs: [{ name: "dlc" }], sheets: [{ name: "W", rows: [["Weapon", "w1", 10], ["Weapon", "w2", 5]] }] });
  const start = cloneDoc(s.doc);
  const steps: HistoryStep[] = [];
  const step = (name: string, f: () => { ops: HistoryStep["ops"] }) => steps.push({ commit: name, ops: f().ops });
  step("c1", () => s.set("w2", { damage: 6 })); // not w1
  step("c2", () => s.set("w1", { damage: 12 }));
  step("c3", () => s.set("w1", { $id: "blaster" })); // a rename
  step("c4", () => s.moveEntities(["blaster"], "dlc")); // a move
  step("c5", () => s.set("blaster", { $active: false }));
  return { s, start, steps };
}

describe("history of one entity or cell (§8.7)", () => {
  it("an entity: the commits that changed it, through a rename and a move", () => {
    const { start, steps } = run();
    expect(entityTouches(start, steps, "blaster").map((t) => [t.commit, t.idBefore, t.idAfter])).toEqual([
      ["c2", "w1", "w1"],
      ["c3", "w1", "blaster"],
      ["c4", "blaster", "blaster"],
      ["c5", "blaster", "blaster"],
    ]);
    expect(entityTouches(start, steps, "w2").map((t) => t.commit)).toEqual(["c1"]);
  });

  it("a cell: the commits that changed it, and the one that took its row away", () => {
    const { s, start, steps } = run();
    const sheet = s.project.sheetId("W");
    const w = start.sheets.get(sheet)!;
    const [r1] = w.rows.order;
    const damage = w.cols.order[2]!;
    expect(cellTouches(start, steps, sheet, r1!, damage).map((t) => t.commit)).toEqual(["c2", "c4"]); // set, then the row moved away
  });
});
