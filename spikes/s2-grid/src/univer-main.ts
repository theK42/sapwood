/**
 * The same model in Univer. Univer has its own workbook model, command system, undo
 * stack and formula engine; here they are reduced to a render cache: every edit,
 * paste and undo is intercepted and becomes one of our ops, and our results are
 * written back with mutations (which bypass Univer's undo stack).
 */
import "@univerjs/preset-sheets-core/lib/index.css";
import { CalculationMode, SheetExtension, UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { copyPayload, parsePaste } from "./clipboard.ts";
import { drawGutter, drawIssue, scrollBench } from "./overlay.ts";
import { colName, COLS, SheetModel, TYPES } from "./sheet-model.ts";

const ROWS = Number(new URLSearchParams(location.search).get("rows") ?? 100_000);
const model = new SheetModel(ROWS);
(window as unknown as { model: SheetModel }).model = model;

// ------------------------------------------------------------ page chrome

const root = document.getElementById("root")!;
root.innerHTML = `
  <div class="bar">
    <label>Header: <select id="pin"><option value="">follow cursor</option>${TYPES.map((t) => `<option>${t.name}</option>`).join("")}</select></label>
    <button id="undo">Undo</button><button id="redo">Redo</button><button id="bench">Scroll test</button>
  </div>
  <div class="grid" id="univer"></div>
  <div class="status"><span id="load"></span><span id="op"></span><span id="bench-out"></span></div>`;
const $ = (id: string) => document.getElementById(id)!;

// ------------------------------------------------------------ snapshot from our model

type CellData = Record<number, Record<number, { v?: string | number | boolean; f?: string }>>;
const toUniver = (r: number, c: number) => {
  const v = model.cell(r, c);
  if (v.input === "") return {};
  const val = typeof v.value === "number" || typeof v.value === "boolean" ? v.value : v.text;
  return v.isFormula ? { v: val, f: v.input } : { v: val };
};

const t0 = performance.now();
const cellData: CellData = {};
for (let r = 1; r <= model.rowCount; r++) {
  const row: CellData[number] = {};
  for (let c = 1; c <= COLS; c++) {
    const x = toUniver(r, c);
    if (x.v !== undefined) row[c - 1] = x;
  }
  cellData[r - 1] = row;
}
const snapshotMs = performance.now() - t0;

const { univerAPI } = createUniver({
  locale: LocaleType.EN_US,
  locales: { [LocaleType.EN_US]: mergeLocales(enUS) },
  presets: [
    UniverSheetsCorePreset({
      container: "univer",
      // Our engine computes everything; Univer's must never run.
      formula: { initialFormulaComputing: CalculationMode.NO_CALCULATION },
    }),
  ],
});

// NO_CALCULATION covers only the initial load: any later mutation that carries `f`
// starts Univer's engine, which overwrites our values (it has no ENTITY()). Block it.
let blockedCalcs = 0;
univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (p: any) => {
  if (/^formula\.mutation\.set-(trigger-)?formula-calculation-(start|result)$/.test(p.id)) {
    blockedCalcs++;
    p.cancel = true;
  }
});
(window as unknown as { blockedCalcs: () => number }).blockedCalcs = () => blockedCalcs;

const t1 = performance.now();
const wb = univerAPI.createWorkbook({
  id: "wb",
  name: "Arsenal",
  sheetOrder: ["s1"],
  sheets: {
    s1: { id: "s1", name: "Arsenal", rowCount: ROWS, columnCount: COLS, cellData, defaultColumnWidth: 110 },
  },
});
const createMs = performance.now() - t1;
(window as unknown as { univerAPI: unknown }).univerAPI = univerAPI;
const sheet = wb.getActiveSheet();
sheet.setFrozenColumns(2);
$("load").innerHTML = `<b>${ROWS.toLocaleString()}</b> rows: engine <b>${model.loadMs.toFixed(0)} ms</b>, snapshot ${snapshotMs.toFixed(0)} ms, Univer load <b>${createMs.toFixed(0)} ms</b>`;

// ------------------------------------------------------------ write-back: our values into Univer's model, outside its undo stack

function writeBack(cells: [number, number][]): void {
  if (cells.length === 0) return;
  const cellValue: CellData = {};
  for (const [r, c] of cells) {
    if (c > COLS) continue;
    const x = toUniver(r, c);
    (cellValue[r - 1] ??= {})[c - 1] = x.v === undefined ? { v: null as unknown as string, f: null as unknown as string } : { f: null as unknown as string, ...x };
  }
  univerAPI.executeCommand("sheet.mutation.set-range-values", { unitId: "wb", subUnitId: "s1", cellValue });
}

function afterOp(edited: [number, number][]): void {
  writeBack([...edited, ...model.lastChanged]);
  $("op").innerHTML = `last op <b>${model.lastEditMs.toFixed(1)} ms</b>, ${model.lastEvaluations} evaluations; ops <b>${model.undo.length}</b>`;
  refreshHeader();
}

function commit(cells: { r: number; c: number; input: string }[]): void {
  model.edit(cells);
  afterOp(cells.map(({ r, c }) => [r, c]));
}

// ------------------------------------------------------------ edits become ops

univerAPI.addEvent(univerAPI.Event.BeforeSheetEditEnd, (p) => {
  if (!p.isConfirm) return;
  const text = (p.value as unknown as { toPlainText(): string }).toPlainText().replace(/\r?\n$/, "");
  p.cancel = true; // Univer's model is not the truth; ours is.
  queueMicrotask(async () => {
    // Cancelling keeps Univer's editor open; close it without saving into Univer's model.
    await wb.abortEditingAsync();
    commit([{ r: p.row + 1, c: p.column + 1, input: text }]);
    // Enter should still move down, as it does in every spreadsheet.
    if (p.keycode === 13 /* Enter */) sheet.setActiveRange(sheet.getRange(p.row + 1, p.column));
  });
});

// Clipboard and undo: capture before Univer sees them.
const inGrid = () => document.activeElement?.closest("#univer") !== null || document.activeElement === document.body;
const selectionRect = () => {
  const r = sheet.getActiveRange()?.getRange();
  return r ? { r: r.startRow + 1, c: r.startColumn + 1, rows: r.endRow - r.startRow + 1, cols: r.endColumn - r.startColumn + 1 } : null;
};
window.addEventListener(
  "copy",
  (e) => {
    const rect = selectionRect();
    if (!inGrid() || !rect || !e.clipboardData || wb.isCellEditing()) return;
    const p = copyPayload(model, rect);
    e.clipboardData.setData("text/plain", p.text);
    e.clipboardData.setData("text/html", p.html);
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true,
);
window.addEventListener(
  "paste",
  (e) => {
    const rect = selectionRect();
    if (!inGrid() || !rect || !e.clipboardData || wb.isCellEditing()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const grid = parsePaste(e.clipboardData.getData("text/html"), e.clipboardData.getData("text/plain"), rect);
    const cells: { r: number; c: number; input: string }[] = [];
    grid.forEach((row, i) => row.forEach((input, j) => cells.push({ r: rect.r + i, c: rect.c + j, input })));
    commit(cells);
  },
  true,
);
// Univer's own paste path (context menu, its API) goes through commands: refuse those too.
univerAPI.addEvent(univerAPI.Event.BeforeClipboardPaste, (p) => {
  p.cancel = true;
});

function undo(redo: boolean): void {
  const op = redo ? model.redo.at(-1) : model.undo.at(-1);
  if (!op) return;
  if (redo) model.redoLast();
  else model.undoLast();
  const s = model.wb.sheet(model.sheet);
  afterOp(op.cells.map((x) => [s.rows.posOf(x.row) ?? 0, s.cols.posOf(x.col) ?? 0] as [number, number]));
}
window.addEventListener(
  "keydown",
  (e) => {
    if (!(e.ctrlKey || e.metaKey) || wb.isCellEditing()) return;
    const k = e.key.toLowerCase();
    if (k !== "z" && k !== "y") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    undo(k === "y" || e.shiftKey);
  },
  true,
);
$("undo").onclick = () => undo(false);
$("redo").onclick = () => undo(true);

// ------------------------------------------------------------ validation overlay and type gutter

class ValidationOverlay extends SheetExtension {
  override uKey = "SapwoodValidation";
  protected override Z_INDEX = 100;
  override draw(ctx: CanvasRenderingContext2D, _scale: unknown, skeleton: any): void {
    const { startRow, endRow, startColumn, endColumn } = skeleton.rowColumnSegment;
    if (startRow < 0) return;
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startColumn; c <= endColumn; c++) {
        // Pixel bounds come from the layout accumulators (cumulative row heights / column widths).
        const rows: number[] = skeleton.rowHeightAccumulation;
        const cols: number[] = skeleton.columnWidthAccumulation;
        const y = r === 0 ? 0 : rows[r - 1]!;
        const x = c === 0 ? 0 : cols[c - 1]!;
        const rect = { x, y, width: cols[c]! - x, height: rows[r]! - y };
        if (c === 0) {
          const t = model.rowType(r + 1);
          if (t) drawGutter(ctx, rect, t.color);
        }
        const issue = model.cell(r + 1, c + 1).issue;
        if (issue) drawIssue(ctx, rect, issue);
      }
    }
  }
}
// The render unit appears asynchronously after createWorkbook.
const whenRendered = (fn: () => void, tries = 0): void => {
  try {
    fn();
  } catch (e) {
    if (tries > 200) throw e;
    setTimeout(() => whenRendered(fn, tries + 1), 25);
  }
};
whenRendered(() => {
  (univerAPI as any).registerSheetMainExtension("wb", new ValidationOverlay());
  $("load").innerHTML += `, first paint after <b>${(performance.now() - t1).toFixed(0)} ms</b>`;
});

// Hover message for issues.
const tip = document.createElement("div");
tip.className = "tip";
tip.hidden = true;
document.body.append(tip);
univerAPI.addEvent((univerAPI.Event as any).CellPointerMove, (p: any) => {
  const issue = p.row != null ? model.cell(p.row + 1, p.column + 1).issue : null;
  tip.hidden = !issue;
  if (issue) {
    tip.className = `tip ${issue.level}`;
    tip.textContent = issue.message;
  }
});
document.addEventListener("pointermove", (e) => {
  tip.style.left = `${e.clientX + 14}px`;
  tip.style.top = `${e.clientY + 10}px`;
});

// ------------------------------------------------------------ sticky header

let pinned = "";
let headerKey = "";
function refreshHeader(): void {
  const r = sheet.getActiveRange()?.getRange().startRow ?? 0;
  const top = (sheet.getScrollState?.() as any)?.sheetViewStartRow ?? 0;
  let type = pinned ? (TYPES.find((t) => t.name === pinned) ?? null) : model.rowType(r + 1);
  for (let x = top + 1; !type && x < top + 60; x++) type = model.rowType(x);
  const key = type?.name ?? "";
  if (key === headerKey) return;
  headerKey = key;
  const columnsCfg: Record<number, unknown> = {};
  for (let c = 1; c <= COLS; c++) {
    const label = c === 1 ? "type" : c === 2 ? "id" : (model.fieldAt(type, c)?.name ?? "");
    columnsCfg[c - 1] = label ? { text: `${colName(c)} · ${label}`, backgroundColor: c > 2 && type ? type.color + "22" : undefined } : colName(c);
  }
  (wb as any).customizeColumnHeader({ columnsCfg });
}
univerAPI.addEvent(univerAPI.Event.SelectionChanged, () => refreshHeader());
univerAPI.addEvent((univerAPI.Event as any).Scroll, () => refreshHeader());
($("pin") as HTMLSelectElement).onchange = (e) => {
  pinned = (e.target as HTMLSelectElement).value;
  refreshHeader();
};
whenRendered(() => setTimeout(() => ((headerKey = "~"), refreshHeader()), 300));

// ------------------------------------------------------------ scroll benchmark

$("bench").onclick = async () => {
  $("bench-out").textContent = "scrolling…";
  const r = await scrollBench(ROWS, (row) => sheet.scrollToCell(row, 0, 0));
  $("bench-out").textContent = `${r.fps.toFixed(0)} fps, p95 ${r.p95.toFixed(1)} ms, worst ${r.worst.toFixed(1)} ms`;
  (window as unknown as { benchResult: unknown }).benchResult = r;
};
(window as unknown as { univerAPI: unknown }).univerAPI = univerAPI;
