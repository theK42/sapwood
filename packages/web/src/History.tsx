// History (DESIGN §8.7, §9.2): the branch's commit log, what a commit changed, and what a
// task changes. A diff compares two whole states (core's diffProjects): a commit against its
// parent, a task against the commit it's based on. From a commit: revert it, or restore the
// branch to it, each as a new task of yours.

import { useEffect, useMemo, useState } from "react";
import { diffProjects, docFromJson, emptyDoc, Project, type DocDiff, type EntityDiff, type SheetDiff } from "@thek42/sapwood-core";
import type { Api, CommitInfo, TaskInfo, TaskStatus } from "./api.ts";
import type { Source } from "./head.ts";
import { ago, plural, useSource } from "./hooks.ts";

const project = async (api: Api, commit: string | null, like?: Project): Promise<Project> =>
  commit === null ? Project.fromDoc(emptyDoc(like!.doc.schema)) : Project.fromDoc(docFromJson((await api.commitDoc(commit)).doc));

// ------------------------------------------------------------ the log

export function HistoryPage(p: { api: Api; branch: string; tick: number; open(commit: string): void; href(commit: string): string; back(): void }) {
  const [log, setLog] = useState<CommitInfo[] | null>(null);
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    let gone = false;
    p.api.commits(p.branch, limit).then((x) => !gone && setLog(x), () => !gone && setLog([]));
    return () => void (gone = true);
  }, [p.api, p.branch, limit, p.tick]);
  return (
    <main className="body history">
      <div className="page-head">
        <button className="button quiet" onClick={p.back} title="Back to the packs">
          ←
        </button>
        <h1>History of {p.branch}</h1>
      </div>
      {log === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="log">
          {log.map((c) => (
            <li key={c.id}>
              <a
                href={p.href(c.id)}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  p.open(c.id);
                }}
              >
                {c.message || <span className="muted">(no message)</span>}
              </a>
              {c.parents.length > 1 && <span className="tag">merge</span>}
              <span className="muted small">
                {c.author} · {ago(c.at)} · <code>{c.id.slice(0, 8)}</code>
              </span>
            </li>
          ))}
        </ul>
      )}
      {log && log.length === limit && (
        <button className="button" onClick={() => setLimit(limit * 2)}>
          Show more
        </button>
      )}
    </main>
  );
}

// ------------------------------------------------------------ a commit

export function CommitPage(p: { api: Api; branch: string; id: string; canEdit: boolean; back(): void; made(t: TaskInfo): void }) {
  const [state, setState] = useState<{ info: CommitInfo; diff: DocDiff } | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    setState(null);
    (async () => {
      try {
        const info = await p.api.commit(p.id);
        const after = await project(p.api, info.id);
        const before = await project(p.api, info.parents[0] ?? null, after);
        if (!gone) setState({ info, diff: diffProjects(before, after) });
      } catch (e) {
        if (!gone) setState({ error: (e as Error).message });
      }
    })();
    return () => void (gone = true);
  }, [p.api, p.id]);

  const act = async (what: "revert" | "restore", info: CommitInfo) => {
    const ask =
      what === "revert"
        ? `Make a new task that undoes “${info.message || info.id.slice(0, 8)}”? It becomes your current task; nothing changes on ${p.branch} until you land it.`
        : `Make a new task that takes ${p.branch} back to how it was at “${info.message || info.id.slice(0, 8)}”? It becomes your current task; nothing changes on ${p.branch} until you land it.`;
    if (!confirm(ask)) return;
    setBusy(true);
    try {
      const s: TaskStatus = what === "revert" ? await p.api.revert(info.id) : await p.api.restore(p.branch, info.id);
      p.made(s.task);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="body history">
      <div className="page-head">
        <button className="button quiet" onClick={p.back} title="Back to the history">
          ←
        </button>
        <h1>{state && "info" in state ? state.info.message || "(no message)" : "Commit"}</h1>
      </div>
      {state === null && <p className="muted">Loading…</p>}
      {state && "error" in state && <p className="error">{state.error}</p>}
      {state && "info" in state && (
        <>
          <p className="muted small">
            {state.info.author} · {new Date(state.info.at).toLocaleString()} · <code>{state.info.id.slice(0, 12)}</code>
            {state.info.task !== null && <> · from task {state.info.task}</>}
            {state.info.parents.length > 1 && <> · merged in from another branch</>}
          </p>
          {p.canEdit && (
            <p className="actions">
              <button className="button" disabled={busy || state.info.parents.length === 0} onClick={() => act("revert", state.info)} title="A new task with this commit's changes undone">
                Revert this commit
              </button>
              <button className="button" disabled={busy} onClick={() => act("restore", state.info)} title={`A new task that takes ${p.branch} back to this state`}>
                Restore {p.branch} to here
              </button>
            </p>
          )}
          <DiffView diff={state.diff} />
        </>
      )}
    </main>
  );
}

// ------------------------------------------------------------ a task

/**
 * What a task changes, against the commit it's based on. Your own task's is live (`source`);
 * another person's is read once. On your own, an entity or cell goes there when clicked.
 */
export function ChangesPage(p: { api: Api; task: number; source: Source | null; mine: boolean; back(): void; goTo?(sheet: string, row: number, col: number | null): void }) {
  const [other, setOther] = useState<{ info: TaskInfo; after: Project } | { error: string } | null>(null);
  const [base, setBase] = useState<{ id: string; project: Project } | null>(null);
  const tick = useSource(p.source ?? NO_SOURCE);
  const live = p.mine && p.source && "task" in p.source ? (p.source as Source & { task: TaskInfo }) : null;

  useEffect(() => {
    if (live) return;
    let gone = false;
    p.api.taskDoc(p.task).then(
      (x) => !gone && setOther({ info: x.task, after: Project.fromDoc(docFromJson(x.doc)) }),
      (e: unknown) => !gone && setOther({ error: (e as Error).message }),
    );
    return () => void (gone = true);
  }, [p.api, p.task, !!live]);

  const info = live ? live.task : other && "info" in other ? other.info : null;
  const after = live ? live.project : other && "after" in other ? other.after : null;
  useEffect(() => {
    if (!info || base?.id === info.base) return;
    let gone = false;
    void project(p.api, info.base).then((x) => !gone && setBase({ id: info.base, project: x }), () => {});
    return () => void (gone = true);
  }, [p.api, info?.base]);

  const diff = useMemo(() => (after && base && info && base.id === info.base ? diffProjects(base.project, after) : null), [after, base, info?.base, tick]);
  const error = other && "error" in other ? other.error : null;
  return (
    <main className="body history">
      <div className="page-head">
        <button className="button quiet" onClick={p.back} title="Back">
          ←
        </button>
        <h1>{info ? `Changes in ${info.name ?? `task ${info.id}`}` : "Changes"}</h1>
      </div>
      {error && <p className="error">{error}</p>}
      {info && (
        <p className="muted small">
          {info.owner} · {plural(info.changes, "change")} · started {ago(info.createdAt)}, last edit {ago(info.updatedAt)} · against <code>{info.base.slice(0, 8)}</code>
          {info.state !== "open" && <> · {info.state}</>}
        </p>
      )}
      {!error && !diff && <p className="muted">Loading…</p>}
      {diff && <DiffView diff={diff} {...(p.mine && p.goTo ? { goTo: p.goTo } : {})} />}
    </main>
  );
}

const NO_SOURCE: Source = { project: null as unknown as Project, subscribe: () => () => {} };

// ------------------------------------------------------------ a diff

const MAX = 200; // entries shown per sheet before "N more"

export function DiffView(p: { diff: DocDiff; goTo?(sheet: string, row: number, col: number | null): void }) {
  const { schema, sheets } = p.diff;
  if (schema.length === 0 && sheets.length === 0) return <p className="muted">No changes.</p>;
  return (
    <div className="diff">
      {schema.length > 0 && (
        <section className="panel">
          <h2>Schema</h2>
          <ul className="diff-lines">
            {schema.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </section>
      )}
      {sheets.map((s) => (
        <SheetSection key={s.sheet} s={s} {...(p.goTo && s.status !== "removed" ? { goTo: p.goTo } : {})} />
      ))}
    </div>
  );
}

function SheetSection({ s, goTo }: { s: SheetDiff; goTo?(sheet: string, row: number, col: number | null): void }) {
  const [all, setAll] = useState(false);
  const counts = [
    s.rows.added && `${plural(s.rows.added, "row")} added`,
    s.rows.removed && `${plural(s.rows.removed, "row")} removed`,
    s.rows.moved && `${plural(s.rows.moved, "row")} moved`,
    s.cols.added && `${plural(s.cols.added, "column")} added`,
    s.cols.removed && `${plural(s.cols.removed, "column")} removed`,
    s.cols.moved && `${plural(s.cols.moved, "column")} moved`,
    s.formats && `${plural(s.formats, "cell")}' formatting changed`,
  ].filter(Boolean);
  const items = [...s.entities.map((e) => ({ e })), ...s.cells.map((c) => ({ c }))];
  const shown = all ? items : items.slice(0, MAX);
  const link = (row: number | null, col: number | null, label: React.ReactNode) =>
    goTo && row !== null ? (
      <button className="link" onClick={() => goTo(s.sheet, row, col)}>
        {label}
      </button>
    ) : (
      label
    );
  return (
    <section className="panel">
      <h2>
        {s.name}
        {s.status !== "changed" && <span className={`tag ${s.status}`}>{s.status}</span>}
        {s.renamedFrom && <span className="muted small"> renamed from {s.renamedFrom}</span>}
      </h2>
      {counts.length > 0 && <p className="muted small">{counts.join(" · ")}</p>}
      {shown.length > 0 && (
        <ul className="diff-list">
          {shown.map((x, i) =>
            "e" in x ? (
              <li key={i}>
                <div>
                  <span className={`tag ${entityClass(x.e)}`}>{x.e.change}</span> {link(x.e.row, 1, <strong>{x.e.type} {x.e.id || <span className="muted">(no ID)</span>}</strong>)}
                  {x.e.renamedFrom !== undefined && (
                    <span className="muted small">
                      {" "}
                      renamed from <Val v={x.e.renamedFrom} />
                    </span>
                  )}
                </div>
                {x.e.fields.length > 0 && (
                  <table className="diff-fields">
                    <tbody>
                      {x.e.fields.map((f, j) => (
                        <tr key={j}>
                          <th>{link(x.e.row, f.col, f.name)}</th>
                          <td>{x.e.change !== "added" && <Val v={f.before} old />}</td>
                          <td className="arrow">{x.e.change !== "added" && "→"}</td>
                          <td>
                            <Val v={f.after} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ) : (
              <li key={i} className="diff-cell">
                <code>{link(x.c.removed ? null : x.c.row, x.c.col, x.c.where)}</code> <Val v={x.c.before} old /> <span className="arrow">→</span> <Val v={x.c.after} />
              </li>
            ),
          )}
        </ul>
      )}
      {!all && items.length > MAX && (
        <button className="button quiet" onClick={() => setAll(true)}>
          {plural(items.length - MAX, "more change")}
        </button>
      )}
    </section>
  );
}

const entityClass = (e: EntityDiff) => (e.change === "added" || e.change === "uncommented" ? "added" : e.change === "removed" || e.change === "commented out" ? "removed" : "changed");

function Val({ v, old }: { v: string; old?: boolean }) {
  if (v === "") return <span className="muted small">(blank)</span>;
  return <span className={old ? "val old" : "val new"}>{v.length > 120 ? v.slice(0, 119) + "…" : v}</span>;
}
