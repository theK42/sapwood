// The top bar's search (DESIGN §9.1): type, and the matching types, sheets and entities are
// listed under the box, best first. "Also search inside cells" adds the cells whose text or
// formula holds what's typed (a localized line finds its token's row; a token, every cell
// using it), each named by the entity and field it holds where it holds one. ↑↓ choose;
// Enter opens (an entity or a type on the entity page, a sheet as itself, a cell on its
// sheet); Shift+Enter or Shift-click the other way (an entity's row on its sheet, a type's
// grid, a cell's entity in its form). Ctrl+K (⌘K) or / from anywhere goes to the box.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";
import { cellIndex, search, searchCells, type CellHit, type CellIndex, type Hit } from "./search.ts";

interface Props {
  source: Source;
  /** Open a hit; `other`: the other way (an entity on its sheet, a type as a grid, a cell's entity in its form). */
  open(hit: Hit | CellHit, other: boolean): void;
}

/** Where a typed / is text, not a way to the box: a text field, or a grid (where typing starts an edit). */
const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName) || t.closest(".sheet-grid, .type-grid, [role=grid]") !== null);

const FULL_KEY = "sapwood.search.cells";
const remembered = (): boolean => {
  try {
    return localStorage.getItem(FULL_KEY) === "1";
  } catch {
    return false;
  }
};

/** The text around the first word typed, that word marked; long text cut to fit. */
function snippet(text: string, query: string): ReactNode {
  const word = query.trim().split(/\s+/)[0] ?? "";
  const i = word ? text.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (i < 0) return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  const from = Math.max(0, i - 30);
  const to = Math.min(text.length, i + word.length + 50);
  return (
    <>
      {from > 0 && "…"}
      {text.slice(from, i)}
      <mark>{text.slice(i, i + word.length)}</mark>
      {text.slice(i + word.length, to)}
      {to < text.length && "…"}
    </>
  );
}

export function SearchBox(p: Props) {
  const tick = useSource(p.source);
  const project = p.source.project;
  const [q, setQ] = useState("");
  const [shown, setShown] = useState("");
  const [at, setAt] = useState(0);
  const [openList, setOpenList] = useState(false);
  const [full, setFull] = useState(remembered);
  const box = useRef<HTMLInputElement>(null);
  // Searched a moment after typing stops, so a big project doesn't slow the typing.
  useEffect(() => {
    const t = setTimeout(() => setShown(q), q.length < 2 ? 0 : full ? 250 : 120);
    return () => clearTimeout(t);
  }, [q, full]);
  const showList = openList && q.trim() !== "";

  // Every cell's text, gathered once per version of the project, just after the list shows
  // "Reading every cell…" (it takes a moment on a big project).
  const [index, setIndex] = useState<{ of: unknown; tick: number; index: CellIndex } | null>(null);
  const fresh = index !== null && index.of === project && index.tick === tick;
  useEffect(() => {
    if (!full || !showList || fresh) return;
    const t = setTimeout(() => setIndex({ of: project, tick, index: cellIndex(project) }), 30);
    return () => clearTimeout(t);
  }, [full, showList, fresh, project, tick]);

  const found = useMemo(() => search(project, shown), [project, tick, shown]);
  const cells = useMemo(() => (full && fresh && shown.trim() ? searchCells(project, index.index, shown) : { hits: [], more: 0 }), [full, fresh, index, project, shown]);
  const hits: (Hit | CellHit)[] = [...found.hits, ...cells.hits];
  useEffect(() => setAt(0), [shown, full]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !editable(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        box.current?.focus();
        box.current?.select();
        setOpenList(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const go = (h: Hit | CellHit, other: boolean) => {
    p.open(h, other);
    setOpenList(false);
    setQ("");
    box.current?.blur();
  };
  const toggleFull = () => {
    const next = !full;
    setFull(next);
    try {
      localStorage.setItem(FULL_KEY, next ? "1" : "0");
    } catch {
      // kept for this page only
    }
    box.current?.focus();
  };
  const reading = full && !fresh;
  const behind = shown !== q;

  const row = (h: Hit | CellHit, i: number) => {
    const key = h.kind === "cell" ? `cell|${h.sheet}|${h.row}|${h.col}` : `${h.kind}|${h.kind === "entity" ? `${h.at.sheet}|${h.at.row}` : h.kind === "sheet" ? h.id : h.name}`;
    const common = { key, id: `search-hit-${i}`, role: "option", "aria-selected": i === at, className: i === at ? "on" : "", onMouseEnter: () => setAt(i), onClick: (e: React.MouseEvent) => go(h, e.shiftKey) };
    if (h.kind === "cell")
      return (
        <button {...common} className={`${common.className} search-cell`}>
          <span className="search-kind" title={h.entity ? h.entity.type : h.address}>
            {h.entity ? h.entity.type : "Cell"}
          </span>
          <span className="search-cell-body">
            <span className="search-cell-what">
              {h.entity ? (
                <>
                  <span className="search-id">{h.entity.id ?? "(no ID)"}</span>
                  <span className="muted"> · {h.entity.field === "$id" ? "ID" : h.entity.field === "$type" ? "type" : h.entity.field}</span>
                </>
              ) : (
                <span className="search-id">{h.address}</span>
              )}
              <span className="muted small search-where">{h.entity ? h.address : ""}</span>
            </span>
            <span className="search-text">
              {snippet(h.text, shown)}
              {h.formula && h.formula.toLowerCase().includes(shown.trim().split(/\s+/)[0]?.toLowerCase() ?? "") && (
                <code className="muted"> {snippet(h.formula, shown)}</code>
              )}
            </span>
          </span>
        </button>
      );
    return (
      <button {...common}>
        <span className="search-kind">{h.kind === "entity" ? h.type : h.kind === "type" ? "Type" : "Sheet"}</span>
        <span className={h.kind === "entity" ? (h.active ? "search-id" : "search-id muted") : ""}>{h.kind === "entity" ? h.id : h.name}</span>
        {h.kind === "entity" && !h.active && <span className="tag">commented out</span>}
        <span className="muted small search-where">
          {h.kind === "entity" ? h.where : h.kind === "type" ? plural(h.count, "entity", "entities") : `${h.where} · ${plural(h.rows, "row")}`}
        </span>
      </button>
    );
  };

  return (
    <div className="search" role="search">
      <input
        ref={box}
        className="search-box"
        type="search"
        value={q}
        placeholder={full ? "Search names and cells" : "Search IDs, types, sheets"}
        title="Search (Ctrl+K or /)"
        aria-label={full ? "Search names and inside cells" : "Search IDs, types and sheets"}
        aria-expanded={showList}
        aria-controls="search-results"
        aria-activedescendant={showList && hits[at] ? `search-hit-${at}` : undefined}
        role="combobox"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => (setQ(e.target.value), setOpenList(true))}
        onFocus={() => setOpenList(true)}
        onBlur={(e) => {
          // Focus moving to the list's own checkbox keeps it open.
          if (e.relatedTarget instanceof Node && e.currentTarget.parentElement?.contains(e.relatedTarget)) return;
          setOpenList(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (q) setQ("");
            else box.current?.blur();
            e.preventDefault();
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (hits.length) setAt((i) => (e.key === "ArrowDown" ? Math.min(hits.length - 1, i + 1) : Math.max(0, i - 1)));
          } else if (e.key === "Enter") {
            // What's listed may be a moment behind the box: names are searched now; cells wait.
            const h = behind ? search(project, q).hits[0] : hits[at];
            if (h) {
              e.preventDefault();
              go(h, e.shiftKey);
            }
          }
        }}
      />
      {showList && (
        <div className="search-list" id="search-results" role="listbox" aria-label="Found" onMouseDown={(e) => e.preventDefault()}>
          <label className="search-full small">
            <input type="checkbox" checked={full} onChange={toggleFull} onBlur={(e) => !(e.relatedTarget instanceof Node && e.currentTarget.closest(".search")?.contains(e.relatedTarget)) && setOpenList(false)} />
            <span>Also search inside cells</span>
            <span className="muted">(text and formulas; slower on a big project)</span>
          </label>
          {found.hits.map((h, i) => row(h, i))}
          {found.moreEntities > 0 && <p className="muted small pad">and {plural(found.moreEntities, "more entity", "more entities")} by ID: type more to narrow it</p>}
          {full && (
            <>
              <h3 className="search-group">In cells</h3>
              {reading ? (
                <p className="muted small pad">Reading every cell…</p>
              ) : behind && cells.hits.length === 0 ? (
                <p className="muted small pad">Searching…</p>
              ) : cells.hits.length === 0 ? (
                <p className="muted small pad">No cell holds that.</p>
              ) : (
                cells.hits.map((h, i) => row(h, found.hits.length + i))
              )}
              {cells.more > 0 && <p className="muted small pad">and {plural(cells.more, "more cell")}: type more to narrow it</p>}
            </>
          )}
          {!full && found.hits.length === 0 && <p className="muted small pad">{behind ? "Searching…" : "Nothing called that. Search inside cells for text in them."}</p>}
          {hits.length > 0 && <p className="muted small search-help">Enter opens · Shift+Enter: an entity on its sheet, a type as a grid, a cell's entity in its form</p>}
        </div>
      )}
    </div>
  );
}
