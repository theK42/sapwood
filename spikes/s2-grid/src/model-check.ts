import { SheetModel } from "./sheet-model.ts";
const m = new SheetModel(Number(process.env.N ?? 100_000));
console.log("rows", m.rowCount, "load ms", m.loadMs.toFixed(0));
for (const [r, c] of [[5, 2], [6, 3], [7, 3], [8, 2], [8, 5], [9, 2], [11, 3], [11, 6], [6, 1], [5, 7]] as const) {
  const v = m.cell(r, c);
  console.log(r, c, JSON.stringify(v.input), "->", v.text, v.issue ? `[${v.issue.level}] ${v.issue.message}` : "");
}
let t = performance.now(); m.cell(500, 3); console.log("first validate ms", (performance.now() - t).toFixed(1));
m.edit([{ r: 5, c: 3, input: "20" }]);
console.log("edit damage ms", m.lastEditMs.toFixed(1), "evals", m.lastEvaluations, "total", m.cell(11, 3).text, "rifle", m.cell(6, 3).text);
m.edit([{ r: 2, c: 3, input: "xx" }]);
console.log("edit prefix ms", m.lastEditMs.toFixed(1), "B5", m.cell(5, 2).text, "rifle", m.cell(6, 3).text);
m.undoLast(); console.log("undo -> B5", m.cell(5, 2).text, "rifle", m.cell(6,3).text);
t = performance.now(); for (let r = 1; r <= 60; r++) for (let c = 1; c <= 12; c++) m.cell(50000 + r, c); console.log("60x12 viewport read ms", (performance.now() - t).toFixed(1));
