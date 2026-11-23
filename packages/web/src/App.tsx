// The app's frame: signing in, then the workspace for one branch, with your current task.
// The branch is in the address (/branches/<name>), so a link or a reload keeps it.

import { useCallback, useEffect, useState } from "react";
import { Api, ApiError, type BranchInfo, type CommitInfo, type Health, type Me, type TaskInfo } from "./api.ts";
import { listen } from "./events.ts";
import { HeadView } from "./head.ts";
import { Home } from "./Home.tsx";
import { TaskSession } from "./session.ts";
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

function Workspace({ me, signedOut }: { me: Me; signedOut(): void }) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branch, setBranch] = useState<string>(branchFromPath() ?? "main");
  const [current, setCurrent] = useState<TaskInfo | null | undefined>(undefined);
  const [session, setSession] = useState<TaskSession | null>(null);
  const [head, setHead] = useState<HeadView | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [headTick, setHeadTick] = useState(0);

  const go = (b: string) => {
    history.pushState(null, "", `/branches/${encodeURIComponent(b)}`);
    setBranch(b);
  };
  useEffect(() => {
    const back = () => setBranch(branchFromPath() ?? "main");
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
    setTasks([]);
    setCommits([]);
    loadCurrent();
    loadTasks();
    loadCommits();
  }, [loadCurrent, loadTasks, loadCommits]);

  // Your current task's session, or the head when you have none.
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
  useEffect(() => {
    if (current !== null) return setHead(null);
    let gone = false;
    void HeadView.open(api, branch).then((h) => !gone && setHead(h), () => {});
    return () => void (gone = true);
  }, [current === null, branch]);

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
      />
      <main className="body">{source ? <Home source={source} atHead={source === head} commits={commits} others={others} /> : <p className="muted">Loading…</p>}</main>
    </div>
  );
}
