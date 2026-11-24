// Selecting and moving whole rows and columns, as in Google Sheets. Glide's own column and
// row dragging moves the columns as you go; this takes the headers and row numbers over:
//
// - Pressing on a header (or row number) that isn't selected selects it; dragging across
//   others selects them too. Shift extends from the last one, Ctrl or Cmd adds to them.
// - Pressing on one that is selected and dragging moves all of the selected ones (less A and
//   B on a data sheet, which stay first). A grey block follows the pointer and a line shows
//   where they'll land; nothing moves until the button comes up. Escape calls it off.
// - Near an edge, the grid scrolls.
//
// The resize handle at a header's edge is still Glide's.

import { CompactSelection, type DataEditorRef, type GridSelection } from "@glideapps/glide-data-grid";
import { useEffect, useRef, type RefObject } from "react";
import type { Axis, SheetGrid } from "./grid.ts";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HeaderDragOptions {
  editor: RefObject<DataEditorRef | null>;
  /** The element the grid fills; the preview is drawn in it. */
  box: HTMLDivElement | null;
  grid: SheetGrid | null;
  selection: GridSelection;
  select(s: GridSelection): void;
  /** The first row in view, for where the cursor goes when columns are selected. */
  topRow: number;
  canEdit: boolean;
  /** Move these (0-based) to land before `before`. */
  move(axis: Axis, indices: number[], before: number): void;
}

/** A selection of whole rows or columns: `set`, with the cursor in the run `lo`..`hi`. */
export function wholeSelection(g: SheetGrid, axis: Axis, set: CompactSelection, lo: number, hi: number, topRow: number): GridSelection {
  const [a, b] = [Math.min(lo, hi), Math.max(lo, hi)];
  return axis === "col"
    ? { columns: set, rows: CompactSelection.empty(), current: { cell: [lo, topRow], range: { x: a, y: 0, width: b - a + 1, height: g.rows }, rangeStack: [] } }
    : { rows: set, columns: CompactSelection.empty(), current: { cell: [0, lo], range: { x: 0, y: a, width: g.cols, height: b - a + 1 }, rangeStack: [] } };
}

const span = (a: number, b: number) => CompactSelection.fromSingleSelection([Math.min(a, b), Math.max(a, b) + 1]);
const THRESHOLD = 4; // pixels before a press becomes a move
const EDGE = 28; // pixels from an edge where the grid scrolls

type Drag =
  | { kind: "select"; axis: Axis; anchor: number; base: CompactSelection; last: number }
  | { kind: "press"; axis: Axis; index: number; x: number; y: number }
  | { kind: "move"; axis: Axis; indices: number[]; offset: number; size: number; before: number | null };

export function useHeaderDrag(o: HeaderDragOptions): { block: RefObject<HTMLDivElement | null>; line: RefObject<HTMLDivElement | null> } {
  const block = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const opts = useRef(o);
  opts.current = o;

  useEffect(() => {
    const box = o.box;
    if (!box) return;
    let drag: Drag | null = null;
    let pointer = { x: 0, y: 0 };
    let anchor: { axis: Axis; index: number } | null = null;
    let frame = 0;

    const ed = () => opts.current.editor.current;
    const bounds = (col: number, row: number): Box | undefined => ed()?.getBounds(col, row);
    /** The grid's area: right of the row numbers and below the header; where it scrolls from. */
    const area = () => {
      const r = box.getBoundingClientRect();
      const scroller = box.querySelector<HTMLElement>(".dvn-scroller");
      const right = r.left + (scroller?.clientWidth ?? r.width);
      const bottom = r.top + (scroller?.clientHeight ?? r.height);
      const head = bounds(0, -1);
      const marker = bounds(-1, -1);
      const g = opts.current.grid;
      const frozen = g && g.cols > 1 ? bounds(1, -1) : head;
      return {
        rect: r,
        scroller,
        top: head ? head.y + head.height : r.top,
        left: marker ? marker.x + marker.width : r.left,
        frozenRight: frozen ? frozen.x + frozen.width : r.left,
        headerY: head ? head.y + head.height / 2 : r.top + 18,
        markerX: marker ? marker.x + marker.width / 2 : r.left + 20,
        right,
        bottom,
      };
    };
    /** The row or column under the pointer, along the axis; null past the ends. */
    const indexAt = (axis: Axis, x: number, y: number): { index: number; b: Box } | null => {
      const a = area();
      const args =
        axis === "col"
          ? ed()?.getMouseArgsForPosition(Math.min(Math.max(x, a.left + 1), a.right - 1), a.headerY)
          : ed()?.getMouseArgsForPosition(a.markerX, Math.min(Math.max(y, a.top + 1), a.bottom - 1));
      if (!args || args.kind === "out-of-bounds") return null;
      const i = axis === "col" ? args.location[0] : args.location[1];
      if (i < 0) return null;
      const b = axis === "col" ? bounds(i, -1) : bounds(-1, i);
      return b ? { index: i, b } : null;
    };

    const selected = (axis: Axis) => (axis === "col" ? opts.current.selection.columns : opts.current.selection.rows);
    const select = (axis: Axis, set: CompactSelection, lo: number, hi: number) => {
      const { grid: g, topRow } = opts.current;
      if (g) opts.current.select(wholeSelection(g, axis, set, lo, hi, topRow));
    };

    const hide = () => {
      if (block.current) block.current.style.display = "none";
      if (line.current) line.current.style.display = "none";
      document.body.classList.remove("dragging-lines");
    };

    /** Lay out the preview for a move, and work out where it lands. */
    const place = (d: Extract<Drag, { kind: "move" }>) => {
      const g = opts.current.grid;
      const a = area();
      const bl = block.current;
      const ln = line.current;
      if (!g || !bl || !ln) return;
      const col = d.axis === "col";
      // The block, following the pointer, kept inside the grid.
      const lo = col ? a.left : a.top;
      const hi = col ? a.right : a.bottom;
      const at = Math.min(Math.max((col ? pointer.x : pointer.y) - d.offset, lo), Math.max(lo, hi - d.size));
      Object.assign(bl.style, col
        ? { display: "block", left: `${at - a.rect.left}px`, top: "0px", width: `${d.size}px`, height: `${a.bottom - a.rect.top}px` }
        : { display: "block", top: `${at - a.rect.top}px`, left: "0px", height: `${d.size}px`, width: `${a.right - a.rect.left}px` });
      // The landing line: on the boundary nearest the pointer, within where it may land.
      const under = indexAt(d.axis, pointer.x, pointer.y);
      const { min, max } = g.landing(d.axis);
      let before: number | null = null;
      let pos = 0;
      if (under) {
        const start = col ? under.b.x : under.b.y;
        const len = col ? under.b.width : under.b.height;
        const first = (col ? pointer.x : pointer.y) < start + len / 2;
        before = first ? under.index : under.index + 1;
        pos = first ? start : start + len;
      } else if ((col ? pointer.x : pointer.y) < lo + 1) before = min;
      else before = max;
      if (before < min || before > max || !under) {
        before = Math.min(Math.max(before, min), max);
        const prev = before > 0 ? (col ? bounds(before - 1, -1) : bounds(-1, before - 1)) : undefined;
        const next = col ? bounds(before, -1) : bounds(-1, before);
        pos = prev ? (col ? prev.x + prev.width : prev.y + prev.height) : next ? (col ? next.x : next.y) : lo;
      }
      d.before = before;
      Object.assign(ln.style, col
        ? { display: "block", left: `${pos - a.rect.left - 1.5}px`, top: "0px", width: "3px", height: `${a.bottom - a.rect.top}px` }
        : { display: "block", top: `${pos - a.rect.top - 1.5}px`, left: "0px", height: "3px", width: `${a.right - a.rect.left}px` });
    };

    /** Scroll while the pointer is near an edge, then follow it. */
    const tick = () => {
      frame = 0;
      if (!drag || drag.kind === "press") return;
      const a = area();
      const col = drag.axis === "col";
      const p = col ? pointer.x : pointer.y;
      const near = col ? (drag.kind === "move" ? a.left : a.frozenRight) : a.top;
      const far = col ? a.right : a.bottom;
      const step = p > far - EDGE ? Math.min(40, (p - (far - EDGE)) / 2) : p < near + EDGE ? -Math.min(40, (near + EDGE - p) / 2) : 0;
      if (step && a.scroller) {
        if (col) a.scroller.scrollLeft += step;
        else a.scroller.scrollTop += step;
      }
      follow();
      if (step) frame = requestAnimationFrame(tick);
    };

    const follow = () => {
      if (!drag) return;
      if (drag.kind === "select") {
        const u = indexAt(drag.axis, pointer.x, pointer.y);
        if (!u || u.index === drag.last) return;
        drag.last = u.index;
        select(drag.axis, drag.base.add([Math.min(drag.anchor, u.index), Math.max(drag.anchor, u.index) + 1]), drag.anchor, u.index);
      } else if (drag.kind === "move") place(drag);
    };

    const startMove = (d: Extract<Drag, { kind: "press" }>) => {
      const g = opts.current.grid;
      if (!g) return null;
      const indices = g.movable(d.axis, selected(d.axis).toArray());
      if (indices.length === 0) return null;
      const col = d.axis === "col";
      const sizes = indices.map((i) => (col ? bounds(i, -1)?.width : bounds(-1, i)?.height) ?? 0);
      const grabbed = col ? bounds(d.index, -1) : bounds(-1, d.index);
      // The block keeps the pointer where it took hold: over the grabbed one, after those before it.
      const before = indices.reduce((s, i, k) => (i < d.index ? s + sizes[k]! : s), 0);
      const offset = (col ? d.x - (grabbed?.x ?? d.x) : d.y - (grabbed?.y ?? d.y)) + before;
      document.body.classList.add("dragging-lines");
      return { kind: "move" as const, axis: d.axis, indices, offset, size: sizes.reduce((a, b) => a + b, 0), before: null };
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      const g = opts.current.grid;
      const args = ed()?.getMouseArgsForPosition(e.clientX, e.clientY, e);
      if (!g || !args) return;
      let axis: Axis;
      let index: number;
      if (args.kind === "header" && args.location[0] >= 0 && !args.isEdge) (axis = "col"), (index = args.location[0]);
      else if (args.kind === "cell" && args.location[0] === -1 && args.location[1] >= 0) (axis = "row"), (index = args.location[1]);
      else return;
      e.stopPropagation();
      const set = selected(axis);
      if (e.button === 2) {
        // A right-click on one not selected selects it, for the menu; Glide opens the menu.
        if (!set.hasIndex(index)) select(axis, span(index, index), index, index), (anchor = { axis, index });
        return;
      }
      e.preventDefault();
      ed()?.focus();
      pointer = { x: e.clientX, y: e.clientY };
      if (e.shiftKey && anchor?.axis === axis) {
        drag = { kind: "select", axis, anchor: anchor.index, base: CompactSelection.empty(), last: index };
        select(axis, span(anchor.index, index), anchor.index, index);
      } else if (e.ctrlKey || e.metaKey) {
        const base = set.hasIndex(index) ? set.remove(index) : set;
        anchor = { axis, index };
        drag = { kind: "select", axis, anchor: index, base, last: index };
        select(axis, set.hasIndex(index) ? base : base.add(index), index, index);
      } else if (set.hasIndex(index) && opts.current.canEdit && g.movable(axis, set.toArray()).length > 0) {
        drag = { kind: "press", axis, index, x: e.clientX, y: e.clientY };
      } else {
        anchor = { axis, index };
        drag = { kind: "select", axis, anchor: index, base: CompactSelection.empty(), last: index };
        select(axis, span(index, index), index, index);
      }
    };

    const onMoveEv = (e: PointerEvent) => {
      if (!drag) return;
      pointer = { x: e.clientX, y: e.clientY };
      if (drag.kind === "press") {
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < THRESHOLD) return;
        drag = startMove(drag);
        if (!drag) return;
      }
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      e.stopPropagation();
      const d = drag;
      drag = null;
      if (frame) cancelAnimationFrame(frame), (frame = 0);
      hide();
      if (d.kind === "press") {
        // A click on one already selected: just that one, as in Sheets.
        anchor = { axis: d.axis, index: d.index };
        select(d.axis, span(d.index, d.index), d.index, d.index);
      } else if (d.kind === "move" && d.before !== null) {
        const start = d.before - d.indices.filter((i) => i < d.before!).length;
        opts.current.move(d.axis, d.indices, d.before);
        select(d.axis, span(start, start + d.indices.length - 1), start, start + d.indices.length - 1);
      }
      ed()?.focus();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag) return;
      e.stopPropagation();
      e.preventDefault();
      drag = null;
      hide();
    };

    box.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMoveEv, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      box.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMoveEv, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      if (frame) cancelAnimationFrame(frame);
      hide();
    };
  }, [o.box]);

  return { block, line };
}
