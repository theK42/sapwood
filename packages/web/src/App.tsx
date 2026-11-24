// The app's frame: signing in, then the workspace for one branch, with your current task.
// The branch is in the address (/branches/<name>), so a link or a reload keeps it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Op, PackId, Project } from "@thek42/sapwood-core";
import { Api, ApiError, type BranchInfo, type CommitInfo, type Health, type Me, type TaskInfo } from "./api.ts";
import { listen } from "./events.ts";
import { HeadView } from "./head.ts";
import { ChangesPage, CommitPage, HistoryPage } from "./History.tsx";
import { routeFromPath, routePath, type Route } from "./routes.ts";
import { IssuePanel } from "./IssuePanel.tsx";
import { refList } from "./refs.ts";
import { RefsPanel } from "./RefsPanel.tsx";
import { ValuePanel, type PanelCell } from "./ValuePanel.tsx";
import { FormPanel, NewEntityPanel, type FormRow } from "./FormPanel.tsx";
import { EntitiesPage } from "./EntitiesPage.tsx";
import { MovePanel } from "./MovePanel.tsx";
import { SuggestPanel } from "./SuggestPanel.tsx";
import { entityAt } from "./form.ts";
import { TypeView } from "./TypeView.tsx";
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

/** What's beside the page: the issues, the references to an ID, or a cell's value as a form. */
type Side =
  | { kind: "issues" }
  | { kind: "refs"; id: string }
  | { kind: "value"; at: PanelCell }
  | { kind: "form"; at: FormRow }
  | { kind: "new"; type: string | null; pack: PackId | null; n: number }
  | { kind: "move"; ids: string[]; n: number; pack?: string }
  | { kind: "suggest"; pack: string | null }
  | null;

function Workspace({ me, signedOut }: { me: Me; signedOut(): void }) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branch, setBranch] = useState<string>(branchFromPath() ?? "main");
  const [current, setCurrent] = useState<TaskInfo | null | undefined>(undefined);
  const [session, setSession] = useState<TaskSession | null>(null);
  const [head, setHead] = useState<HeadView | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [headTick, setHeadTick] = useState(0);
  const [route, setRoute] = useState<Route>(routeFromPath());
  const sheet = route.kind === "sheet" ? route.id : null;
  const [side, setSide] = useState<Side>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jump, setJump] = useState<{ sheet: string; row: number; col: number | null; n: number } | null>(null);
  const starting = useRef<Promise<TaskSession> | null>(null);
  const canEdit = me.role !== "viewer" && me.scopes.readOnly !== true;

  const go = (b: string, r: Route = { kind: "home" }) => {
    history.pushState(null, "", routePath(b, r));
    setBranch(b);
    setRoute(r);
    setJump(null); // a sheet opened another way starts where it starts
    scrollTo(0, 0);
  };
  /** Another address for the page shown, without a new page in the history. */
  const show = (r: Route) => {
    history.replaceState(null, "", routePath(branch, r));
    setRoute(r);
  };
  useEffect(() => {
    const back = () => {
      setBranch(branchFromPath() ?? "main");
      setRoute(routeFromPath());
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

  /** Open a sheet at a cell (0-based; col null: the row). */
  const goTo = (sh: string, row: number, col: number | null) => {
    if (sh !== sheet) go(branch, { kind: "sheet", id: sh });
    setJump((j) => ({ sheet: sh, row, col, n: (j?.n ?? 0) + 1 }));
  };
  const findRefs = (id: string) => setSide({ kind: "refs", id });
  const openPanel = (at: PanelCell) => setSide({ kind: "value", at });
  const openForm = (at: FormRow) => setSide({ kind: "form", at });
  const moveEntities = (ids: string[]) => setSide((x) => ({ kind: "move", ids, n: (x?.kind === "move" ? x.n : 0) + 1 }));
  const newEntity = (type: string | null, pack: PackId | null) => setSide((x) => ({ kind: "new", type, pack, n: (x?.kind === "new" ? x.n : 0) + 1 }));
  /** While the panel or the form is open, it follows the selection to another cell or entity. */
  const selected = (at: PanelCell | null, panel: boolean) =>
    setSide((x) => {
      if (!at) return x;
      if (x?.kind === "value" && panel && (x.at.sheet !== at.sheet || x.at.row !== at.row || x.at.col !== at.col)) return { kind: "value", at };
      if (x?.kind === "form" && (x.at.sheet !== at.sheet || x.at.row !== at.row) && source && entityAt(source.project, at.sheet, at.row)) return { kind: "form", at: { sheet: at.sheet, row: at.row } };
      return x;
    });
  const goToDefinition = (id: string) => {
    if (!source) return;
    const defs = refList(source.project, id).filter((x) => x.kind === "definition");
    if (defs.length === 1) goTo(defs[0]!.sheet, defs[0]!.row, defs[0]!.col);
    else {
      findRefs(id); // none, or a duplicate: the panel says which
      if (defs.length === 0) setNotice(`No entity has the ID “${id}”.`);
    }
  };
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

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
        toggleIssues={() => setSide((x) => (x?.kind === "issues" ? null : { kind: "issues" }))}
        showChanges={(t) => go(branch, { kind: "changes", task: t })}
      />
      {notice && (
        <p className="toast" role="status">
          {notice}
        </p>
      )}
      <div className={side && source ? "work with-issues" : "work"}>
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
          showIssues={() => setSide({ kind: "issues" })}
          findRefs={findRefs}
          goToDefinition={goToDefinition}
          openType={(t) => go(branch, { kind: "type", name: t })}
          openPanel={openPanel}
          selected={selected}
          openForm={openForm}
          newEntity={newEntity}
          moveEntities={moveEntities}
        />
      ) : route.kind === "type" ? (
        <TypeView
          key={route.name}
          source={source}
          type={route.name}
          canEdit={canEdit && (session ? session.editable : true)}
          edit={edit}
          undo={() => void session?.undo()}
          redo={() => void session?.redo()}
          back={() => go(branch)}
          goTo={(h) => goTo(h.sheet, h.row, h.col)}
          findRefs={findRefs}
          goToDefinition={goToDefinition}
          showIssues={() => setSide({ kind: "issues" })}
          openPanel={openPanel}
          selected={selected}
          openForm={openForm}
          newEntity={newEntity}
          moveEntities={moveEntities}
        />
      ) : route.kind === "entities" ? (
        <EntitiesPage
          source={source}
          type={route.type}
          id={route.id}
          canEdit={canEdit && (session ? session.editable : true)}
          edit={edit}
          openType={(t) => go(branch, { kind: "entities", type: t, id: null })}
          showId={(t, id) => (t === route.type ? show : (r: Route) => go(branch, r))({ kind: "entities", type: t, id })}
          openGrid={(t) => go(branch, { kind: "type", name: t })}
          goTo={goTo}
          moveEntities={moveEntities}
        />
      ) : route.kind === "history" ? (
        <HistoryPage api={api} branch={branch} tick={headTick} open={(id) => go(branch, { kind: "commit", id })} href={(id) => routePath(branch, { kind: "commit", id })} back={() => go(branch)} />
      ) : route.kind === "commit" ? (
        <CommitPage
          key={route.id}
          api={api}
          branch={branch}
          id={route.id}
          canEdit={canEdit}
          back={() => go(branch, { kind: "history" })}
          made={(t) => {
            setCurrent(t);
            loadTasks();
            go(branch, { kind: "changes", task: t.id });
          }}
        />
      ) : route.kind === "changes" ? (
        <ChangesPage
          key={route.task}
          api={api}
          task={route.task}
          source={session && session.task.id === route.task ? session : null}
          mine={!!session && session.task.id === route.task}
          back={() => go(branch)}
          goTo={goTo}
        />
      ) : (
        <main className="body">
          <Home suggestMoves={(pack) => setSide({ kind: "suggest", pack })} source={source} atHead={source === head} commits={commits} others={others} canSheets={canEdit && (session ? session.editable : true)} canPacks={canEdit && (me.role === "developer" || me.role === "admin") && (session ? session.editable : true)} edit={edit} open={(id) => go(branch, { kind: "sheet", id })} href={(id) => routePath(branch, { kind: "sheet", id })} showIssues={() => setSide({ kind: "issues" })} openType={(t) => go(branch, { kind: "type", name: t })} typeHref={(t) => routePath(branch, { kind: "type", name: t })} go={(r) => go(branch, r)} routeHref={(r) => routePath(branch, r)} />
        </main>
      )}
      {side?.kind === "issues" && source && (
        <IssuePanel
          source={source}
          sheet={sheet}
          close={() => setSide(null)}
          jump={(x) => {
            if (x.sheet && x.row !== null) goTo(x.sheet.id, x.row, x.col);
          }}
        />
      )}
      {side?.kind === "value" && source && (
        <ValuePanel
          source={source}
          at={side.at}
          canEdit={canEdit && (session ? session.editable : true)}
          edit={edit}
          goTo={goTo}
          close={() => setSide(null)}
        />
      )}
      {side?.kind === "form" && source && (
        <FormPanel
          source={source}
          at={side.at}
          canEdit={canEdit && (session ? session.editable : true)}
          edit={edit}
          goTo={goTo}
          newEntity={newEntity}
          move={(id) => moveEntities([id])}
          close={() => setSide(null)}
        />
      )}
      {side?.kind === "move" && source && (
        <MovePanel key={side.n} source={source} ids={side.ids} pack={side.pack} canEdit={canEdit && (session ? session.editable : true)} edit={edit} close={() => setSide(null)} />
      )}
      {side?.kind === "suggest" && source && (
        <SuggestPanel
          key={side.pack ?? ""}
          source={source}
          pack={side.pack}
          canEdit={canEdit && (session ? session.editable : true)}
          edit={edit}
          review={(ids, pack) => setSide((x) => ({ kind: "move", ids, pack, n: (x?.kind === "move" ? x.n : 0) + 1 }))}
          close={() => setSide(null)}
        />
      )}
      {side?.kind === "new" && source && (
        <NewEntityPanel
          key={side.n}
          source={source}
          type={side.type}
          pack={side.pack}
          canEdit={canEdit && (session ? session.editable : true)}
          edit={edit}
          made={(at, row) => {
            setSide({ kind: "form", at });
            goTo(at.sheet, row, null);
          }}
          close={() => setSide(null)}
        />
      )}
      {side?.kind === "refs" && source && <RefsPanel key={side.id} source={source} id={side.id} close={() => setSide(null)} jump={(x) => goTo(x.sheet, x.row, x.col)} />}
      </div>
    </div>
  );
}
