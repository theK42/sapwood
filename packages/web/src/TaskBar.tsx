// The task bar (DESIGN §8.3, §9.1): your current task on the branch, with its validation,
// how it stands against the head, undo and redo, and Land. From its menu: name it, start a
// new one, switch to another of yours, or abandon it.

import { useEffect, useMemo, useRef, useState } from "react";
import { validate } from "@thek42/sapwood-core";
import { ApiError, type Api, type ConflictJson, type Me, type Resolutions, type TaskInfo, type TaskStatus } from "./api.ts";
import { plural, useSource } from "./hooks.ts";
import type { TaskSession } from "./session.ts";

interface Props {
  api: Api;
  branch: string;
  me: Me;
  /** Undefined while loading; null: none on this branch. */
  current: TaskInfo | null | undefined;
  session: TaskSession | null;
  /** Your open tasks on the branch. */
  mine: TaskInfo[];
  /** Bumped when the head moves, to read the task's standing again. */
  headTick: number;
  /** The current task changed: switched, new, landed (then the task carrying redo, or none). */
  setCurrent(t: TaskInfo | null): void;
  /** Open or close the issues panel. */
  toggleIssues(): void;
  /** Open a task's changes. */
  showChanges(task: number): void;
}

export function TaskBar(p: Props) {
  const canEdit = p.me.role !== "viewer" && p.me.scopes.readOnly !== true;
  if (p.current === undefined) return <div className="taskbar" />;
  if (p.current === null || !p.session)
    return (
      <div className="taskbar">
        <span className="muted">{p.current === null ? `You have no task on ${p.branch}. You're seeing its head.` : "Opening your task…"}</span>
        <span className="spacer" />
        <button className="button quiet" onClick={p.toggleIssues}>
          Issues
        </button>
        {canEdit && <TasksMenu {...p} current={null} />}
      </div>
    );
  return <OpenTask {...p} session={p.session} />;
}

function OpenTask(p: Props & { session: TaskSession }) {
  const s = p.session;
  const tick = useSource(s);
  const v = useMemo(() => validate(s.project), [s, tick]);
  const t = s.task;
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [landing, setLanding] = useState(false);

  // How the task stands against the head: read again as it or the head changes.
  useEffect(() => {
    let gone = false;
    void s.settled().then(() => p.api.taskStatus(t.id).then((x) => !gone && setStatus(x), () => {}));
    return () => void (gone = true);
  }, [p.api, s, t.id, t.rev, p.headTick]);

  const conflicts = status?.task.rev === t.rev ? status.conflicts : [];
  const behind = status?.task.rev === t.rev ? status.behind : 0;
  return (
    <div className="taskbar">
      <TaskName api={p.api} session={s} />
      <button className="link muted" onClick={() => p.showChanges(t.id)} title="See what this task changes">
        {plural(t.changes, "change")}
      </button>
      <button className={v.errors > 0 ? "badge error" : v.warnings > 0 ? "badge warn" : "badge ok"} onClick={p.toggleIssues} title="Show or hide the issues">
        {v.errors > 0 || v.warnings > 0 ? [v.errors && plural(v.errors, "error"), v.warnings && plural(v.warnings, "warning")].filter(Boolean).join(", ") : "Valid"}
      </button>
      {behind > 0 && (
        <span className="badge warn" title="Commits landed on the branch since this task started, that it hasn't taken in yet">
          {plural(behind, "commit")} behind
          {conflicts.length > 0 && `, ${plural(conflicts.length, "conflict")}`}
        </span>
      )}
      {s.state.unsent > 0 && <span className="muted">Saving…</span>}
      <span className="spacer" />
      <TasksMenu {...p} current={t} />
      <button className="button quiet" disabled={!t.canUndo || !s.editable} onClick={() => void s.undo()}>
        Undo
      </button>
      <button className="button quiet" disabled={!t.canRedo || !s.editable} onClick={() => void s.redo()}>
        Redo
      </button>
      <button className="button primary" disabled={landing || !s.editable || t.changes === 0 || v.errors > 0} title={v.errors > 0 ? "Fix the errors to land" : undefined} onClick={() => setLanding(true)}>
        Land
      </button>
      {s.notice && (
        <p className="notice" role="status">
          {s.notice}
        </p>
      )}
      {landing && <LandForm {...p} session={s} conflicts={conflicts} done={() => setLanding(false)} />}
    </div>
  );
}

function TaskName({ api, session: s }: { api: Api; session: TaskSession }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const t = s.task;
  const shown = t.name ?? `Task ${t.id}`;
  if (!editing)
    return (
      <button className="task-name" title="Name this task" disabled={!s.editable} onClick={() => (setName(t.name ?? ""), setEditing(true))}>
        {shown}
      </button>
    );
  const save = async () => {
    setEditing(false);
    const next = name.trim() === "" ? null : name.trim();
    if (next !== t.name) s.heard(await api.renameTask(t.id, next));
  };
  return (
    <input
      className="task-name-input"
      autoFocus
      value={name}
      placeholder={`Task ${t.id}`}
      aria-label="Task name"
      onChange={(e) => setName(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void save();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

/** Land, with a message, settling any conflicts with the head one by one. */
function LandForm(p: Props & { session: TaskSession; conflicts: ConflictJson[]; done(): void }) {
  const t = p.session.task;
  const [message, setMessage] = useState("");
  const [conflicts, setConflicts] = useState(p.conflicts);
  const [choice, setChoice] = useState<Resolutions>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unsettled = conflicts.filter((c) => !choice[c.id]).length;
  const land = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await p.session.settled();
      const opts: { message?: string; resolutions: Resolutions } = { resolutions: choice };
      if (message.trim() !== "") opts.message = message.trim();
      const r = await p.api.land(t.id, opts);
      p.done();
      p.setCurrent(r.carried?.task ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "conflict" && Array.isArray(err.detail.conflicts)) setConflicts(err.detail.conflicts as ConflictJson[]);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="land" onSubmit={land}>
      <label>
        <span className="muted">Message</span>
        <input autoFocus value={message} placeholder={t.name ?? `Task ${t.id}`} onChange={(e) => setMessage(e.target.value)} />
      </label>
      {conflicts.length > 0 && (
        <div className="conflicts">
          <p>
            {conflicts.length === 1 ? "A change on the branch clashes with yours. Keep yours, or take the branch's:" : `${conflicts.length} changes on the branch clash with yours. For each, keep yours or take the branch's:`}
          </p>
          <ol>
            {conflicts.map((c) => (
              <li key={c.id}>
                <span>{describe(c)}</span>
                {(["mine", "theirs"] as const).map((side) => (
                  <label key={side} className="choice">
                    <input type="radio" name={c.id} checked={choice[c.id] === side} onChange={() => setChoice({ ...choice, [c.id]: side })} />
                    {side === "mine" ? "Keep mine" : "Take the branch's"}
                  </label>
                ))}
              </li>
            ))}
          </ol>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="button primary" disabled={busy || unsettled > 0}>
          {unsettled > 0 ? `Settle ${plural(unsettled, "conflict")} to land` : "Land"}
        </button>
        <button type="button" className="button quiet" onClick={p.done}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A conflict in words: a cell's two values, or what kind of clash it is. */
export function describe(c: ConflictJson): string {
  const k = c.conflict;
  const shown = (x: unknown) => (x === null ? "blank" : typeof x === "object" && x && "v" in x ? JSON.stringify((x as { v: unknown }).v) : typeof x === "object" && x && "bad" in x ? String((x as { bad: unknown }).bad) : "a formula");
  switch (k.kind) {
    case "cell":
      return `${c.where ? `${c.where.sheet}!${c.where.cell}` : "A cell"}: yours ${shown(k.mine)}, the branch's ${shown(k.theirs)}`;
    case "deleted":
      return `A ${k.axis} you changed was deleted ${k.deletedBy === "mine" ? "by you" : "on the branch"}`;
    case "move":
      return `A ${k.axis} was moved differently on each side`;
    case "rename":
      return `${k.from} was renamed to ${k.mine} by you and to ${k.theirs} on the branch`;
    case "schema":
      return `The schema's ${k.key} was changed differently on each side`;
    case "schemaDeleted":
      return `A schema definition was removed ${k.deletedBy === "mine" ? "by you" : "on the branch"} and changed on the other side`;
    case "enumRename":
      return `${k.from} was renamed to ${k.mine} by you and to ${k.theirs} on the branch`;
    case "op":
      return k.message;
  }
}

/** Your tasks on the branch: switch, start a new one, abandon this one. */
function TasksMenu(p: Props) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && (setOpen(false), setNaming(false));
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);
  const others = p.mine.filter((t) => t.id !== p.current?.id);
  const act = async (f: () => Promise<TaskInfo | null>) => {
    setOpen(false);
    setNaming(false);
    try {
      p.setCurrent(await f());
    } catch (e) {
      alert((e as Error).message);
    }
  };
  return (
    <div className="menu" ref={ref}>
      <button className="button quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
        Tasks ▾
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {others.map((t) => (
            <button key={t.id} role="menuitem" onClick={() => void act(() => p.api.switchTask(t.id))}>
              Switch to {t.name ?? `Task ${t.id}`} <span className="muted">· {plural(t.changes, "change")}</span>
            </button>
          ))}
          {naming ? (
            <form onSubmit={(e) => (e.preventDefault(), void act(() => p.api.newTask(p.branch, name.trim() || null)))}>
              <input autoFocus value={name} placeholder="Name (optional)" aria-label="New task's name" onChange={(e) => setName(e.target.value)} />
              <button className="button">Start</button>
            </form>
          ) : (
            <button role="menuitem" onClick={() => (setName(""), setNaming(true))}>
              New task…
            </button>
          )}
          {p.current && (
            <button
              role="menuitem"
              className="danger"
              onClick={() => confirm(`Abandon ${p.current!.name ?? `Task ${p.current!.id}`}? Its changes won't land. You can reopen it later.`) && void act(async () => (await p.api.abandon(p.current!.id), null))}
            >
              Abandon this task…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
