// The top bar's search (DESIGN §9.1): type, and the matching types, sheets and entities are
// listed under the box, best first. ↑↓ choose, Enter opens (an entity or a type on the entity
// page, a sheet as itself), Shift+Enter or Shift-click opens it the other way (an entity's
// row on its sheet, a type's grid). Ctrl+K (⌘K) or / from anywhere goes to the box; Esc leaves.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";
import { search, type Hit } from "./search.ts";

interface Props {
  source: Source;
  /** Open a hit; `other`: the other way (an entity on its sheet, a type as a grid). */
  open(hit: Hit, other: boolean): void;
}

/** Where a typed / is text, not a way to the box: a text field, or a grid (where typing starts an edit). */
const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName) || t.closest(".sheet-grid, .type-grid, [role=grid]") !== null);

export function SearchBox(p: Props) {
  const tick = useSource(p.source);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState("");
  const [at, setAt] = useState(0);
  const [openList, setOpenList] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  // Searched a moment after typing stops, so a big project doesn't slow the typing.
  useEffect(() => {
    const t = setTimeout(() => setShown(q), q.length < 2 ? 0 : 120);
    return () => clearTimeout(t);
  }, [q]);
  const found = useMemo(() => search(p.source.project, shown), [p.source, tick, shown]);
  useEffect(() => setAt(0), [shown]);
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

  const go = (h: Hit, other: boolean) => {
    p.open(h, other);
    setOpenList(false);
    setQ("");
    box.current?.blur();
  };
  const hits = found.hits;
  const showList = openList && q.trim() !== "";

  return (
    <div className="search" role="search">
      <input
        ref={box}
        className="search-box"
        type="search"
        value={q}
        placeholder="Search IDs, types, sheets"
        title="Search (Ctrl+K or /)"
        aria-label="Search IDs, types and sheets"
        aria-expanded={showList}
        aria-controls="search-results"
        aria-activedescendant={showList && hits[at] ? `search-hit-${at}` : undefined}
        role="combobox"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => (setQ(e.target.value), setOpenList(true))}
        onFocus={() => setOpenList(true)}
        onBlur={() => setOpenList(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (q) setQ("");
            else box.current?.blur();
            e.preventDefault();
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (hits.length) setAt((i) => (e.key === "ArrowDown" ? Math.min(hits.length - 1, i + 1) : Math.max(0, i - 1)));
          } else if (e.key === "Enter") {
            // What's listed may be a moment behind the box: search what's typed now.
            const now = shown === q ? hits : search(p.source.project, q).hits;
            const h = now[shown === q ? at : 0];
            if (h) {
              e.preventDefault();
              go(h, e.shiftKey);
            }
          }
        }}
      />
      {showList && (
        <div className="search-list" id="search-results" role="listbox" aria-label="Found" onMouseDown={(e) => e.preventDefault()}>
          {shown !== q && hits.length === 0 ? (
            <p className="muted small pad">Searching…</p>
          ) : hits.length === 0 ? (
            <p className="muted small pad">Nothing called that.</p>
          ) : (
            hits.map((h, i) => (
              <button
                key={`${h.kind}|${h.kind === "entity" ? `${h.at.sheet}|${h.at.row}` : h.kind === "sheet" ? h.id : h.name}`}
                id={`search-hit-${i}`}
                role="option"
                aria-selected={i === at}
                className={i === at ? "on" : ""}
                onMouseEnter={() => setAt(i)}
                onClick={(e) => go(h, e.shiftKey)}
              >
                <span className="search-kind">{h.kind === "entity" ? h.type : h.kind === "type" ? "Type" : "Sheet"}</span>
                <span className={h.kind === "entity" ? (h.active ? "search-id" : "search-id muted") : ""}>{h.kind === "entity" ? h.id : h.name}</span>
                {h.kind === "entity" && !h.active && <span className="tag">commented out</span>}
                <span className="muted small search-where">
                  {h.kind === "entity" ? h.where : h.kind === "type" ? plural(h.count, "entity", "entities") : `${h.where} · ${plural(h.rows, "row")}`}
                </span>
              </button>
            ))
          )}
          {found.moreEntities > 0 && <p className="muted small pad">and {plural(found.moreEntities, "more entity", "more entities")}: type more to narrow it</p>}
          {hits.length > 0 && <p className="muted small search-help">Enter opens · Shift+Enter: an entity on its sheet, a type as a grid</p>}
        </div>
      )}
    </div>
  );
}
