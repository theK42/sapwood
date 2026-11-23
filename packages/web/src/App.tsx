// The app's frame: signing in, then the workspace for one branch, with your current task.
// The branch is in the address (/branches/<name>), so a link or a reload keeps it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Op, Project } from "@thek42/sapwood-core";
import { Api, ApiError, type BranchInfo, type CommitInfo, type Health, type Me, type TaskInfo } from "./api.ts";
import { listen } from "./events.ts";
import { HeadView } from "./head.ts";
import { IssuePanel } from "./IssuePanel.tsx";
import { Home } from "./Home.tsx";
import { TaskSession } from "./session.ts";
import { SheetView } from "./SheetView.tsx";
import { TaskBar } from "./TaskBar.tsx";

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

function sheetFromPath(): string | null {
  const m = /^\/branches\/[^/]+\/sheets\/([^/]+)/.exec(location.pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

function Workspace({ me, signedOut }: { me: Me; signedOut(): void }) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branch, setBranch] = useState<string>(branchFromPath() ?? "main");
  const [current, setCurrent] = useState<TaskInfo | null | undefined>(undefined);
  const [session, setSession] = useState<TaskSession | null>(null);
  const [head, setHead] = useState<HeadView | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [headTick, setHeadTick] = useState(0);
  const [sheet, setSheet] = useState<string | null>(sheetFromPath());
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [jump, setJump] = useState<{ sheet: string; row: number; col: number | null; n: number } | null>(null);
  const starting = useRef<Promise<TaskSession> | null>(null);
  const canEdit = me.role !== "viewer" && me.scopes.readOnly !== true;

  const go = (b: string, sh: string | null = null) => {
    history.pushState(null, "", `/branches/${encodeURIComponent(b)}${sh ? `/sheets/${encodeURIComponent(sh)}` : ""}`);
    setBranch(b);
    setSheet(sh);
    setJump(null); // a sheet opened another way starts where it starts
  };
  useEffect(() => {
    const back = () => {
      setBranch(branchFromPath() ?? "main");
      setSheet(sheetFromPath());
      setJump(null);
    };
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);

  const loadBranches = useCallback(() => void api.branches().then(setBranches, () => {}), []);
  const loadCurrent = useCallback(() => void api.currentTask(branch).then(setCurrent, () => setCurrent(null)), [branch]);
  const loadTasks = useCallback(() => void api.tasks(branch).then(setTasks, () => {}), [branch]);
  const loadCommits = useCallback(() => void api.commits(branch).then(setCommits, () => {}), [branch]);
  useEffect(loadBranches, [loadBranches]);
  useEffect(() => {
    setCurrent(undefined);
    setHead(null); // another branch's
    setTasks([]);
    setCommits([]);
    loadCurrent();
    loadTasks();
    loadCommits();
  }, [loadCurrent, loadTasks, loadCommits]);

  // Your current task's session, or the head when you have none.
  // One session per task, however many ask for it: an edit that starts a task and the
  // task's own "created" event can both get here first.
  const opening = useRef(new Map<number, Promise<TaskSession>>());
  const openSession = (id: number): Promise<TaskSession> => {
    let p = opening.current.get(id);
    if (!p) {
      p = TaskSession.open(api, id);
      opening.current.set(id, p);
      p.catch(() => opening.current.delete(id));
    }
    return p;
  };
  useEffect(() => {
    if (!current) return setSession(null);
    const id = current.id;
    let gone = false;
    openSession(id).then((x) => !gone && setSession(x), () => {});
    return () => {
      gone = true;
      const p = opening.current.get(id);
      opening.current.delete(id);
      void p?.then((x) => x.close(), () => {});
    };
  }, [current?.id]);
  // The head, while you have no task, and until your task's session is ready (so a sheet
  // stays open while the first edit starts a task).
  useEffect(() => {
    if (session) return setHead(null);
    if (current !== null) return;
    let gone = false;
    void HeadView.open(api, branch).then((h) => !gone && setHead(h), () => {});
    return () => void (gone = true);
  }, [session === null, current === null, branch]);

  // Events: tasks moving on, heads moving, branches made and discarded.
  useEffect(
    () =>
      listen({
        message: (m) => {
          if (m.type === "task" && m.task.branch === branch) {
            session?.heard(m.task);
            loadTasks();
            if (m.task.owner === me.login && ["switched", "created", "landed", "abandoned", "reopened"].includes(m.change)) loadCurrent();
          }
          if (m.type === "head" && m.branch === branch) {
            loadCommits();
            void head?.reload();
            setHeadTick((n) => n + 1);
          }
          if (m.type === "branch") loadBranches();
        },
        reconnected: () => {
          loadBranches();
          loadCurrent();
          loadTasks();
          loadCommits();
          void session?.reload();
          void head?.reload();
        },
        signedOut,
      }),
    [branch, session, head, me.login, loadBranches, loadCurrent, loadTasks, loadCommits, signedOut],
  );

  /** Your task's session, starting a task if you have none: your first edit starts one (§8.3). */
  const ensureSession = (): Promise<TaskSession> => {
    if (session) return Promise.resolve(session);
    starting.current ??= (async () => {
      try {
        const t = await api.newTask(branch);
        setCurrent(t);
        loadTasks();
        return await openSession(t.id);
      } finally {
        starting.current = null;
      }
    })();
    return starting.current;
  };
  const edit = (fn: (p: Project) => { ops: Op[] }) => {
    if (session) return void session.edit(fn);
    void ensureSession().then((s) => s.edit(fn), (e: unknown) => alert((e as Error).message));
  };

  const signOut = async () => {
    await api.signOut();
    signedOut();
  };
  const mine = tasks.filter((t) => t.owner === me.login);
  const others = tasks.filter((t) => t.owner !== me.login);
  const source = session ?? head;

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
      <TaskBar
        api={api}
        branch={branch}
        me={me}
        current={current}
        session={session}
        mine={mine}
        headTick={headTick}
        setCurrent={(t) => {
          setCurrent(t);
          loadTasks();
        }}
        toggleIssues={() => setIssuesOpen((x) => !x)}
      />
      <div className={issuesOpen && source ? "work with-issues" : "work"}>
      {!source ? (
        <main className="body">
          <p className="muted">Loading…</p>
        </main>
      ) : sheet ? (
        <SheetView
          key={sheet}
          source={source}
          sheet={sheet}
          canEdit={canEdit && (session ? session.editable : true)}
          edit={edit}
          undo={() => void session?.undo()}
          redo={() => void session?.redo()}
          back={() => go(branch)}
          jump={jump?.sheet === sheet ? jump : null}
          showIssues={() => setIssuesOpen(true)}
        />
      ) : (
        <main className="body">
          <Home source={source} atHead={source === head} commits={commits} others={others} open={(id) => go(branch, id)} href={(id) => `/branches/${encodeURIComponent(branch)}/sheets/${encodeURIComponent(id)}`} showIssues={() => setIssuesOpen(true)} />
        </main>
      )}
      {issuesOpen && source && (
        <IssuePanel
          source={source}
          sheet={sheet}
          close={() => setIssuesOpen(false)}
          jump={(x) => {
            if (!x.sheet || x.row === null) return;
            if (x.sheet.id !== sheet) go(branch, x.sheet.id);
            setJump((j) => ({ sheet: x.sheet!.id, row: x.row!, col: x.col, n: (j?.n ?? 0) + 1 }));
          }}
        />
      )}
      </div>
    </div>
  );
}
