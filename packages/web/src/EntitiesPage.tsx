// The entity page (DESIGN §9.3): the types down the left, the chosen type's entities as a
// list to search, and the chosen entity's form on the right, so entities are read and
// edited without opening a sheet. The type and the entity's ID are in the address, so a
// link or a reload keeps them. ↑ and ↓ in the list step through the entities.
//
// Several can be picked at once (each row's checkbox, Ctrl- or ⌘-click, Shift-click or
// Shift+↑↓ for a run, Ctrl+A for all those listed): the form then edits them together.
//
// The types can be put in your own order (dragged, or Alt+↑↓ on one), kept in this browser
// (typeOrder.ts); "Schema order" goes back to the schema's, which everyone shares.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { validate, type Op, type PackId, type Project, type SheetId } from "@thek42/sapwood-core";
import { aOrAn, entityAt, entityList, type ListedEntity } from "./form.ts";
import { FormPanel, NewEntityPanel, type FormRow } from "./FormPanel.tsx";
import { MultiForm } from "./MultiForm.tsx";
import { inOrder, moveIn, saveOrder, savedOrder } from "./typeOrder.ts";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";

interface Props {
  source: Source;
  type: string | null;
  id: string | null;
  canEdit: boolean;
  edit(fn: (p: Project) => { ops: Op[] }): void;
  /** Another type: a new page in the history. */
  openType(type: string): void;
  /** Another entity of the type: the address follows, without a new page in the history. */
  showId(type: string, id: string | null): void;
  /** The type's grid (its type view). */
  openGrid(type: string): void;
  goTo(sheet: SheetId, row: number, col: number | null): void;
  /** Move entities to another pack. */
  moveEntities?(ids: string[]): void;
  /** An entity's history. */
  history?(id: string): void;
  /** Run a wizard. */
  runWizard?(name: string): void;
}

export function EntitiesPage(p: Props) {
  const tick = useSource(p.source);
  const project = p.source.project;
  const issues = useMemo(() => validate(project).issues, [project, tick]);
  const types = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of project.project().entities) n.set(e.type, (n.get(e.type) ?? 0) + 1);
    return [...project.schema.types.values()].filter((t) => !t.def.singleton).map((t) => ({ id: t.def.id, name: t.def.name, count: n.get(t.def.name) ?? 0 }));
  }, [project, tick]);
  // Your own order of them, if you've set one.
  const [order, setOrder] = useState<string[]>(savedOrder);
  const shownTypes = useMemo(() => inOrder(types, order), [types, order]);
  const reorder = (ids: string[]) => {
    const same = ids.join("|") === types.map((t) => t.id).join("|");
    setOrder(same ? [] : ids);
    saveOrder(same ? [] : ids);
  };
  const [dragType, setDragType] = useState<string | null>(null);
  const [overType, setOverType] = useState<{ id: string; where: "before" | "after" } | null>(null);
  const type = p.type !== null && types.some((t) => t.name === p.type) ? p.type : null;
  const [search, setSearch] = useState("");
  useEffect(() => setSearch(""), [type]);
  const list = useMemo(() => (type ? entityList(project, type, search, issues) : []), [project, type, search, issues]);
  // A row without an ID has nothing to put in the address: it's chosen here.
  const [noId, setNoId] = useState<FormRow | null>(null);
  const [making, setMaking] = useState<{ pack: PackId | null; n: number } | null>(null);
  useEffect(() => (setNoId(null), setMaking(null)), [type]);
  const chosen: FormRow | null = useMemo(() => {
    if (noId) return noId;
    if (p.id === null || type === null) return null;
    const all = entityList(project, type, "", issues).filter((e) => e.id === p.id);
    return (all.find((e) => e.active) ?? all[0])?.at ?? null;
  }, [noId, p.id, type, project, issues]);
  const same = (e: ListedEntity) => chosen !== null && e.at.sheet === chosen.sheet && e.at.row === chosen.row;

  // The selection, by row; two or more and the form edits them together. Rows that are no
  // longer the type's entities (deleted, or another type now) drop out of it.
  const [picked, setPicked] = useState<Map<string, FormRow>>(new Map());
  useEffect(() => setPicked(new Map()), [type]);
  const key = (at: FormRow) => `${at.sheet}|${at.row}`;
  const all = useMemo(() => (type ? entityList(project, type, "", issues) : []), [project, type, issues]);
  const live = useMemo(() => new Set(all.map((e) => key(e.at))), [all]);
  const selection = [...picked.entries()].filter(([k]) => live.has(k)).map(([, at]) => at);
  const multi = selection.length > 1;
  const isPicked = (e: ListedEntity) => (multi ? picked.has(key(e.at)) && live.has(key(e.at)) : same(e));

  const choose = (e: ListedEntity) => {
    setMaking(null);
    setPicked(new Map());
    if (e.id === null) setNoId(e.at);
    else {
      setNoId(null);
      p.showId(type!, e.id);
    }
  };
  /** The one in the form joins the selection when another is added to it. */
  const startingFrom = (): Map<string, FormRow> => (picked.size || !chosen ? new Map(picked) : new Map([[key(chosen), chosen]]));
  const toggle = (e: ListedEntity) => {
    setMaking(null);
    const m = startingFrom();
    if (m.has(key(e.at))) m.delete(key(e.at));
    else m.set(key(e.at), e.at);
    settle(m);
  };
  /** Down to one: that one, on its own, in the form. */
  const settle = (m: Map<string, FormRow>) => {
    const left = [...m.values()].filter((at) => live.has(key(at)));
    if (left.length === 1) {
      const e = all.find((x) => key(x.at) === key(left[0]!));
      if (e) return choose(e);
    }
    setPicked(m);
  };
  /** Shift: everything listed from the last one picked (or the one in the form) to this one. */
  const extend = (e: ListedEntity) => {
    setMaking(null);
    const anchor = [...picked.values()].at(-1) ?? chosen;
    const a = anchor ? list.findIndex((x) => key(x.at) === key(anchor)) : -1;
    const b = list.findIndex((x) => key(x.at) === key(e.at));
    if (a < 0 || b < 0) return toggle(e);
    const m = startingFrom();
    m.delete(key(list[a]!.at));
    for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) m.set(key(x.at), x.at);
    // Keep the anchor last, so another Shift-click runs from it again.
    m.set(key(list[a]!.at), list[a]!.at);
    setPicked(m);
  };
  const click = (ev: React.MouseEvent, e: ListedEntity) => {
    if (ev.shiftKey) {
      ev.preventDefault();
      extend(e);
    } else if (ev.ctrlKey || ev.metaKey) toggle(e);
    else choose(e);
  };
  const listRef = useRef<HTMLUListElement>(null);
  const step = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && e.currentTarget === listRef.current) {
      e.preventDefault();
      setPicked(new Map(list.map((x) => [key(x.at), x.at])));
      return;
    }
    if (e.key === "Escape" && multi) return setPicked(new Map());
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!list.length) return;
    const here = multi ? ([...picked.values()].at(-1) ?? chosen) : chosen;
    const i = here ? list.findIndex((x) => key(x.at) === key(here)) : -1;
    const next = list[e.key === "ArrowDown" ? Math.min(list.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)]!;
    if (e.shiftKey) {
      const m = startingFrom();
      if (m.has(key(next.at)) && here && m.size > 1) m.delete(key(here)); // stepping back over the run shrinks it
      else m.set(key(next.at), next.at);
      m.delete(key(next.at));
      m.set(key(next.at), next.at);
      settle(m);
    } else choose(next);
  };
  useEffect(() => {
    listRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [chosen?.sheet, chosen?.row]);

  return (
    <main className="entities">
      <nav className="entities-types" aria-label="Types">
        <h2 className="entities-types-head">
          Types
          {order.length > 0 && (
            <button className="link small" onClick={() => reorder([])} title="Back to the schema's order, which everyone shares">
              Schema order
            </button>
          )}
        </h2>
        <ul>
          {shownTypes.map((t) => (
            <li
              key={t.id}
              draggable
              className={`${dragType === t.id ? "dragging" : ""}${overType?.id === t.id ? ` drop-${overType.where}` : ""}`}
              title="Drag to put the types in your own order (kept in this browser)"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", t.name);
                setDragType(t.id);
              }}
              onDragEnd={() => (setDragType(null), setOverType(null))}
              onDragOver={(e) => {
                if (!dragType) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const where = e.clientY < r.top + r.height / 2 ? "before" : "after";
                if (overType?.id !== t.id || overType.where !== where) setOverType({ id: t.id, where });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragType && overType) reorder(moveIn(shownTypes.map((x) => x.id), dragType, overType.id, overType.where));
                setDragType(null);
                setOverType(null);
              }}
            >
              <button
                className={t.name === type ? "on" : ""}
                aria-current={t.name === type ? "page" : undefined}
                onClick={() => p.openType(t.name)}
                onKeyDown={(e) => {
                  // Alt+↑↓: move it up or down in your order, keeping the focus on it.
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  const ids = shownTypes.map((x) => x.id);
                  const i = ids.indexOf(t.id);
                  const j = e.key === "ArrowUp" ? i - 1 : i + 1;
                  if (j < 0 || j >= ids.length) return;
                  reorder(moveIn(ids, t.id, ids[j]!, e.key === "ArrowUp" ? "before" : "after"));
                  const btn = e.currentTarget;
                  requestAnimationFrame(() => btn.focus());
                }}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              >
                <span>{t.name}</span>
                <span className="muted small">{t.count}</span>
              </button>
            </li>
          ))}
        </ul>
        {p.runWizard && project.schema.schema.wizards.length > 0 && (
          <>
            <h2>Wizards</h2>
            <ul>
              {project.schema.schema.wizards.map((w) => (
                <li key={w.id}>
                  <button onClick={() => p.runWizard!(w.name)} title={w.description ?? `Run ${w.name}`}>
                    <span>{w.title ?? w.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
      <section className="entities-list" aria-label={type ? `Every ${type}` : "Entities"}>
        {type === null ? (
          <p className="muted pad">Pick a type to see its entities.</p>
        ) : (
          <>
            <div className="entities-bar">
              <input className="vf-input" type="search" placeholder={`Find ${aOrAn(type)} by ID or sheet`} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={step} aria-label="Find" />
            </div>
            <div className="entities-bar small">
              <span className="muted">{search ? `${list.length} found` : plural(list.length, "entity", "entities")}</span>
              {multi ? (
                <button className="link" onClick={() => setPicked(new Map())} title="Clear the selection (Esc)">
                  {selection.length} picked ×
                </button>
              ) : (
                list.length > 1 && (
                  <button className="link" onClick={() => setPicked(new Map(list.map((x) => [key(x.at), x.at])))} title="Pick every one listed, to edit them together">
                    Pick all
                  </button>
                )
              )}
              <span className="spacer" />
              <button className="link" onClick={() => p.openGrid(type)} title={`Every ${type} as a grid`}>
                Grid
              </button>
              {p.canEdit && (
                <button className="button quiet small" onClick={() => setMaking((m) => ({ pack: null, n: (m?.n ?? 0) + 1 }))}>
                  + New {type}
                </button>
              )}
            </div>
            <ul className={multi ? "entities-rows picking" : "entities-rows"} ref={listRef} tabIndex={0} onKeyDown={step} aria-label={`Every ${type}`}>
              {list.map((e) => (
                <li key={`${e.at.sheet}|${e.at.row}`} className="entities-row">
                  <input
                    type="checkbox"
                    className="entities-pick"
                    checked={multi ? isPicked(e) : false}
                    onChange={() => toggle(e)}
                    onClick={(ev) => {
                      if (ev.shiftKey) {
                        ev.preventDefault();
                        extend(e);
                      }
                    }}
                    tabIndex={-1}
                    aria-label={`Pick ${e.id ?? "this row"}`}
                  />
                  <button className={isPicked(e) && !making ? "on" : ""} onClick={(ev) => click(ev, e)} aria-current={same(e) && !multi ? "true" : undefined}>
                    <span className={e.active ? "entities-id" : "entities-id muted"}>{e.id ?? <em>(no ID)</em>}</span>
                    {!e.active && <span className="tag">commented out</span>}
                    {e.errors > 0 && <span className="badge error">{e.errors}</span>}
                    {e.errors === 0 && e.warnings > 0 && <span className="badge warn">{e.warnings}</span>}
                    <span className="muted small entities-where">{e.where}</span>
                  </button>
                </li>
              ))}
              {list.length === 0 && <li className="muted small pad">{search ? "None match." : `No ${type} yet.`}</li>}
            </ul>
          </>
        )}
      </section>
      <section className="entities-form">
        {multi && type ? (
          <MultiForm
            source={p.source}
            rows={selection}
            canEdit={p.canEdit}
            edit={p.edit}
            showOne={(e) => choose({ id: e.id, at: { sheet: e.at.sheet, row: e.at.row }, where: "", active: e.active, errors: 0, warnings: 0 })}
            clear={() => setPicked(new Map())}
            {...(p.moveEntities ? { move: p.moveEntities } : {})}
          />
        ) : making && type ? (
          <NewEntityPanel
            key={making.n}
            embedded
            source={p.source}
            type={type}
            pack={making.pack}
            canEdit={p.canEdit}
            edit={p.edit}
            made={(at) => {
              // It may be of another type, picked in the form: the page goes to that type.
              setMaking(null);
              const e = entityAt(p.source.project, at.sheet, at.row);
              if (e?.id) p.showId(e.type, e.id);
            }}
            close={() => setMaking(null)}
          />
        ) : chosen ? (
          <FormPanel embedded source={p.source} at={chosen} canEdit={p.canEdit} edit={p.edit} goTo={p.goTo} {...(p.moveEntities ? { move: (id: string) => p.moveEntities!([id]) } : {})} {...(p.history ? { history: p.history } : {})} newEntity={(_, pack) => setMaking((m) => ({ pack, n: (m?.n ?? 0) + 1 }))} />
        ) : (
          type && <p className="muted pad">Pick {aOrAn(type)} from the list{p.canEdit ? `, or add a new one` : ""}.</p>
        )}
      </section>
    </main>
  );
}
