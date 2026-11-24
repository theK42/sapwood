// The spreadsheet view (DESIGN §6, §9.2), on Glide Data Grid (spike S2). Glide only draws and
// reports what was typed: every change becomes ops on the task's project (SheetGrid), and
// undo and redo are the task's.
//
// The sticky header names the columns for the type of the row under the cursor (or of the
// first typed row in view), and can be pinned to a type. Column A carries a thin stripe in
// the row's type color. Validation draws in its own channel over the cells (§6.7): an inset
// dashed outline and a corner flag, red for errors and amber for warnings, with the message
// on hover. A row with an issue has its number in red or amber, and a cell flashes once when
// an edit gives it a new error. User formatting (bold, italic, fill, text color) draws under it.

import "@glideapps/glide-data-grid/dist/index.css";
import {
  CompactSelection, DataEditor, GridCellKind,
  type DataEditorRef, type DrawCellCallback, type DrawHeaderCallback, type EditListItem, type GridCell, type GridColumn, type GridSelection, type Item, type Theme,
} from "@glideapps/glide-data-grid";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Format, Issue, Op, Project } from "@thek42/sapwood-core";
import { numberToCol } from "@thek42/sapwood-core";
import { copyPayload, parsePaste } from "./clipboard.ts";
import { SheetGrid, typeColor, type Axis, type CellEdit, type CellView, type Rect } from "./grid.ts";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";
import { useHeaderDrag } from "./headerDrag.ts";
import { idsAt } from "./refs.ts";

export interface SheetProps {
  source: Source;
  sheet: string;
  /** Whether edits are allowed (signed in as an Editor, not read-only). */
  canEdit: boolean;
  /** Make a change: applied to the task's project (started if need be), then sent. */
  edit(fn: (p: Project) => { ops: import("@thek42/sapwood-core").Op[] }): void;
  undo(): void;
  redo(): void;
  back(): void;
  /** Go to this cell (0-based; col null: the row), once for each new `n`. */
  jump?: { row: number; col: number | null; n: number } | null;
  /** Open the issues panel. */
  showIssues(): void;
  /** Where an ID is used; where it's defined; every entity of a type. */
  findRefs(id: string): void;
  goToDefinition(id: string): void;
  openType(type: string): void;
}

/** How long a cell flashes for (§6.7: a brief pulse, once). */
export const PULSE_MS = 900;

export const ISSUE = { error: "#d32020", warning: "#d98a00" } as const;
const FILLS = ["#fff3b0", "#d9f2d0", "#d6e8fb", "#fbd9d6", "#eadcf8"];
const INKS = ["#b3261e", "#2f6b3a", "#1a4d8f", "#8a5a00"];

const empty = (): GridSelection => ({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });

export function SheetView(p: SheetProps) {
  const tick = useSource(p.source);
  const exists = p.source.project.wb.sheets.has(p.sheet);
  const g = useMemo(() => (exists ? new SheetGrid(p.source.project, p.sheet) : null), [p.source, p.sheet, tick, exists]);
  const ref = useRef<DataEditorRef>(null);
  const bar = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<GridSelection>(() => ({ ...empty(), current: { cell: [1, 0], range: { x: 1, y: 0, width: 1, height: 1 }, rangeStack: [] } }));
  const [pinned, setPinned] = useState("");
  const [topRow, setTopRow] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; issue: Issue } | null>(null);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; rect: Rect; cell: { row: number; col: number } | null; whole: Axis | null } | null>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const theme = useTheme();
  useEffect(() => setTip(null), [g]); // an edit may have settled the issue under the pointer

  // The flash: cells by position, and when it started. Drawn by drawCell, frame by frame.
  const pulse = useRef<{ cells: Map<string, { col: number; row: number; color: string }>; start: number } | null>(null);
  const flash = (cells: { row: number; col: number; color: string }[]) => {
    if (cells.length === 0) return;
    pulse.current = { cells: new Map(cells.map((c) => [`${c.row},${c.col}`, c])), start: performance.now() };
    const all = cells.map((c) => ({ cell: [c.col, c.row] as Item }));
    const frame = () => {
      ref.current?.updateCells(all);
      if (pulse.current && performance.now() - pulse.current.start < PULSE_MS) requestAnimationFrame(frame);
      else pulse.current = null, ref.current?.updateCells(all);
    };
    requestAnimationFrame(frame);
  };
  // A new error from an edit flashes; the errors a sheet opens with don't.
  const errorKeys = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!g) return;
    const errs = g.issueCells().filter((c) => c.issue.level === "error");
    const before = errorKeys.current;
    errorKeys.current = new Set(errs.map((c) => c.key));
    if (before) flash(errs.filter((c) => !before.has(c.key)).map((c) => ({ ...c, color: ISSUE.error })));
  }, [g]);

  // Going to a cell, from the issues panel.
  useEffect(() => {
    if (!p.jump || !g) return;
    const { row, col } = p.jump;
    const c = col ?? 0;
    setSelection({ ...empty(), current: { cell: [c, row], range: { x: c, y: row, width: 1, height: 1 }, rangeStack: [] } });
    ref.current?.scrollTo(c, row, "both", 0, 0, { vAlign: "center", hAlign: "center" });
    // On a sheet that just opened, Glide takes focus only once it has drawn.
    ref.current?.focus();
    requestAnimationFrame(() => requestAnimationFrame(() => ref.current?.focus()));
    const level = g.cell(row, c).issue?.level;
    flash([{ row, col: c, color: level ? ISSUE[level] : theme.glide.accentColor! }]);
  }, [p.jump?.n]);

  const cur = selection.current?.cell;
  const headerType = useMemo(() => {
    if (!g) return null;
    if (pinned) return pinned;
    if (cur && g.rowType(cur[1])) return g.rowType(cur[1]);
    for (let r = topRow; r < topRow + 60 && r < g.liveRows; r++) if (g.rowType(r)) return g.rowType(r);
    return null;
  }, [g, pinned, cur?.[1], topRow]);

  const columns = useMemo<GridColumn[]>(() => {
    if (!g) return [];
    return Array.from({ length: g.cols }, (_, i) => {
      const name = g.columnName(headerType, i);
      return { id: String(i), title: name ? `${numberToCol(i + 1)} · ${name}` : numberToCol(i + 1), width: widths[i] ?? (i < 2 ? 140 : 120) };
    });
  }, [g, headerType, widths]);

  const getCellContent = useCallback(([col, row]: Item): GridCell => cellContent(g!.cell(row, col), p.canEdit, theme), [g, p.canEdit, theme]);

  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      drawContent();
      if (args.col === 0) {
        const t = g!.rowType(args.row);
        if (t) {
          args.ctx.save(); // Glide keeps track of the fill it last set
          args.ctx.fillStyle = typeColor(t);
          args.ctx.fillRect(args.rect.x, args.rect.y, 4, args.rect.height);
          args.ctx.restore();
        }
      }
      const issue = g!.cell(args.row, args.col).issue;
      if (issue) drawIssue(args.ctx, args.rect, issue.level);
      const fl = pulse.current?.cells.get(`${args.row},${args.col}`);
      if (fl) drawPulse(args.ctx, args.rect, fl.color, (performance.now() - pulse.current!.start) / PULSE_MS);
    },
    [g],
  );

  const drawHeader = useCallback<DrawHeaderCallback>(
    (args, drawContent) => {
      if (headerType && args.columnIndex >= 2 && g?.columnName(headerType, args.columnIndex)) {
        args.ctx.save();
        args.ctx.globalAlpha = 0.14;
        args.ctx.fillStyle = typeColor(headerType);
        args.ctx.fillRect(args.rect.x, args.rect.y, args.rect.width, args.rect.height);
        args.ctx.restore();
      }
      drawContent();
    },
    [g, headerType],
  );

  const write = useCallback(
    (cells: CellEdit[]) => {
      if (cells.length === 0) return;
      p.edit((proj) => new SheetGrid(proj, p.sheet).edit(cells));
    },
    [p.edit, p.sheet],
  );

  /** The selected range; whole rows or columns as far as the sheet has them. */
  const range = (): Rect | null => {
    const r = selection.current?.range;
    if (!r || !g) return null;
    const rows = selection.columns.length > 0 ? Math.max(1, Math.min(r.height, g.liveRows - r.y)) : r.height;
    const cols = selection.rows.length > 0 ? Math.max(1, Math.min(r.width, g.liveCols - r.x)) : r.width;
    return { row: r.y, col: r.x, rows, cols };
  };
  /** Whole rows or columns are selected (from the row numbers or the headers). */
  const whole = (): Axis | null => (selection.columns.length > 0 ? "col" : selection.rows.length > 0 ? "row" : null);
  const change = (fn: (g: SheetGrid) => { ops: Op[] }) => {
    setMenu(null);
    p.edit((proj) => fn(new SheetGrid(proj, p.sheet)));
    ref.current?.focus();
  };
  const clear = (r: Rect) => {
    const cells: CellEdit[] = [];
    for (let y = r.row; y < r.row + r.rows && y < g!.liveRows; y++)
      for (let x = r.col; x < r.col + r.cols && x < g!.liveCols; x++) {
        const v = g!.cell(y, x);
        if (v.input !== "" || v.format) cells.push({ row: y, col: x, input: "", format: null });
      }
    write(cells);
  };

  // Copy, cut and paste are ours (DESIGN 6.6): Sapwood's formulas move, Sheets and Excel get values.
  useEffect(() => {
    const inGrid = () => document.activeElement?.closest(".sheet-grid") != null;
    const onCopy = (e: ClipboardEvent, cut = false) => {
      const r = range();
      if (!inGrid() || !r || !e.clipboardData || !g) return;
      const out = copyPayload(g, r);
      e.clipboardData.setData("text/plain", out.text);
      e.clipboardData.setData("text/html", out.html);
      e.preventDefault();
      if (cut && p.canEdit) clear(r);
    };
    const onCut = (e: ClipboardEvent) => onCopy(e, true);
    const onPaste = (e: ClipboardEvent) => {
      const r = range();
      if (!inGrid() || !r || !e.clipboardData || !p.canEdit) return;
      e.preventDefault();
      const grid = parsePaste(e.clipboardData.getData("text/html"), e.clipboardData.getData("text/plain"), { row: r.row, col: r.col });
      const cells: CellEdit[] = [];
      grid.forEach((row, i) => row.forEach((c, j) => cells.push({ row: r.row + i, col: r.col + j, input: c.input, ...(c.format !== undefined ? { format: c.format } : {}) })));
      write(cells);
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  });

  /**
   * The rows or columns a menu acts on: the selection's, if the cell is in it, else the cell's.
   * On a header or a row number (col -1), the whole column or row.
   */
  const menuAt = (x: number, y: number, col: number, row: number | null) => {
    const r = range();
    const w = whole();
    const c = Math.max(col, 0);
    const inside = r !== null && c >= r.col && c < r.col + r.cols && (row === null || (row >= r.row && row < r.row + r.rows));
    const own: Rect = { row: row ?? 0, col: c, rows: 1, cols: 1 };
    const on: Axis | null = row === null ? "col" : col < 0 ? "row" : null;
    setMenu({ x, y, rect: inside ? r : own, cell: row === null || col < 0 ? null : { row, col }, whole: inside ? w ?? on : on });
  };
  const format = (change: Format | null) => {
    const r = range();
    if (!r) return;
    p.edit((proj) => new SheetGrid(proj, p.sheet).format(r, change));
    ref.current?.focus();
  };

  // Undo and redo are the task's, not the grid's. F12 goes to the definition of the ID in the
  // cell, Shift+F12 finds its references (as in code editors).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F12" && cur && g && document.activeElement?.closest(".sheet-grid")) {
        e.preventDefault();
        const ids = idsAt(g.project, g.sheet, cur[1], cur[0]);
        const id = ids.defines ?? ids.names[0];
        if (id) (e.shiftKey || ids.defines ? p.findRefs : p.goToDefinition)(id);
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || !document.activeElement?.closest(".sheet-grid")) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) (p.undo(), e.preventDefault());
      else if (k === "y" || (k === "z" && e.shiftKey)) (p.redo(), e.preventDefault());
      else if (k === "b" && p.canEdit) (format({ bold: !g?.cell(cur?.[1] ?? 0, cur?.[0] ?? 0).format?.bold }), e.preventDefault());
      else if ((k === "d" || k === "r") && p.canEdit) {
        // Fill down (Ctrl+D) from the selection's top row, or right (Ctrl+R) from its left column, as in Excel.
        e.preventDefault();
        const r = range();
        if (!r) return;
        const from = k === "d" ? { ...r, rows: 1 } : { ...r, cols: 1 };
        if ((k === "d" ? r.rows : r.cols) > 1) change((x) => x.fill(from, r));
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  const { block, line } = useHeaderDrag({
    editor: ref,
    box,
    grid: g,
    selection,
    select: (s) => (setSelection(s), setDraft(null)),
    topRow,
    canEdit: p.canEdit,
    move: (axis, indices, before) => change((x) => x.moveTo(axis, indices, before)),
  });

  if (!g)
    return (
      <div className="body">
        <p className="muted">This sheet isn't in {p.source === null ? "the project" : "this task"}. </p>
        <button className="button" onClick={p.back}>
          Back to the packs
        </button>
      </div>
    );

  const curView = cur ? g.cell(cur[1], cur[0]) : null;
  const types = [...p.source.project.schema.types.values()].filter((t) => !t.def.singleton).map((t) => t.def.name);
  return (
    <div className="sheet">
      <div className="sheet-bar">
        <button className="button quiet" onClick={p.back} title="Back to the packs">
          ←
        </button>
        <strong>{g.name}</strong>
        {g.kind === "scratch" && <span className="tag">scratch</span>}
        {(g.errors > 0 || g.warnings > 0) && (
          <button className={g.errors ? "badge error" : "badge warn"} onClick={p.showIssues} title="Show the issues">
            {[g.errors && plural(g.errors, "error"), g.warnings && plural(g.warnings, "warning")].filter(Boolean).join(", ")}
          </button>
        )}
        <span className="spacer" />
        {p.canEdit && (
          <span className="formats" aria-label="Formatting">
            <button className="button quiet b" title="Bold (Ctrl+B)" onClick={() => format({ bold: !curView?.format?.bold })}>
              B
            </button>
            <button className="button quiet i" title="Italic" onClick={() => format({ italic: !curView?.format?.italic })}>
              I
            </button>
            {FILLS.map((c) => (
              <button key={c} className="swatch" style={{ background: c }} title={`Fill ${c}`} onClick={() => format({ fill: c })} />
            ))}
            {INKS.map((c) => (
              <button key={c} className="swatch ink" style={{ color: c }} title={`Text ${c}`} onClick={() => format({ color: c })}>
                A
              </button>
            ))}
            <button className="button quiet" title="Clear formatting" onClick={() => format(null)}>
              Clear
            </button>
          </span>
        )}
        {g.kind === "data" && (
          <label className="pin">
            <span className="muted">Header</span>
            <select value={pinned} onChange={(e) => setPinned(e.target.value)}>
              <option value="">follows the row</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="formula-bar">
        <span className="addr">{cur ? g.address(cur[1], cur[0]) : ""}</span>
        <input
          ref={bar}
          aria-label="Cell contents"
          spellCheck={false}
          readOnly={!p.canEdit || !cur}
          value={draft ?? curView?.input ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && cur && draft !== null) {
              write([{ row: cur[1], col: cur[0], input: draft }]);
              setDraft(null);
              ref.current?.focus();
            } else if (e.key === "Escape") {
              setDraft(null);
              ref.current?.focus();
            }
          }}
          onBlur={() => setDraft(null)}
        />
        {curView?.issue && <span className={`issue ${curView.issue.level}`}>{curView.issue.message}</span>}
      </div>
      <div className="sheet-grid" ref={setBox}>
        <DataEditor
          ref={ref}
          width="100%"
          height="100%"
          theme={theme.glide}
          columns={columns}
          rows={g.rows}
          getCellContent={getCellContent}
          drawCell={drawCell}
          drawHeader={drawHeader}
          onCellsEdited={(items: readonly EditListItem[]) => {
            write(items.map((it) => ({ row: it.location[1], col: it.location[0], input: String((it.value as { data?: unknown }).data ?? "") })));
            return true;
          }}
          onDelete={(sel) => {
            const r = sel.current?.range;
            if (!r || !p.canEdit) return false;
            const cells: CellEdit[] = [];
            for (let y = r.y; y < r.y + r.height && y < g.liveRows; y++) for (let x = r.x; x < r.x + r.width && x < g.liveCols; x++) if (g.cell(y, x).input !== "") cells.push({ row: y, col: x, input: "" });
            write(cells);
            return false;
          }}
          gridSelection={selection}
          onGridSelectionChange={(s) => {
            setSelection(s);
            setDraft(null);
          }}
          onVisibleRegionChanged={(r) => setTopRow(r.y)}
          keybindings={{ copy: false, cut: false, paste: false }}
          onPaste={false}
          fillHandle={p.canEdit}
          // Glide only lets a fill-handle drag through (to onFillPattern) when this is set.
          getCellsForSelection={true}
          onFillPattern={(e) => {
            e.preventDefault();
            const { patternSource: a, fillDestination: b } = e;
            change((x) => x.fill({ row: a.y, col: a.x, rows: a.height, cols: a.width }, { row: b.y, col: b.x, rows: b.height, cols: b.width }));
          }}
          onCellContextMenu={([col, row], e) => {
            e.preventDefault();
            menuAt(e.bounds.x + e.localEventX, e.bounds.y + e.localEventY, col, row);
          }}
          onHeaderContextMenu={(col, e) => {
            e.preventDefault();
            menuAt(e.bounds.x + e.localEventX, e.bounds.y + e.localEventY, col, null);
          }}
          onKeyDown={(e) => {
            // Glide 6.0.4-alpha24 doesn't start editing on a key typed in column A when columns
            // are frozen beside the row numbers (its visible-region check is off by one): the
            // key goes to the formula bar instead, and Enter writes it as usual.
            if (!p.canEdit || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || selection.current?.cell[0] !== 0) return;
            e.cancel();
            setDraft(e.key);
            requestAnimationFrame(() => bar.current?.focus());
          }}
          onColumnResize={(_c, w, i) => setWidths((x) => ({ ...x, [i]: w }))}
          onItemHovered={(e) => {
            if (e.kind !== "cell") return setTip(null);
            const issue = g.cell(e.location[1], e.location[0]).issue;
            setTip(issue ? { x: e.bounds.x + e.bounds.width, y: e.bounds.y, issue } : null);
          }}
          getRowThemeOverride={(row) => {
            const l = g.rowLevel(row);
            return l ? { textLight: ISSUE[l], markerFontStyle: "700 9px" } : undefined;
          }}
          rowMarkers="number"
          freezeColumns={2}
          smoothScrollX
          smoothScrollY
          rowHeight={26}
        />
        {/* A move's preview (headerDrag.ts): the block being dragged and where it lands. */}
        <div ref={block} className="drag-block" />
        <div ref={line} className="drag-line" />
      </div>
      {menu && (
        <SheetMenu
          grid={g}
          at={menu}
          canEdit={p.canEdit}
          close={() => setMenu(null)}
          change={change}
          clear={clear}
          navigate={(f) => (setMenu(null), f(p))}
        />
      )}
      {tip && (
        <div className={`tip ${tip.issue.level}`} style={{ left: tip.x + 4, top: tip.y }}>
          {tip.issue.message}
        </div>
      )}
    </div>
  );
}

/** A cell as Glide draws it: the value shown, what was typed for its editor, and its formats. */
export function cellContent(v: CellView, canEdit: boolean, theme: { formula: string }): GridCell {
  const f = v.format;
  const override: Partial<Theme> = {};
  if (v.formula) override.textDark = theme.formula;
  if (v.error) override.textDark = ISSUE.error;
  if (f?.color) override.textDark = String(f.color);
  if (f?.fill) {
    override.bgCell = String(f.fill);
    if (!f.color) override.textDark = v.formula ? "#1a4d8f" : v.error ? ISSUE.error : "#1d1d1b"; // the fills are light, in dark mode too
  }
  if (f?.bold || f?.italic) override.baseFontStyle = `${f.italic ? "italic " : ""}${f.bold ? "600 " : ""}13px`;
  return {
    kind: GridCellKind.Text,
    data: v.input,
    displayData: v.text,
    allowOverlay: canEdit,
    readonly: !canEdit,
    contentAlign: v.number ? "right" : "left",
    ...(Object.keys(override).length ? { themeOverride: override } : {}),
  };
}

/** Right-click: copy and cut, clear, and inserting and deleting rows and columns. */
function SheetMenu(p: {
  grid: SheetGrid;
  at: { x: number; y: number; rect: Rect; cell: { row: number; col: number } | null; whole: Axis | null };
  navigate(f: (s: SheetProps) => void): void;
  canEdit: boolean;
  close(): void;
  change(fn: (g: SheetGrid) => { ops: Op[] }): void;
  clear(r: Rect): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: p.at.x, top: p.at.y });
  // Inside the window: up from the pointer if there's no room below, left if none to the right.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, p.at.x + width > innerWidth - 8 ? p.at.x - width : p.at.x),
      top: Math.max(8, p.at.y + height > innerHeight - 8 ? p.at.y - height : p.at.y),
    });
  }, [p.at.x, p.at.y]);
  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && p.close();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && p.close();
    addEventListener("mousedown", away);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("mousedown", away);
      removeEventListener("keydown", esc);
    };
  });
  const r = p.at.rect;
  const g = p.grid;
  const rows = (n: number) => plural(n, "row");
  const cols = (n: number) => plural(n, "column");
  const item = (label: string, enabled: boolean, run: () => void) => (
    <button role="menuitem" disabled={!enabled} onClick={run}>
      {label}
    </button>
  );
  const insert = (axis: Axis, at: number, n: number) => () => p.change((x) => x.insert(axis, at, n));
  // Copying needs a user gesture; a click in this menu is one, and execCommand fires our copy handler.
  const copy = (cut: boolean) => () => {
    p.close();
    document.execCommand(cut ? "cut" : "copy");
  };
  const rowsHere = r.row < g.liveRows;
  const colsHere = r.col < g.liveCols;
  const fixed = g.kind === "data" ? 2 : 0;
  // What the cell is about: the ID it defines or names, and its row's type.
  const c = p.at.cell;
  const ids = c && g.kind === "data" ? idsAt(g.project, g.sheet, c.row, c.col) : { defines: null, names: [] };
  const rowType = c ? g.rowType(c.row) : null;
  const type = rowType && !g.project.schema.types.get(rowType)?.def.singleton ? rowType : null;
  const quote = (id: string) => `“${id.length > 24 ? id.slice(0, 23) + "…" : id}”`;
  const about = [
    ...(ids.defines ? [item(`Find references to ${quote(ids.defines)}`, true, () => p.navigate((s) => s.findRefs(ids.defines!)))] : []),
    ...ids.names.slice(0, 3).flatMap((id) => [
      item(`Go to ${quote(id)}`, true, () => p.navigate((s) => s.goToDefinition(id))),
      item(`Find references to ${quote(id)}`, true, () => p.navigate((s) => s.findRefs(id))),
    ]),
    ...(type ? [item(`Show every ${type}`, true, () => p.navigate((s) => s.openType(type)))] : []),
  ];
  return (
    <div className="menu-list sheet-menu" role="menu" ref={ref} style={pos}>
      {about.length > 0 && (
        <>
          {about.map((x, i) => (
            <span key={i} style={{ display: "contents" }}>
              {x}
            </span>
          ))}
          <hr />
        </>
      )}
      {item("Copy", true, copy(false))}
      {item("Cut", p.canEdit, copy(true))}
      <span className="muted small hint">Paste with Ctrl+V</span>
      {item("Clear", p.canEdit, () => (p.close(), p.clear(r)))}
      {p.at.whole !== "col" && (
        <>
          <hr />
      {item(`Insert ${rows(r.rows)} above`, p.canEdit && rowsHere, insert("row", r.row, r.rows))}
      {item(`Insert ${rows(r.rows)} below`, p.canEdit && rowsHere, insert("row", r.row + r.rows, r.rows))}
      {item(`Delete ${rows(r.rows)}`, p.canEdit && g.canChange("row", r.row, r.rows), () => p.change((x) => x.remove("row", r.row, r.rows)))}
        </>
      )}
      {p.at.whole !== "row" && (
        <>
          <hr />
      {item(`Insert ${cols(r.cols)} left`, p.canEdit && colsHere && r.col >= fixed, insert("col", r.col, r.cols))}
      {item(`Insert ${cols(r.cols)} right`, p.canEdit && colsHere && r.col + r.cols >= fixed, insert("col", r.col + r.cols, r.cols))}
      {item(`Delete ${cols(r.cols)}`, p.canEdit && g.canChange("col", r.col, r.cols), () => p.change((x) => x.remove("col", r.col, r.cols)))}
        </>
      )}
    </div>
  );
}

/** The reserved validation channel (§6.7): an inset dashed outline and a corner flag. */
export function drawIssue(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, level: "error" | "warning") {
  const color = ISSUE[level];
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(rect.x + 2.5, rect.y + 2.5, rect.width - 5, rect.height - 5);
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(rect.x + rect.width - 8, rect.y + 1);
  ctx.lineTo(rect.x + rect.width - 1, rect.y + 1);
  ctx.lineTo(rect.x + rect.width - 1, rect.y + 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The flash: a ring that fades and spreads a little as `t` goes from 0 to 1. */
export function drawPulse(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, color: string, t: number) {
  if (t >= 1) return;
  ctx.save();
  ctx.globalAlpha = 0.35 * (1 - t);
  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.globalAlpha = 1 - t;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);
  ctx.restore();
}

/** Glide's colors from the page's, light or dark, following the system. */
export function useTheme(): { glide: Partial<Theme>; formula: string } {
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return useMemo(() => {
    const v = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return {
      formula: dark ? "#8ab4f8" : "#1a4d8f",
      glide: {
        accentColor: v("--accent"),
        accentLight: dark ? "rgba(111, 178, 122, 0.18)" : "rgba(47, 107, 58, 0.12)",
        textDark: v("--text"),
        textMedium: v("--muted"),
        textLight: v("--muted"),
        textHeader: v("--text"),
        textBubble: v("--text"),
        bgIconHeader: v("--muted"),
        fgIconHeader: v("--panel"),
        bgCell: v("--panel"),
        bgCellMedium: v("--bg"),
        bgHeader: v("--bg"),
        bgHeaderHasFocus: v("--line"),
        bgHeaderHovered: v("--line"),
        bgBubble: v("--bg"),
        bgSearchResult: v("--warn-bg"),
        borderColor: v("--line"),
        horizontalBorderColor: v("--line"),
        drilldownBorder: v("--line"),
        linkColor: v("--accent"),
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        baseFontStyle: "13px",
        headerFontStyle: "600 12px",
      },
    };
  }, [dark]);
}
