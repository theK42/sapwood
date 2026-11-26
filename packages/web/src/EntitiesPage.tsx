// The entity page (DESIGN §9.3): the types down the left, the chosen type's entities as a
// list to search, and the chosen entity's form on the right, so entities are read and
// edited without opening a sheet. The type and the entity's ID are in the address, so a
// link or a reload keeps them. ↑ and ↓ in the list step through the entities.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { validate, type Op, type PackId, type Project, type SheetId } from "@thek42/sapwood-core";
import { aOrAn, entityAt, entityList, type ListedEntity } from "./form.ts";
import { FormPanel, NewEntityPanel, type FormRow } from "./FormPanel.tsx";
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
    return [...project.schema.types.values()].filter((t) => !t.def.singleton).map((t) => ({ name: t.def.name, count: n.get(t.def.name) ?? 0 }));
  }, [project, tick]);
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

  const choose = (e: ListedEntity) => {
    setMaking(null);
    if (e.id === null) setNoId(e.at);
    else {
      setNoId(null);
      p.showId(type!, e.id);
    }
  };
  const listRef = useRef<HTMLUListElement>(null);
  const step = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!list.length) return;
    const i = list.findIndex(same);
    const next = list[e.key === "ArrowDown" ? Math.min(list.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)]!;
    choose(next);
  };
  useEffect(() => {
    listRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [chosen?.sheet, chosen?.row]);

  return (
    <main className="entities">
      <nav className="entities-types" aria-label="Types">
        <h2>Types</h2>
        <ul>
          {types.map((t) => (
            <li key={t.name}>
              <button className={t.name === type ? "on" : ""} aria-current={t.name === type ? "page" : undefined} onClick={() => p.openType(t.name)}>
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
            <ul className="entities-rows" ref={listRef} tabIndex={0} onKeyDown={step} aria-label={`Every ${type}`}>
              {list.map((e) => (
                <li key={`${e.at.sheet}|${e.at.row}`}>
                  <button className={same(e) && !making ? "on" : ""} onClick={() => choose(e)} aria-current={same(e) ? "true" : undefined}>
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
        {making && type ? (
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
