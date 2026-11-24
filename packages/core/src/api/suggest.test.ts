import { describe, expect, it } from "vitest";
import { canonDoc, cloneDoc, docFromJson, docToJson } from "../ops/doc.ts";
import { applyOp } from "../ops/ops.ts";
import { reconcile } from "../ops/reconcile.ts";
import { Sapwood } from "./sapwood.ts";

const SCHEMA = `
types:
  Weapon: { fields: { damage: float, shots: "list<ref<Ammo>>" } }
  Ammo: { fields: { speed: float } }
`;
// dlc2 is inside dlc; other is beside dlc.
const project = (extra: unknown[][] = []) =>
  Sapwood.load(SCHEMA, {
    packs: [{ name: "dlc" }, { name: "dlc2", parent: "dlc" }, { name: "other" }],
    sheets: [
      { name: "Ammo", rows: [["Ammo", "a1", 1], ["Ammo", "a2", 2], ["Ammo", "a3", 3], ["Ammo", "a4", 4], ["Ammo", "a5", 5], ["Ammo", "a6", 6], ["Ammo", "a7", 7]] },
      { name: "Weapons", rows: [["Weapon", "w1", 1, '["a1"]'], ...extra] },
      { name: "Dlc", pack: "dlc", rows: [["Weapon", "w9", '=ENTITY("a6").speed', '["a2", "a5"]'], ["Weapon", "w8", "=Ammo!C7"]] },
      { name: "Dlc2", pack: "dlc2", rows: [["Weapon", "w7", 1, '["a2", "a3"]']] },
      { name: "Other", pack: "other", rows: [["Weapon", "wo", 1, '["a5"]']] },
    ],
  });

describe("suggested moves down the tree (DESIGN §7.4)", () => {
  it("the lowest pack all users reach, for entities used only from below", () => {
    const s = project();
    expect(s.suggestMoves().map((x) => `${x.id}: ${x.from} → ${x.to}`)).toEqual([
      "a2: root → dlc", // w9 in dlc, w7 in dlc2
      "a3: root → dlc2",
      "a6: root → dlc", // a formula's ENTITY("a6")
      "a7: root → dlc", // a formula reading its cell
    ]);
    // a1 is used from root, a4 by nothing, a5 from dlc and other (only root reaches both).
    expect(s.suggestMoves().find((x) => x.id === "a2")).toMatchObject({ usedBy: ["w9", "w7"], uses: 2 });
    expect(s.suggestMoves({ pack: "dlc" })).toEqual([]); // nothing in dlc and below could go lower
  });

  it("ENTITIES(\"Ammo\") in root uses every Ammo from there", () => {
    expect(project([["Weapon", "w2", '=COUNTA(ENTITIES("Ammo"))']]).suggestMoves()).toEqual([]);
  });

  it("an entity marked $keepHere isn't suggested; the mark is undone, saved and moved with it", () => {
    const s = project();
    const before = canonDoc(cloneDoc(s.doc));
    s.set("a2", { $keepHere: true });
    expect(s.get("a2").$keepHere).toBe(true);
    expect(s.get("a3").$keepHere).toBeUndefined();
    expect(s.suggestMoves().map((x) => x.id)).toEqual(["a3", "a6", "a7"]);
    expect(Sapwood.fromDoc(docFromJson(JSON.parse(JSON.stringify(docToJson(s.doc))))).get("a2").$keepHere).toBe(true);
    s.moveEntities(["a2"], "dlc");
    expect(s.get("a2")).toMatchObject({ $pack: "dlc", $keepHere: true });
    s.undo();
    s.undo();
    expect(canonDoc(s.doc)).toEqual(before);
    s.set("a2", { $keepHere: true });
    s.set("a2", { $keepHere: false });
    expect(s.get("a2").$keepHere).toBeUndefined();
  });

  it("restoring an earlier state sets and clears marks (reconcile)", () => {
    const s = project();
    const plain = cloneDoc(s.doc);
    s.set("a2", { $keepHere: true });
    const marked = cloneDoc(s.doc);
    for (const [from, to] of [[plain, marked], [marked, plain]] as const) {
      const d = cloneDoc(from);
      for (const op of reconcile(from, to)!) applyOp(d, op);
      expect(canonDoc(d)).toEqual(canonDoc(to));
    }
  });
});
