// The app's frame: signing in, then the workspace for one branch, with your current task.
// The branch is in the address (/branches/<name>), so a link or a reload keeps it.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { validate } from "@thek42/sapwood-core";
import { Api, ApiError, type BranchInfo, type Health, type Me, type TaskInfo } from "./api.ts";
import { listen } from "./events.ts";
import { TaskSession } from "./session.ts";

const api = new Api();

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(() => {
    api.me().then(setMe, (e: unknown) => (e instanceof ApiError && e.status === 401 ? setMe(null) : setError(String((e as Error).message))));
  }, []);
  useEffect(() => {
    api.health().then(setHealth, () => setError("Can't reach the Sapwood server"));
    check();
  }, [check]);

  if (error) return <Centered><p className="error">{error}</p></Centered>;
  if (me === undefined || health === null) return <Centered><p className="muted">Loading…</p></Centered>;
  if (me === null) return <SignIn health={health} signedIn={check} />;
  return <Workspace me={me} signedOut={() => setMe(null)} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>;
}

// ------------------------------------------------------------ signing in

function SignIn({ health, signedIn }: { health: Health; signedIn(): void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signInWithToken(token);
      setToken("");
      signedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centered>
      <div className="card signin">
        <h1>Sapwood</h1>
        {health.github && (
          <a className="button primary wide" href="/auth/github">
            Sign in with GitHub
          </a>
        )}
        <form onSubmit={submit}>
          <label htmlFor="token">{health.github ? "Or sign in with a Sapwood token" : "Sign in with a Sapwood token"}</label>
          <input id="token" type="password" autoComplete="off" spellCheck={false} placeholder="swd_…" value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="button wide" disabled={busy || token.trim() === ""}>
            Sign in
          </button>
          {error && <p className="error">{error}</p>}
        </form>
        {!health.github && <p className="muted small">This server has no GitHub sign-in. Ask its admin for a token.</p>}
      </div>
    </Centered>
  );
}

// ------------------------------------------------------------ the workspace

function branchFromPath(): string | null {
  const m = /^\/branches\/([^/]+)/.exec(location.pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

function Workspace({ me, signedOut }: { me: Me; signedOut(): void }) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branch, setBranch] = useState<string>(branchFromPath() ?? "main");
  const [current, setCurrent] = useState<TaskInfo | null | undefined>(undefined);
  const [session, setSession] = useState<TaskSession | null>(null);

  const go = (b: string) => {
    history.pushState(null, "", `/branches/${encodeURIComponent(b)}`);
    setBranch(b);
  };
  useEffect(() => {
    const back = () => setBranch(branchFromPath() ?? "main");
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);

  const loadBranches = useCallback(() => void api.branches().then(setBranches), []);
  const loadCurrent = useCallback(() => void api.currentTask(branch).then(setCurrent, () => setCurrent(null)), [branch]);
  useEffect(loadBranches, [loadBranches]);
  useEffect(() => {
    setCurrent(undefined);
    loadCurrent();
  }, [loadCurrent]);

  // The current task's session, opened when there is one.
  useEffect(() => {
    if (!current) return setSession(null);
    let s: TaskSession | null = null;
    let gone = false;
    void TaskSession.open(api, current.id).then((x) => {
      if (gone) return x.close();
      s = x;
      setSession(x);
    });
    return () => {
      gone = true;
      s?.close();
    };
  }, [current?.id]);

  // Events: tasks moving on, heads moving, branches made and discarded.
  useEffect(
    () =>
      listen({
        message: (m) => {
          if (m.type === "task" && m.task.branch === branch) {
            session?.heard(m.task);
            if (m.task.owner === me.login && (m.change === "switched" || m.change === "created")) loadCurrent();
          }
          if (m.type === "branch") loadBranches();
        },
        reconnected: () => {
          loadBranches();
          void session?.reload();
        },
        signedOut,
      }),
    [branch, session, me.login, loadBranches, loadCurrent, signedOut],
  );

  const signOut = async () => {
    await api.signOut();
    signedOut();
  };

  return (
    <div className="app">
      <header className="top">
        <span className="brand">Sapwood</span>
        <label className="branch">
          <span className="muted">Branch</span>
          <select value={branch} onChange={(e) => go(e.target.value)}>
            {(branches.some((b) => b.name === branch) ? branches : [...branches, { name: branch } as BranchInfo]).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <span className="muted">
          {me.login} · {me.role}
        </span>
        <button className="button quiet" onClick={signOut}>
          Sign out
        </button>
      </header>
      <TaskBar branch={branch} me={me} current={current} session={session} started={setCurrent} />
      <main className="body">{session ? <Contents session={session} /> : <p className="muted">{current === undefined ? "Loading…" : "Nothing to show until you start a task."}</p>}</main>
    </div>
  );
}

/** Re-render on every change to the session. */
function useSession(s: TaskSession): { tick: number } {
  const [store] = useState(() => {
    let tick = 0;
    return {
      subscribe: (fn: () => void) => s.subscribe(() => (tick++, fn())),
      get: () => tick,
    };
  });
  return { tick: useSyncExternalStore(store.subscribe, store.get) };
}

function TaskBar({ branch, me, current, session, started }: { branch: string; me: Me; current: TaskInfo | null | undefined; session: TaskSession | null; started(t: TaskInfo): void }) {
  const canEdit = me.role !== "viewer" && me.scopes.readOnly !== true;
  if (current === undefined) return <div className="taskbar" />;
  if (current === null || !session)
    return (
      <div className="taskbar">
        <span className="muted">{current === null ? `You have no task on ${branch}.` : "Opening your task…"}</span>
        {current === null && canEdit && (
          <button className="button" onClick={() => void api.newTask(branch).then(started)}>
            Start a task
          </button>
        )}
      </div>
    );
  return <OpenTask session={session} started={started} />;
}

function OpenTask({ session: s, started }: { session: TaskSession; started(t: TaskInfo | null): void }) {
  const { tick } = useSession(s);
  const v = useMemo(() => validate(s.project), [s, tick]);
  const t = s.task;
  const [landing, setLanding] = useState(false);
  const land = async () => {
    setLanding(true);
    try {
      await s.settled();
      const r = await api.land(t.id);
      started(r.carried?.task ?? null);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLanding(false);
    }
  };
  return (
    <div className="taskbar">
      <span className="task-name">{t.name ?? `Task ${t.id}`}</span>
      <span className="muted">
        {t.changes} {t.changes === 1 ? "change" : "changes"}
      </span>
      <span className={v.errors > 0 ? "badge error" : v.warnings > 0 ? "badge warn" : "badge ok"}>
        {v.errors > 0 ? `${v.errors} ${v.errors === 1 ? "error" : "errors"}` : v.warnings > 0 ? `${v.warnings} ${v.warnings === 1 ? "warning" : "warnings"}` : "Valid"}
      </span>
      {s.state.unsent > 0 && <span className="muted">Saving…</span>}
      <span className="spacer" />
      <button className="button quiet" disabled={!t.canUndo || !s.editable} onClick={() => void s.undo()}>
        Undo
      </button>
      <button className="button quiet" disabled={!t.canRedo || !s.editable} onClick={() => void s.redo()}>
        Redo
      </button>
      <button className="button primary" disabled={landing || !s.editable || t.changes === 0 || v.errors > 0} onClick={land}>
        Land
      </button>
      {s.notice && (
        <p className="notice" role="status">
          {s.notice}
        </p>
      )}
    </div>
  );
}

/** For now, what the task's project holds; the pack tree and the grid come next. */
function Contents({ session: s }: { session: TaskSession }) {
  useSession(s);
  const doc = s.project.doc;
  return (
    <ul className="sheets">
      {[...doc.sheets.values()].map((sh) => (
        <li key={sh.id}>
          <strong>{sh.name}</strong> <span className="muted">
            {doc.packs.get(sh.pack)?.name ?? sh.pack} · {sh.kind} · {sh.rows.order.length - sh.rows.dead.size} rows
          </span>
        </li>
      ))}
    </ul>
  );
}
