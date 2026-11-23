// The home page (DESIGN §9.1): the pack tree with its validation badges, beside the branch's
// recent commits and other people's open tasks.

import { useMemo, useState } from "react";
import { validate } from "@thek42/sapwood-core";
import type { CommitInfo, TaskInfo } from "./api.ts";
import type { Source } from "./head.ts";
import { packTree, type Counts, type PackNode } from "./home.ts";
import { ago, plural, useSource } from "./hooks.ts";

interface Props {
  /** Your task, or the head when you have none. */
  source: Source;
  /** Whether that's the head. */
  atHead: boolean;
  commits: CommitInfo[];
  others: TaskInfo[];
}

export function Home({ source, atHead, commits, others }: Props) {
  const tick = useSource(source);
  const tree = useMemo(() => packTree(source.project.doc, validate(source.project).issues), [source, tick]);
  return (
    <div className="home">
      <section className="panel tree" aria-label="Packs and sheets">
        <h2>
          Packs and sheets <span className="muted small">{atHead ? "on the branch head" : "in your task"}</span>
        </h2>
        {(tree.project.errors > 0 || tree.project.warnings > 0) && (
          <p className="small">
            <Badges c={tree.project} /> <span className="muted">not on any sheet</span>
          </p>
        )}
        <Pack node={tree.root} depth={0} />
      </section>
      <aside className="side">
        <section className="panel" aria-label="Recent commits">
          <h2>Recent commits</h2>
          {commits.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="list">
              {commits.slice(0, 12).map((c) => (
                <li key={c.id}>
                  <span className="line">{c.message || <span className="muted">(no message)</span>}</span>
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
                  <span className="line">{t.name ?? `Task ${t.id}`}</span>
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

function Pack({ node, depth }: { node: PackNode; depth: number }) {
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
              <span>{s.name}</span>
              {s.kind === "scratch" && <span className="tag">scratch</span>}
              <span className="muted small">{plural(s.rows, "row")}</span>
              <Badges c={s} />
            </li>
          ))}
          {empty && <li className="muted small">Empty</li>}
          {node.packs.map((q) => (
            <li key={q.id} className="sub">
              <Pack node={q} depth={depth + 1} />
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
