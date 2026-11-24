// The home page (DESIGN §9.1): the pack tree with its validation badges, beside the branch's
// recent commits and other people's open tasks.

import { useMemo, useState } from "react";
import { validate } from "@thek42/sapwood-core";
import type { CommitInfo, TaskInfo } from "./api.ts";
import type { Source } from "./head.ts";
import { packTree, type Counts, type PackNode } from "./home.ts";
import { ago, plural, useSource } from "./hooks.ts";
import type { Route } from "./routes.ts";

interface Props {
  /** Your task, or the head when you have none. */
  source: Source;
  /** Whether that's the head. */
  atHead: boolean;
  commits: CommitInfo[];
  others: TaskInfo[];
  /** Open a sheet, by its ID; and its address, for a link. */
  open(sheet: string): void;
  href(sheet: string): string;
  showIssues(): void;
  /** Open a type view; and its address. */
  openType(type: string): void;
  typeHref(type: string): string;
  /** Go to another page in the branch; and its address. */
  go(r: Route): void;
  routeHref(r: Route): string;
}

export function Home({ source, atHead, commits, others, open, href, showIssues, openType, typeHref, go, routeHref }: Props) {
  const nav = (r: Route, label: React.ReactNode) => (
    <a
      href={routeHref(r)}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(r);
      }}
    >
      {label}
    </a>
  );
  const tick = useSource(source);
  // Entity types, with how many of each there are (commented-out ones too).
  const types = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of source.project.project().entities) n.set(e.type, (n.get(e.type) ?? 0) + 1);
    return [...source.project.schema.types.values()].filter((t) => !t.def.singleton).map((t) => ({ name: t.def.name, count: n.get(t.def.name) ?? 0 }));
  }, [source, tick]);
  const tree = useMemo(() => packTree(source.project.doc, validate(source.project).issues), [source, tick]);
  return (
    <div className="home">
      <section className="panel tree" aria-label="Packs and sheets">
        <h2>
          Packs and sheets <span className="muted small">{atHead ? "on the branch head" : "in your task"}</span>
        </h2>
        {(tree.project.errors > 0 || tree.project.warnings > 0) && (
          <p className="small">
            <Badges c={tree.project} /> <span className="muted">not on any sheet</span>{" "}
            <button className="link" onClick={showIssues}>
              Show
            </button>
          </p>
        )}
        <Pack node={tree.root} depth={0} open={open} href={href} />
      </section>
      <aside className="side">
        <section className="panel" aria-label="Entities">
          <h2>
            Entities <span className="muted small">by type, each in a form; or every one of a type as a grid</span>
          </h2>
          <ul className="type-list">
            {types.map((t) => (
              <li key={t.name}>
                {nav({ kind: "entities", type: t.name, id: null }, t.name)} <span className="muted small">{t.count}</span>{" "}
                <a
                  className="small"
                  href={typeHref(t.name)}
                  title={`Every ${t.name} as a grid`}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    openType(t.name);
                  }}
                >
                  grid
                </a>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel" aria-label="Recent commits">
          <h2>
            Recent commits <span className="small">{nav({ kind: "history" }, "All history")}</span>
          </h2>
          {commits.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="list">
              {commits.slice(0, 12).map((c) => (
                <li key={c.id}>
                  <span className="line">{nav({ kind: "commit", id: c.id }, c.message || <span className="muted">(no message)</span>)}</span>
                  <span className="muted small">
                    {c.author} · {ago(c.at)} · <code>{c.id.slice(0, 8)}</code>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-label="Other people's tasks">
          <h2>Other people's tasks</h2>
          {others.length === 0 ? (
            <p className="muted">No one else has a task open here.</p>
          ) : (
            <ul className="list">
              {others.map((t) => (
                <li key={t.id}>
                  <span className="line">{nav({ kind: "changes", task: t.id }, t.name ?? `Task ${t.id}`)}</span>
                  <span className="muted small">
                    {t.owner} · {plural(t.changes, "change")} · {ago(t.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

function Pack({ node, depth, open: openSheet, href }: { node: PackNode; depth: number; open(sheet: string): void; href(sheet: string): string }) {
  const [open, setOpen] = useState(true);
  const empty = node.sheets.length === 0 && node.packs.length === 0;
  return (
    <div className="pack" style={{ marginLeft: depth === 0 ? 0 : 14 }}>
      <button className="pack-name" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span> {node.name} <Badges c={node} />
      </button>
      {open && (
        <ul className="sheet-list">
          {node.sheets.map((s) => (
            <li key={s.id}>
              <a
                href={href(s.id)}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  openSheet(s.id);
                }}
              >
                {s.name}
              </a>
              {s.kind === "scratch" && <span className="tag">scratch</span>}
              <span className="muted small">{plural(s.rows, "row")}</span>
              <Badges c={s} />
            </li>
          ))}
          {empty && <li className="muted small">Empty</li>}
          {node.packs.map((q) => (
            <li key={q.id} className="sub">
              <Pack node={q} depth={depth + 1} open={openSheet} href={href} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Badges({ c }: { c: Counts }) {
  return (
    <>
      {c.errors > 0 && <span className="badge error">{plural(c.errors, "error")}</span>}
      {c.warnings > 0 && <span className="badge warn">{plural(c.warnings, "warning")}</span>}
    </>
  );
}
