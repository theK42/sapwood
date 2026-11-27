// The admin page (an Admin's): people and their roles, everyone's tokens, the branches
// (discarded ones too) and the audit log. And "Your tokens", for everyone: tokens for the CLI
// or an LLM's MCP server, made with limits (DESIGN §11.3), shown once, revoked here.
//
// Every change is the server's to allow: what it refuses (the last Admin, yourself) is shown.

import { useEffect, useState, type ReactNode } from "react";
import { ago, auditSaid, ROLE_LABEL, ROLE_SAYS, ROLES, scopesFrom, scopesSaid, tokenState } from "./admin.ts";
import { ApiError, type AccessRequest, type Api, type AuditEntry, type BranchInfo, type Me, type Role, type TokenInfo, type User } from "./api.ts";
import { plural } from "./hooks.ts";
import type { AdminSection } from "./routes.ts";

const SECTIONS: { id: AdminSection; label: string }[] = [
  { id: "people", label: "People" },
  { id: "tokens", label: "Tokens" },
  { id: "branches", label: "Branches" },
  { id: "activity", label: "Activity" },
];

/** Load something, with a way to load it again and the error if it fails. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; again(): void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (d) => live && (setData(d), setError(null)),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [...deps, n]);
  return { data, error, again: () => setN((x) => x + 1) };
}

/** Run a change; its refusal, if any, is shown; then reload. */
function useAct(again: () => void): { busy: boolean; refused: string | null; act(fn: () => Promise<unknown>): Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  return {
    busy,
    refused,
    act: async (fn) => {
      setBusy(true);
      try {
        await fn();
        setRefused(null);
        return true;
      } catch (e) {
        setRefused(e instanceof ApiError || e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
        again();
      }
    },
  };
}

// ------------------------------------------------------------ the admin page

interface AdminProps {
  api: Api;
  me: Me;
  branch: string;
  section: AdminSection;
  /** People were added or requests dismissed: the tab's count changes. */
  changed?: () => void;
  go(section: AdminSection): void;
  href(section: AdminSection): string;
  back(): void;
}

export function AdminPage(p: AdminProps) {
  return (
    <main className="body admin">
      <div className="page-head">
        <button className="button quiet" onClick={p.back} title="Back to the packs">
          ←
        </button>
        <h1>Admin</h1>
        <nav className="tabs-sub" aria-label="Admin">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={p.href(s.id)}
              className={s.id === p.section ? "on" : ""}
              aria-current={s.id === p.section ? "page" : undefined}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                p.go(s.id);
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
      </div>
      {p.me.role !== "admin" ? (
        <p className="muted">This page is an Admin's.</p>
      ) : p.section === "people" ? (
        <People api={p.api} me={p.me} {...(p.changed ? { changed: p.changed } : {})} />
      ) : p.section === "tokens" ? (
        <AllTokens api={p.api} me={p.me} />
      ) : p.section === "branches" ? (
        <Branches api={p.api} />
      ) : (
        <Activity api={p.api} />
      )}
    </main>
  );
}

function People(p: { api: Api; me: Me; changed?: () => void }) {
  const users = useLoad(() => p.api.users(), []);
  const tokens = useLoad(() => p.api.tokens(true), []);
  const requests = useLoad(() => p.api.accessRequests(), []);
  const { busy, refused, act } = useAct(() => (users.again(), tokens.again(), requests.again(), p.changed?.()));
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const live = (u: string) => (tokens.data ?? []).filter((t) => t.user === u && tokenState(t) === "live").length;
  return (
    <>
      {(requests.data ?? []).length > 0 && (
        <section className="panel admin-asking">
          <h2>Asking for access</h2>
          <p className="muted small">They signed in with GitHub but aren't users here yet. Add them with a role, or turn them down (they can ask again).</p>
          <ul className="log">
            {requests.data!.map((r: AccessRequest) => (
              <AskingRow key={r.login} r={r} busy={busy} add={(role) => void act(() => p.api.addUser(r.login, role))} dismiss={() => void act(() => p.api.dismissRequest(r.login))} />
            ))}
          </ul>
        </section>
      )}
      <section className="panel">
        <h2>Add someone</h2>
        <form
          className="admin-add"
          onSubmit={(e) => {
            e.preventDefault();
            const l = login.trim();
            if (l) void act(() => p.api.addUser(l, role)).then((ok) => ok && setLogin(""));
          }}
        >
          <input className="vf-input" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Their GitHub login" aria-label="GitHub login" spellCheck={false} />
          <RolePicker value={role} set={setRole} label="Their role" />
          <button className="button" disabled={busy || !login.trim()}>
            Add
          </button>
        </form>
        <p className="muted small">They sign in with that GitHub account; until they're added, sign-in refuses them.</p>
      </section>
      {refused && <p className="vf-bad" role="alert">{refused}</p>}
      <section className="panel">
        <h2>People {users.data && <span className="muted small">{users.data.length}</span>}</h2>
        {users.error ? (
          <p className="vf-bad">{users.error}</p>
        ) : !users.data ? (
          <p className="muted">Loading…</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Login</th>
                <th>Role</th>
                <th>Added</th>
                <th>Live tokens</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data.map((u: User) => (
                <tr key={u.login}>
                  <td>
                    <code>{u.login}</code>
                    {u.login === p.me.login && <span className="tag">you</span>}
                  </td>
                  <td>
                    <RolePicker value={u.role} set={(r) => r !== u.role && void act(() => p.api.setRole(u.login, r))} label={`${u.login}'s role`} disabled={busy} />
                  </td>
                  <td className="muted small">{ago(u.createdAt)}</td>
                  <td className="small">{tokens.data ? live(u.login) : ""}</td>
                  <td className="admin-actions">
                    {u.login !== p.me.login && (
                      <button
                        className="button quiet small danger"
                        disabled={busy}
                        onClick={() => confirm(`Remove ${u.login}? Their tokens stop working and they can't sign in. What they did stays.`) && void act(() => p.api.removeUser(u.login))}
                      >
                        Remove…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function AskingRow(p: { r: AccessRequest; busy: boolean; add(role: Role): void; dismiss(): void }) {
  const [role, setRole] = useState<Role>("editor");
  return (
    <li>
      <code>{p.r.login}</code>
      <span className="muted small">
        asked {ago(p.r.lastAt)}
        {p.r.tries > 1 ? `, ${p.r.tries} times` : ""}
      </span>
      <span className="spacer" />
      <RolePicker value={role} set={setRole} label={`${p.r.login}'s role`} disabled={p.busy} />
      <button className="button small" disabled={p.busy} onClick={() => p.add(role)}>
        Add
      </button>
      <button className="button quiet small" disabled={p.busy} onClick={p.dismiss}>
        Dismiss
      </button>
    </li>
  );
}

function RolePicker(p: { value: Role; set(r: Role): void; label: string; disabled?: boolean; options?: Role[] }) {
  return (
    <select value={p.value} onChange={(e) => p.set(e.target.value as Role)} aria-label={p.label} disabled={p.disabled} title={ROLE_SAYS[p.value]}>
      {(p.options ?? ROLES).map((r) => (
        <option key={r} value={r} title={ROLE_SAYS[r]}>
          {ROLE_LABEL[r]}
        </option>
      ))}
    </select>
  );
}

function AllTokens(p: { api: Api; me: Me }) {
  const tokens = useLoad(() => p.api.tokens(true), []);
  const { busy, refused, act } = useAct(tokens.again);
  const [dead, setDead] = useState(false);
  const shown = (tokens.data ?? []).filter((t) => dead || tokenState(t) === "live");
  const hidden = (tokens.data ?? []).length - shown.length;
  return (
    <section className="panel">
      <h2>
        Everyone's tokens
        <label className="small admin-toggle">
          <input type="checkbox" checked={dead} onChange={(e) => setDead(e.target.checked)} /> Revoked and expired too{hidden && !dead ? ` (${hidden})` : ""}
        </label>
      </h2>
      {refused && <p className="vf-bad" role="alert">{refused}</p>}
      {tokens.error ? <p className="vf-bad">{tokens.error}</p> : !tokens.data ? <p className="muted">Loading…</p> : <TokenTable tokens={shown} me={p.me} showUser busy={busy} revoke={(t) => act(() => p.api.revokeToken(t.id))} />}
    </section>
  );
}

function TokenTable(p: { tokens: TokenInfo[]; me: Me; showUser?: boolean; busy: boolean; revoke(t: TokenInfo): void }) {
  if (!p.tokens.length) return <p className="muted small">None.</p>;
  return (
    <table className="admin-table">
      <thead>
        <tr>
          {p.showUser && <th>Whose</th>}
          <th>Name</th>
          <th>May</th>
          <th>Made</th>
          <th>Last used</th>
          <th>Expires</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {p.tokens.map((t) => {
          const state = tokenState(t);
          const mine = t.id === p.me.token;
          return (
            <tr key={t.id} className={state === "live" ? "" : "muted"}>
              {p.showUser && (
                <td>
                  <code>{t.user}</code>
                </td>
              )}
              <td>
                {t.name}
                {mine && <span className="tag" title="The token this page signed in with">this sign-in</span>}
              </td>
              <td className="small">{scopesSaid(t.scopes)}</td>
              <td className="muted small">{ago(t.createdAt)}</td>
              <td className="small">{ago(t.lastUsed)}</td>
              <td className="muted small">{t.expires ? t.expires.slice(0, 10) : "never"}</td>
              <td className="admin-actions">
                {state === "live" ? (
                  <button
                    className="button quiet small danger"
                    disabled={p.busy}
                    onClick={() => confirm(mine ? "Revoke the token this page signed in with? You'll be signed out." : `Revoke “${t.name}”${p.showUser ? ` (${t.user}'s)` : ""}? Whatever uses it stops working.`) && p.revoke(t)}
                  >
                    Revoke…
                  </button>
                ) : (
                  <span className="muted small">{state}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Branches(p: { api: Api }) {
  const branches = useLoad(() => p.api.branches(true), []);
  const { busy, refused, act } = useAct(branches.again);
  const list = branches.data ?? [];
  return (
    <section className="panel">
      <h2>Branches</h2>
      {refused && <p className="vf-bad" role="alert">{refused}</p>}
      {branches.error ? (
        <p className="vf-bad">{branches.error}</p>
      ) : !branches.data ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Branch</th>
              <th>From</th>
              <th>Made</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((b: BranchInfo) => (
              <tr key={b.name} className={b.archived ? "muted" : ""}>
                <td>
                  <code>{b.name}</code>
                  {b.archived && <span className="tag">discarded</span>}
                </td>
                <td className="small">{b.parent ?? "—"}</td>
                <td className="muted small">
                  {b.createdBy}, {ago(b.createdAt)}
                </td>
                <td className="admin-actions">
                  {b.name === "main" ? null : b.archived ? (
                    <button className="button quiet small" disabled={busy} onClick={() => void act(() => p.api.undiscardBranch(b.name))}>
                      Bring back
                    </button>
                  ) : (
                    <button className="button quiet small danger" disabled={busy} onClick={() => confirm(`Discard the branch ${b.name}? It's kept, and can be brought back here.`) && void act(() => p.api.discardBranch(b.name))}>
                      Discard…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const PAGE = 50;

function Activity(p: { api: Api }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async (before?: number) => {
    try {
      const got = await p.api.auditLog(PAGE, before);
      setEntries((x) => (before === undefined ? got : [...x, ...got]));
      setMore(got.length === PAGE);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(), []);
  return (
    <section className="panel">
      <h2>Activity</h2>
      <p className="muted small">Sign-ins, people, roles, tokens and branches. Changes to the data are in each branch's history.</p>
      {error && <p className="vf-bad">{error}</p>}
      <ul className="log">
        {entries.map((e) => (
          <li key={e.id}>
            <code>{e.actor}</code>
            <span>{auditSaid(e)}</span>
            <span className="muted small" title={e.at}>
              {ago(e.at)}
            </span>
          </li>
        ))}
      </ul>
      {more && entries.length > 0 && (
        <button className="button quiet small" onClick={() => void load(entries.at(-1)!.id)}>
          Older
        </button>
      )}
    </section>
  );
}

// ------------------------------------------------------------ your tokens

interface AccountProps {
  api: Api;
  me: Me;
  back(): void;
  /** The page's address, for the commands shown with a new token. */
  origin: string;
}

export function AccountPage(p: AccountProps) {
  const tokens = useLoad(() => p.api.tokens(), []);
  const branches = useLoad(() => p.api.branches(), []);
  const { busy, refused, act } = useAct(tokens.again);
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [dead, setDead] = useState(false);
  const shown = (tokens.data ?? []).filter((t) => dead || tokenState(t) === "live");
  const canWrite = !p.me.scopes.readOnly;
  return (
    <main className="body admin">
      <div className="page-head">
        <button className="button quiet" onClick={p.back} title="Back to the packs">
          ←
        </button>
        <h1>Your tokens</h1>
        <span className="muted">
          {p.me.login} · {ROLE_LABEL[p.me.role]}
        </span>
      </div>
      <p className="muted small">
        A token lets the <code>sapwood</code> command, a script, or an LLM's MCP server act as you, with the limits you give it. It's shown once, when it's made.
      </p>
      {made && (
        <section className="panel admin-made" role="status">
          <h2>“{made.name}” is made</h2>
          <p className="small">Copy it now: it isn't shown again.</p>
          <div className="admin-token">
            <code>{made.token}</code>
            <button
              className="button small"
              onClick={() => {
                void navigator.clipboard?.writeText(made.token).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="muted small">
            To use it from the command line: <code>sapwood login --server {p.origin} --token &lt;the token&gt;</code>
          </p>
          <button className="button quiet small" onClick={() => (setMade(null), setCopied(false))}>
            Done
          </button>
        </section>
      )}
      {canWrite && !made && (
        <NewToken
          me={p.me}
          branches={(branches.data ?? []).map((b) => b.name)}
          busy={busy}
          make={(name, scopes, expires) =>
            void act(async () => {
              const r = await p.api.makeToken(name, scopes, expires);
              setMade({ token: r.token, name });
            })
          }
        />
      )}
      {refused && <p className="vf-bad" role="alert">{refused}</p>}
      <section className="panel">
        <h2>
          Your tokens
          <label className="small admin-toggle">
            <input type="checkbox" checked={dead} onChange={(e) => setDead(e.target.checked)} /> Revoked and expired too
          </label>
        </h2>
        {tokens.error ? <p className="vf-bad">{tokens.error}</p> : !tokens.data ? <p className="muted">Loading…</p> : <TokenTable tokens={shown} me={p.me} busy={busy} revoke={(t) => act(() => p.api.revokeToken(t.id))} />}
        <p className="muted small">Each web sign-in is a token too (“Web sign-in”); revoking one signs that browser out.</p>
      </section>
    </main>
  );
}

function NewToken(p: { me: Me; branches: string[]; busy: boolean; make(name: string, scopes: ReturnType<typeof scopesFrom>, expires: string | null): void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(p.me.role);
  const [readOnly, setReadOnly] = useState(false);
  const [noLand, setNoLand] = useState(false);
  const [only, setOnly] = useState<string[]>([]);
  const [expires, setExpires] = useState("");
  const roles = ROLES.slice(0, ROLES.indexOf(p.me.role) + 1);
  const row = (label: string, control: ReactNode, hint?: string) => (
    <label className="vf-row">
      <span className="vf-name">{label}</span>
      {control}
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
  return (
    <section className="panel">
      <h2>Make a token</h2>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          p.make(name.trim(), scopesFrom({ role, readOnly, noLand, branches: only }, p.me.role), expires ? new Date(`${expires}T23:59:59`).toISOString() : null);
          setName("");
        }}
      >
        {row("Name", <input className="vf-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="What it's for: laptop, CI, Claude" required />)}
        {row("Role", <RolePicker value={role} set={setRole} label="At most this role" options={roles} />, role === p.me.role ? "yours" : `at most ${ROLE_LABEL[role]}`)}
        {row("Read-only", <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />, "reads, never writes")}
        {!readOnly && row("Can't land", <input type="checkbox" checked={noLand} onChange={(e) => setNoLand(e.target.checked)} />, "edits in tasks, but a person lands them: good for an LLM")}
        {row(
          "Branches",
          <select multiple value={only} onChange={(e) => setOnly([...e.target.selectedOptions].map((o) => o.value))} aria-label="Only these branches" size={Math.min(4, Math.max(2, p.branches.length))}>
            {p.branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>,
          only.length ? `${plural(only.length, "branch", "branches")} only` : "all of them (pick some to limit it)",
        )}
        {row("Expires", <input type="date" className="vf-input" value={expires} onChange={(e) => setExpires(e.target.value)} />, expires ? "" : "never")}
        <div className="vf-buttons">
          <button className="button" disabled={p.busy || !name.trim()}>
            Make the token
          </button>
        </div>
      </form>
    </section>
  );
}
