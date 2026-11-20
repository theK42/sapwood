import "@glideapps/glide-data-grid/dist/index.css";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type DrawCellCallback,
  type DrawHeaderCallback,
  type EditListItem,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { copyPayload, parsePaste } from "./clipboard.ts";
import { drawGutter, drawIssue, Pulses, scrollBench } from "./overlay.ts";
import { colName, COLS, SheetModel, TYPES, type Issue } from "./sheet-model.ts";

const ROWS = Number(new URLSearchParams(location.search).get("rows") ?? 100_000);
const model = new SheetModel(ROWS);
const pulses = new Pulses();
(window as unknown as { model: SheetModel }).model = model; // for poking at it from devtools

function App() {
  const ref = useRef<DataEditorRef>(null);
  const [version, setVersion] = useState(0);
  const [selection, setSelection] = useState<GridSelection>({
    current: { cell: [2, 4], range: { x: 2, y: 4, width: 1, height: 1 }, rangeStack: [] },
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  });
  const [topRow, setTopRow] = useState(0);
  const [pinned, setPinned] = useState("");
  const [tip, setTip] = useState<{ x: number; y: number; issue: Issue } | null>(null);
  const [bench, setBench] = useState("");
  const [formulaDraft, setFormulaDraft] = useState<string | null>(null);

  useEffect(() => model.onChange(() => setVersion((v) => v + 1)), []);

  const cur = selection.current?.cell;
  const curRow = cur ? cur[1] + 1 : null;

  // Sticky header: the type of the row under the cursor, else the first visible bound row.
  const headerType = useMemo(() => {
    if (pinned) return TYPES.find((t) => t.name === pinned) ?? null;
    if (curRow !== null && model.rowType(curRow)) return model.rowType(curRow);
    for (let r = topRow + 1; r < topRow + 60; r++) if (model.rowType(r)) return model.rowType(r);
    return null;
  }, [pinned, curRow, topRow, version]);

  const columns = useMemo<GridColumn[]>(
    () =>
      Array.from({ length: COLS }, (_, i) => {
        const c = i + 1;
        const label = c === 1 ? "type" : c === 2 ? "id" : (model.fieldAt(headerType, c)?.name ?? "");
        return { id: colName(c), title: label ? `${colName(c)} · ${label}` : colName(c), width: c <= 2 ? 130 : 110 };
      }),
    [headerType],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = model.cell(row + 1, col + 1);
      return {
        kind: GridCellKind.Text,
        data: v.input,
        displayData: v.text,
        allowOverlay: true,
        readonly: false,
        contentAlign: typeof v.value === "number" ? "right" : "left",
        themeOverride: v.isFormula ? { textDark: "#1a4d8f" } : undefined,
      } as GridCell;
    },
    // Repaint everything after an op: validation can change far from the edited cell.
    [version],
  );

  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      drawContent();
      const r = args.row + 1;
      const c = args.col + 1;
      if (c === 1) {
        const t = model.rowType(r);
        if (t) drawGutter(args.ctx, args.rect, t.color);
      }
      const issue = model.cell(r, c).issue;
      if (issue) drawIssue(args.ctx, args.rect, issue, pulses.amount(r, c));
    },
    [version],
  );

  const drawHeader = useCallback<DrawHeaderCallback>(
    (args, drawContent) => {
      if (headerType && args.columnIndex >= 2 && model.fieldAt(headerType, args.columnIndex + 1)) {
        args.ctx.fillStyle = headerType.color + "22";
        args.ctx.fillRect(args.rect.x, args.rect.y, args.rect.width, args.rect.height);
      }
      drawContent();
    },
    [headerType],
  );

  // All writes become ops on our model; the grid only ever reads.
  const commit = useCallback((cells: { r: number; c: number; input: string }[]) => {
    const before = cells.map(({ r, c }) => model.cell(r, c).issue?.level === "error");
    model.edit(cells);
    cells.forEach(({ r, c }, i) => {
      if (!before[i] && model.cell(r, c).issue?.level === "error") pulses.start(r, c);
    });
    if (pulses.active) {
      const t0 = performance.now();
      const tick = () => {
        ref.current?.updateCells(cells.map(({ r, c }) => ({ cell: [c - 1, r - 1] as Item })));
        if (performance.now() - t0 < pulses.ms + 50) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }, []);

  const onCellsEdited = useCallback(
    (items: readonly EditListItem[]) => {
      commit(items.map((it) => ({ r: it.location[1] + 1, c: it.location[0] + 1, input: String(it.value.data ?? "") })));
      return true;
    },
    [commit],
  );

  // Clipboard and undo are ours, not the component's.
  useEffect(() => {
    const inGrid = () => document.activeElement?.closest(".grid") !== null;
    const rect = () => {
      const r = selection.current?.range;
      return r ? { r: r.y + 1, c: r.x + 1, rows: r.height, cols: r.width } : null;
    };
    const onCopy = (e: ClipboardEvent) => {
      const r = rect();
      if (!inGrid() || !r || !e.clipboardData) return;
      const p = copyPayload(model, r);
      e.clipboardData.setData("text/plain", p.text);
      e.clipboardData.setData("text/html", p.html);
      e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent) => {
      const r = rect();
      if (!inGrid() || !r || !e.clipboardData) return;
      e.preventDefault();
      const grid = parsePaste(e.clipboardData.getData("text/html"), e.clipboardData.getData("text/plain"), r);
      const cells: { r: number; c: number; input: string }[] = [];
      grid.forEach((row, i) => row.forEach((input, j) => cells.push({ r: r.r + i, c: r.c + j, input })));
      commit(cells);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!inGrid() || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) (model.undoLast(), e.preventDefault());
      else if (k === "y" || (k === "z" && e.shiftKey)) (model.redoLast(), e.preventDefault());
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [selection, commit]);

  const runBench = async () => {
    setBench("scrolling…");
    const r = await scrollBench(ROWS, (row) => ref.current?.scrollTo(0, row, "vertical", 0, 0, { vAlign: "start" }));
    setBench(`${r.fps.toFixed(0)} fps, p95 ${r.p95.toFixed(1)} ms, worst ${r.worst.toFixed(1)} ms`);
    (window as unknown as { benchResult: unknown }).benchResult = r;
  };

  const addr = cur ? `${colName(cur[0] + 1)}${cur[1] + 1}` : "";
  const curInput = cur ? model.cell(cur[1] + 1, cur[0] + 1).input : "";

  return (
    <>
      <div className="bar">
        <span className="addr">{addr}</span>
        <input
          className="formula"
          value={formulaDraft ?? curInput}
          onChange={(e) => setFormulaDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && cur && formulaDraft !== null) {
              commit([{ r: cur[1] + 1, c: cur[0] + 1, input: formulaDraft }]);
              setFormulaDraft(null);
              ref.current?.focus();
            } else if (e.key === "Escape") setFormulaDraft(null);
          }}
          onBlur={() => setFormulaDraft(null)}
        />
        <label>
          Header:{" "}
          <select value={pinned} onChange={(e) => setPinned(e.target.value)}>
            <option value="">follow cursor</option>
            {TYPES.map((t) => (
              <option key={t.name} value={t.name}>
                pin {t.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => model.undoLast()}>Undo</button>
        <button onClick={() => model.redoLast()}>Redo</button>
        <button onClick={runBench}>Scroll test</button>
      </div>
      <div className="grid">
        <DataEditor
          ref={ref}
          width="100%"
          height="100%"
          columns={columns}
          rows={ROWS}
          getCellContent={getCellContent}
          drawCell={drawCell}
          drawHeader={drawHeader}
          onCellsEdited={onCellsEdited}
          gridSelection={selection}
          onGridSelectionChange={(s) => {
            setSelection(s);
            setFormulaDraft(null);
          }}
          onVisibleRegionChanged={(r) => setTopRow(r.y)}
          onItemHovered={(e) => {
            if (e.kind !== "cell") return setTip(null);
            const issue = model.cell(e.location[1] + 1, e.location[0] + 1).issue;
            setTip(issue ? { x: e.bounds.x + e.bounds.width, y: e.bounds.y, issue } : null);
          }}
          keybindings={{ copy: false, paste: false, cut: false }}
          onPaste={false}
          rowMarkers="number"
          freezeColumns={2}
          smoothScrollX
          smoothScrollY
          rowHeight={26}
        />
      </div>
      {tip && (
        <div className={`tip ${tip.issue.level}`} style={{ left: tip.x + 4, top: tip.y }}>
          {tip.issue.message}
        </div>
      )}
      <div className="status">
        <span>
          <b>{ROWS.toLocaleString()}</b> rows, loaded in <b>{model.loadMs.toFixed(0)} ms</b>
        </span>
        <span>
          last op <b>{model.lastEditMs.toFixed(1)} ms</b>, {model.lastEvaluations} evaluations
        </span>
        <span>
          ops <b>{model.undo.length}</b> (redo {model.redo.length})
        </span>
        <span>{bench}</span>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
