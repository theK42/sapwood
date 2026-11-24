// A type view (DESIGN §9.2): every entity of one type, from all the sheets, in one grid.
// Typing writes to each entity's home cell; the formula bar names it (Weapons!E2). Rows
// can't be added, removed or moved here: that's the home sheets' business. Right-click goes
// to the row on its sheet, or finds the references to its ID.

import "@glideapps/glide-data-grid/dist/index.css";
import { CompactSelection, DataEditor, GridCellKind, type DataEditorRef, type DrawCellCallback, type ProvideEditorCallback, type ProvideEditorCallbackResult, type EditListItem, type GridCell, type GridColumn, type GridSelection, type Item } from "@glideapps/glide-data-grid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Issue, Op, Project } from "@thek42/sapwood-core";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";
import { idsAt } from "./refs.ts";
import { cellContent, drawIssue, ISSUE, useTheme } from "./SheetView.tsx";
import { TypeGrid, type Home } from "./typeview.ts";
import type { PanelCell } from "./ValuePanel.tsx";
import { RefCellEditor, RefEditorContext, useSuggest } from "./Suggest.tsx";
import type { RefTarget } from "./suggest.ts";

interface Props {
  source: Source;
  type: string;
  canEdit: boolean;
  edit(fn: (p: Project) => { ops: Op[] }): void;
  undo(): void;
  redo(): void;
  back(): void;
  /** Go to a cell on its sheet (0-based). */
  goTo(home: Home): void;
  findRefs(id: string): void;
  goToDefinition(id: string): void;
  showIssues(): void;
  /** Edit a struct, union, list or json cell in the panel (its home cell). */
  openPanel(at: PanelCell): void;
  /** The selected cell's home, for the panel to follow while it's open. */
  selected?(at: PanelCell | null, panel: boolean): void;
}

const empty = (): GridSelection => ({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });

export function TypeView(p: Props) {
  const tick = useSource(p.source);
  const t = useMemo(() => {
    try {
      return new TypeGrid(p.source.project, p.type);
    } catch {
      return null;
    }
  }, [p.source, p.type, tick]);
  const ref = useRef<DataEditorRef>(null);
  const bar = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<GridSelection>(() => ({ ...empty(), current: { cell: [1, 0], range: { x: 1, y: 0, width: 1, height: 1 }, rangeStack: [] } }));
  const [draft, setDraft] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; issue: Issue } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: number; col: number } | null>(null);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const theme = useTheme();
  useEffect(() => setTip(null), [t]);

  /** A cell's home by stable IDs, for the panel. */
  const homeAt = (row: number, col: number): PanelCell | null => {
    const h = t?.home(row, col);
    if (!h) return null;
    const s = p.source.project.wb.sheet(h.sheet);
    return { sheet: h.sheet, row: s.rows.idAt(h.row + 1), col: s.cols.idAt(h.col + 1) };
  };
  const openPanel = (row: number, col: number) => {
    const at = homeAt(row, col);
    if (at && t?.cell(row, col).panel) p.openPanel(at);
  };
  const sel = selection.current?.cell;
  useEffect(() => {
    if (!t || !sel) return p.selected?.(null, false);
    p.selected?.(homeAt(sel[1], sel[0]), !!t.cell(sel[1], sel[0]).panel);
  }, [t, sel?.[0], sel?.[1]]);

  const columns = useMemo<GridColumn[]>(() => (t ? Array.from({ length: t.cols }, (_, i) => ({ id: String(i), title: t.columnName(i), width: widths[i] ?? (i < 2 ? 140 : 120) })) : []), [t, widths]);

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = t!.cell(row, col);
      if (col === 0) return { kind: GridCellKind.Text, data: v.text, displayData: v.text, allowOverlay: false, readonly: true, themeOverride: { textDark: theme.glide.textMedium! } };
      const writable = p.canEdit && t!.home(row, col) !== null;
      return cellContent(v, writable, theme);
    },
    [t, p.canEdit, theme],
  );
  const drawCell = useCallback<DrawCellCallback>(
    (args, draw) => {
      draw();
      const issue = t!.cell(args.row, args.col).issue;
      if (issue) drawIssue(args.ctx, args.rect, issue.level);
    },
    [t],
  );

  const write = (cells: { row: number; col: number; input: string }[]) => {
    const mine = cells.filter((c) => t?.home(c.row, c.col));
    if (mine.length) p.edit((proj) => new TypeGrid(proj, p.type).edit(mine));
  };

  const cur = selection.current?.cell;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!document.activeElement?.closest(".sheet-grid")) return;
      if (e.key === "F12" && cur && t) {
        e.preventDefault();
        const h = t.home(cur[1], cur[0]);
        if (!h) return;
        const ids = idsAt(t.project, h.sheet, h.row, h.col);
        const id = ids.defines ?? ids.names[0];
        if (id) (e.shiftKey || ids.defines ? p.findRefs : p.goToDefinition)(id);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) (p.undo(), e.preventDefault());
      else if (k === "y" || (k === "z" && e.shiftKey)) (p.redo(), e.preventDefault());
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  // IDs suggested as a ref is typed: in the formula bar, and in the cell (through Glide's editor).
  const sug = useSuggest({
    project: p.source.project,
    target: p.canEdit && cur && t ? t.refAt(cur[1], cur[0]) : null,
    text: draft ?? (cur && t ? t.cell(cur[1], cur[0]).input : ""),
    input: bar,
    set: (x) => setDraft(x),
  });
  const editing = useRef<{ project: Project; target: RefTarget } | null>(null);
  const provideEditor = useCallback<ProvideEditorCallback<GridCell>>(
    (cell) => {
      const at = cell.location;
      // Glide counts the row numbers as column 0 here.
      const r = at && t ? t.refAt(at[1], at[0] - 1) : null;
      if (!r || !t) return undefined;
      editing.current = { project: t.project, target: r };
      return RefCellEditor as unknown as ProvideEditorCallbackResult<GridCell>;
    },
    [t],
  );

  if (!t)
    return (
      <div className="body">
        <p className="muted">There's no entity type called {p.type} here.</p>
        <button className="button" onClick={p.back}>
          Back to the packs
        </button>
      </div>
    );

  const curView = cur ? t.cell(cur[1], cur[0]) : null;
  const curHome = cur ? t.home(cur[1], cur[0]) : null;
  const counts = t.counts;
  const menuIds = menu ? (() => {
    const h = t.home(menu.row, 1);
    return h ? idsAt(t.project, h.sheet, h.row, menu.col === 0 ? 1 : (t.home(menu.row, menu.col)?.col ?? 1)) : null;
  })() : null;
  const rowHome = menu ? t.rows[menu.row] : undefined;
  return (
    <div className="sheet">
      <div className="sheet-bar">
        <button className="button quiet" onClick={p.back} title="Back to the packs">
          ←
        </button>
        <strong>Every {t.type}</strong>
        <span className="tag">type view</span>
        <span className="muted small">
          {plural(t.rows.length, "entity", "entities")} on {plural(new Set(t.rows.map((r) => r.sheet)).size, "sheet")}
        </span>
        {(counts.errors > 0 || counts.warnings > 0) && (
          <button className={counts.errors ? "badge error" : "badge warn"} onClick={p.showIssues} title="Show the issues">
            {[counts.errors && plural(counts.errors, "error"), counts.warnings && plural(counts.warnings, "warning")].filter(Boolean).join(", ")}
          </button>
        )}
      </div>
      <div className="formula-bar">
        <span className="addr wide">{cur ? t.address(cur[1], cur[0]) : ""}</span>
        <input
          ref={bar}
          aria-label="Cell contents"
          spellCheck={false}
          readOnly={!p.canEdit || !curHome}
          placeholder={cur && cur[0] > 1 && !curHome && t.rows[cur[1]] ? `${t.rows[cur[1]]!.sheetName} has no column for ${t.columnName(cur[0])}` : undefined}
          value={draft ?? curView?.input ?? ""}
          onChange={(e) => (setDraft(e.target.value), sug.typed())}
          onKeyDown={(e) => {
            if (sug.onKeyDown(e)) return;
            if (e.key === "Enter" && cur && draft !== null) {
              write([{ row: cur[1], col: cur[0], input: draft }]);
              setDraft(null);
              ref.current?.focus();
            } else if (e.key === "Escape") {
              setDraft(null);
              ref.current?.focus();
            }
          }}
          onBlur={() => (sug.close(), setDraft(null))}
        />
        {sug.list}
        {curView?.issue && <span className={`issue ${curView.issue.level}`} title={curView.issue.message}>{curView.issue.message}</span>}
      </div>
      <div className="sheet-grid">
        {t.rows.length === 0 ? (
          <p className="muted body">No {t.type} yet. Add one on a sheet: put {t.type} in column A.</p>
        ) : (
          <RefEditorContext.Provider value={editing}>
          <DataEditor
            provideEditor={provideEditor}
            ref={ref}
            width="100%"
            height="100%"
            theme={theme.glide}
            columns={columns}
            rows={t.rows.length}
            getCellContent={getCellContent}
            drawCell={drawCell}
            getCellsForSelection={true}
            onCellsEdited={(items: readonly EditListItem[]) => {
              write(items.map((it) => ({ row: it.location[1], col: it.location[0], input: String((it.value as { data?: unknown }).data ?? "") })));
              return true;
            }}
            onDelete={(sel) => {
              const r = sel.current?.range;
              if (!r || !p.canEdit) return false;
              const cells: { row: number; col: number; input: string }[] = [];
              for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) if (t.cell(y, x).input !== "") cells.push({ row: y, col: x, input: "" });
              write(cells);
              return false;
            }}
            gridSelection={selection}
            onGridSelectionChange={(s) => {
              setSelection(s);
              setDraft(null);
            }}
            onKeyDown={(e) => {
              // A struct, union, list or json cell isn't edited in place: a key typed there goes to the formula bar.
              const at = selection.current?.cell;
              // Enter opens it in the panel (Glide doesn't always report Enter as an activation here).
              if (e.key === "Enter" && !e.shiftKey && at && t.cell(at[1], at[0]).panel && t.home(at[1], at[0])) {
                e.cancel();
                openPanel(at[1], at[0]);
                return;
              }
              if (!p.canEdit || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || !at || !t.home(at[1], at[0]) || !t.cell(at[1], at[0]).panel) return;
              e.cancel();
              setDraft(e.key);
              requestAnimationFrame(() => bar.current?.focus());
            }}
            onCellActivated={([col, row]) => {
              // Enter or a double-click on the Sheet column goes to the row there.
              const h = t.home(row, 1);
              if (col === 0 && h) p.goTo({ ...h, col: 0 });
              else openPanel(row, col);
            }}
            onCellContextMenu={([col, row], e) => {
              e.preventDefault();
              setMenu({ x: e.bounds.x + e.localEventX, y: e.bounds.y + e.localEventY, row, col });
            }}
            onItemHovered={(e) => {
              if (e.kind !== "cell") return setTip(null);
              const issue = t.cell(e.location[1], e.location[0]).issue;
              setTip(issue ? { x: e.bounds.x + e.bounds.width, y: e.bounds.y, issue } : null);
            }}
            getRowThemeOverride={(row) => {
              const l = t.rowLevel(row);
              const inactive = t.rows[row]?.active === false;
              if (!l && !inactive) return undefined;
              return { ...(l ? { textLight: ISSUE[l], markerFontStyle: "700 9px" } : {}), ...(inactive ? { textDark: theme.glide.textMedium! } : {}) };
            }}
            onColumnResize={(_c, w, i) => setWidths((x) => ({ ...x, [i]: w }))}
            rowMarkers="number"
            freezeColumns={2}
            smoothScrollX
            smoothScrollY
            rowHeight={26}
          />
          </RefEditorContext.Provider>
        )}
      </div>
      {menu && (
        <TypeMenu
          at={menu}
          close={() => setMenu(null)}
          items={[
            ...(t.cell(menu.row, menu.col).panel && t.home(menu.row, menu.col) ? [{ label: p.canEdit ? "Edit in the panel" : "Show in the panel", run: () => openPanel(menu.row, menu.col) }] : []),
            ...(rowHome ? [{ label: `Go to the row on ${rowHome.sheetName}`, run: () => p.goTo({ sheet: rowHome.sheet, row: rowHome.row, col: Math.max(0, t.home(menu.row, menu.col)?.col ?? 0) }) }] : []),
            ...(menuIds?.defines ? [{ label: `Find references to “${menuIds.defines}”`, run: () => p.findRefs(menuIds.defines!) }] : []),
            ...(menuIds?.names ?? []).slice(0, 3).flatMap((id) => [
              { label: `Go to “${id}”`, run: () => p.goToDefinition(id) },
              { label: `Find references to “${id}”`, run: () => p.findRefs(id) },
            ]),
          ]}
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

function TypeMenu(p: { at: { x: number; y: number }; items: { label: string; run(): void }[]; close(): void }) {
  const ref = useRef<HTMLDivElement>(null);
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
  if (p.items.length === 0) return null;
  return (
    <div className="menu-list sheet-menu" role="menu" ref={ref} style={{ left: Math.min(p.at.x, innerWidth - 280), top: Math.min(p.at.y, innerHeight - 40 * p.items.length - 16) }}>
      {p.items.map((x, i) => (
        <button key={i} role="menuitem" onClick={() => (p.close(), x.run())}>
          {x.label}
        </button>
      ))}
    </div>
  );
}
