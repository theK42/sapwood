// The HTTP API (DESIGN §9.4): the Sapwood API's reads and writes as REST/JSON, plus
// branches, tasks and landing. Every request carries a bearer token (§11.3).
//
// Reads work at three places: a branch head (/api/branches/:b/…), a task's state
// (/api/tasks/:t/…) and any commit (/api/commits/:c/…). Writes only go into a task: one
// named in the path, or the caller's current task on a branch, made on first edit (§8.3).
// Branch names with a slash are URL-encoded in paths.

import { Hono, type Context } from "hono";
import {
  ApiError, ExportRefused, Sapwood, sha256, whereFilter,
  type ApiErrorCode, type ExportFile, type JsonValue, type Patch, type QueryOptions,
} from "@thek42/sapwood-core";
import { demand, isRole, type Auth, type Principal, type Role, type Scopes } from "./auth.ts";
import { RepoError, type Repo, type Resolutions, type TaskState } from "./repo.ts";

type Env = { Variables: { me: Principal } };
type C = Context<Env>;

interface Place {
  s: Sapwood;
  branch: string;
  files(allowInvalid: boolean): ExportFile[];
}

const API_STATUS: Record<ApiErrorCode, number> = {
  "not-found": 404,
  ambiguous: 409,
  exists: 409,
  "unknown-type": 400,
  singleton: 400,
  "unknown-field": 400,
  "no-column": 409,
  formula: 409,
  "bad-value": 400,
  "no-sheet": 409,
  "bad-schema": 400,
  confirm: 409,
};

const REPO_STATUS = { "not-found": 404, exists: 409, conflict: 409, invalid: 422, state: 409, "bad-request": 400, forbidden: 403 } as const;

export function createApp(repo: Repo, auth: Auth): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((e, c) => {
    if (e instanceof ApiError) return c.json({ error: { code: e.code, message: e.message } }, API_STATUS[e.code] as 400);
    if (e instanceof RepoError) return c.json({ error: { code: e.code, message: e.message, ...(e.detail as object | undefined) } }, REPO_STATUS[e.code] as 400);
    if (e instanceof ExportRefused) return c.json({ error: { code: "invalid", message: e.message, errors: e.validation.errors, warnings: e.validation.warnings } }, 422);
    console.error(e);
    return c.json({ error: { code: "internal", message: "Something went wrong on the server" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not-found", message: `No route ${c.req.method} ${c.req.path}` } }, 404));

  app.get("/healthz", (c) => c.json({ ok: true, initialized: repo.initialized }));

  app.use("/api/*", async (c, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    const me = m ? auth.authenticate(m[1]!) : null;
    if (!me) {
      c.header("WWW-Authenticate", 'Bearer realm="sapwood"');
      return c.json({ error: { code: "unauthenticated", message: "Pass a Sapwood token: Authorization: Bearer swd_…" } }, 401);
    }
    c.set("me", me);
    await next();
  });

  const me = (c: C) => c.get("me");
  const may = (c: C, need: Role, action: "read" | "write" | "land", branch: string) => demand(me(c), need, action, branch);

  // ------------------------------------------------------------ who, users, tokens

  app.get("/api/me", (c) => c.json({ login: me(c).login, role: me(c).role, scopes: me(c).scopes }));

  app.get("/api/users", (c) => {
    demand(me(c), "admin");
    return c.json(auth.users());
  });
  app.post("/api/users", async (c) => {
    demand(me(c), "admin", "write");
    const b = await body(c);
    return c.json(auth.addUser(str(b.login, "login"), role(b.role), me(c).login), 201);
  });
  app.patch("/api/users/:login", async (c) => {
    demand(me(c), "admin", "write");
    const b = await body(c);
    return c.json(auth.setRole(c.req.param("login"), role(b.role), me(c).login));
  });

  app.get("/api/tokens", (c) => c.json(auth.tokens(me(c).login)));
  /** A new token for yourself, at most as able as the token asking for it. */
  app.post("/api/tokens", async (c) => {
    const p = me(c);
    demand(p, "viewer", "write");
    const b = await body(c);
    const asked = (b.scopes ?? {}) as Scopes;
    const scopes: Scopes = { ...p.scopes, ...asked };
    if (p.scopes.readOnly) scopes.readOnly = true;
    if (p.scopes.noLand) scopes.noLand = true;
    if (p.scopes.branches) scopes.branches = (asked.branches ?? p.scopes.branches).filter((x) => p.scopes.branches!.includes(x));
    if (p.scopes.role && (!asked.role || roleRank(asked.role) > roleRank(p.scopes.role))) scopes.role = p.scopes.role;
    const made = auth.createToken(p.login, { name: str(b.name, "name"), scopes, expires: (b.expires as string | undefined) ?? null }, p.login);
    return c.json(made, 201);
  });
  app.delete("/api/tokens/:id", (c) => {
    const p = me(c);
    const t = auth.token(Number(c.req.param("id")));
    if (t.user !== p.login) demand(p, "admin", "write");
    return c.json(auth.revokeToken(t.id, p.login));
  });

  // ------------------------------------------------------------ branches and commits

  app.get("/api/branches", (c) => {
    const p = me(c);
    return c.json(repo.branches(c.req.query("archived") === "1").filter((b) => !p.scopes.branches || p.scopes.branches.includes(b.name)));
  });
  app.post("/api/branches", async (c) => {
    const b = await body(c);
    const name = str(b.name, "name");
    const from = b.from === undefined ? "main" : str(b.from, "from");
    may(c, "editor", "write", name);
    may(c, "viewer", "read", from);
    return c.json(repo.createBranch(name, from, me(c).login), 201);
  });
  app.get("/api/branches/:b", (c) => {
    const b = c.req.param("b");
    may(c, "viewer", "read", b);
    return c.json(repo.branch(b));
  });
  app.delete("/api/branches/:b", (c) => {
    const b = c.req.param("b");
    may(c, "editor", "write", b);
    return c.json(repo.discardBranch(b));
  });
  /** How the branch stands against its parent: behind, ahead, and what a sync would conflict on. */
  app.get("/api/branches/:b/compare", (c) => {
    const b = c.req.param("b");
    may(c, "viewer", "read", b);
    return c.json(repo.compare(b));
  });
  /** Bring the parent's changes into the branch. Like a land, on the branch. */
  app.post("/api/branches/:b/sync", async (c) => {
    const b = c.req.param("b");
    may(c, "editor", "land", b);
    const parent = repo.branch(b).parent;
    if (parent !== null) may(c, "viewer", "read", parent);
    const body_ = await body(c, true);
    return c.json(repo.sync(b, me(c).login, { resolutions: resolutions(body_.resolutions) }));
  });
  /** Merge the branch into its parent (syncing it first if the parent moved on). Like a land, on the parent. */
  app.post("/api/branches/:b/merge", async (c) => {
    const b = c.req.param("b");
    const parent = repo.branch(b).parent;
    may(c, "editor", "land", b);
    if (parent !== null) may(c, "editor", "land", parent);
    const body_ = await body(c, true);
    const opts: Parameters<Repo["merge"]>[2] = { resolutions: resolutions(body_.resolutions) };
    if (body_.message !== undefined) opts.message = str(body_.message, "message");
    return c.json(repo.merge(b, me(c).login, opts), 201);
  });
  app.get("/api/branches/:b/commits", (c) => {
    const b = c.req.param("b");
    may(c, "viewer", "read", b);
    return c.json(repo.log(b, Math.min(Number(c.req.query("limit") ?? 50) || 50, 1000)));
  });
  app.get("/api/commits/:c", (c) => {
    const info = repo.commit(c.req.param("c"));
    may(c, "viewer", "read", info.branch);
    return c.json({ ...info, ops: repo.commitOps(info.id) });
  });
  /** Revert a commit: a new task, your current one, with the commit's inverse. On the commit's branch unless `branch` says. */
  app.post("/api/commits/:c/revert", async (c) => {
    const info = repo.commit(c.req.param("c"));
    may(c, "viewer", "read", info.branch);
    const b = await body(c, true);
    const branch = b.branch === undefined ? info.branch : str(b.branch, "branch");
    may(c, "editor", "write", branch);
    return c.json(repo.revert(info.id, me(c).login, { branch }), 201);
  });
  /** Restore the branch to an earlier commit on it: a new task, your current one, taking it back to that state. */
  app.post("/api/branches/:b/restore", async (c) => {
    const branch = c.req.param("b");
    may(c, "editor", "write", branch);
    const b = await body(c);
    return c.json(repo.restore(branch, str(b.commit, "commit"), me(c).login), 201);
  });

  // ------------------------------------------------------------ tasks

  app.get("/api/branches/:b/tasks", (c) => {
    const branch = c.req.param("b");
    may(c, "viewer", "read", branch);
    const state = c.req.query("state") as TaskState | undefined;
    const owner = c.req.query("owner");
    const filter: Parameters<Repo["tasks"]>[0] = { branch };
    if (state !== undefined) filter.state = state;
    if (owner !== undefined) filter.owner = owner.toLowerCase();
    return c.json(repo.tasks(filter));
  });
  app.post("/api/branches/:b/tasks", async (c) => {
    const branch = c.req.param("b");
    may(c, "editor", "write", branch);
    const b = await body(c);
    return c.json(repo.createTask(branch, me(c).login, b.name === undefined ? null : str(b.name, "name")), 201);
  });
  app.get("/api/branches/:b/tasks/current", (c) => {
    const branch = c.req.param("b");
    may(c, "viewer", "read", branch);
    repo.branch(branch);
    return c.json(repo.currentTask(branch, me(c).login, false));
  });

  const task = (c: C) => {
    const id = Number(c.req.param("t"));
    if (!Number.isInteger(id)) throw new RepoError("not-found", `No task ${c.req.param("t")}`);
    return repo.task(id);
  };

  app.get("/api/tasks/:t", (c) => {
    const t = task(c);
    may(c, "viewer", "read", t.branch);
    return c.json(repo.status(t.id));
  });
  app.get("/api/tasks/:t/ops", (c) => {
    const t = task(c);
    may(c, "viewer", "read", t.branch);
    return c.json(repo.taskOps(t.id));
  });
  app.patch("/api/tasks/:t", async (c) => {
    const t = task(c);
    may(c, "editor", "write", t.branch);
    const b = await body(c);
    return c.json(repo.renameTask(t.id, me(c).login, b.name === null ? null : str(b.name, "name")));
  });
  for (const verb of ["undo", "redo"] as const)
    app.post(`/api/tasks/:t/${verb}`, (c) => {
      const t = task(c);
      may(c, "editor", "write", t.branch);
      const done = repo[verb](t.id, me(c).login);
      return c.json({ done, task: repo.task(t.id) });
    });
  app.post("/api/tasks/:t/switch", (c) => {
    const t = task(c);
    may(c, "editor", "write", t.branch);
    return c.json(repo.switchTask(t.id, me(c).login));
  });
  app.post("/api/tasks/:t/abandon", (c) => {
    const t = task(c);
    may(c, "editor", "write", t.branch);
    return c.json(repo.abandon(t.id, me(c).login));
  });
  app.post("/api/tasks/:t/reopen", (c) => {
    const t = task(c);
    may(c, "editor", "write", t.branch);
    return c.json(repo.reopen(t.id, me(c).login));
  });
  app.post("/api/tasks/:t/rebase", async (c) => {
    const t = task(c);
    may(c, "editor", "write", t.branch);
    const b = await body(c, true);
    return c.json(repo.rebaseTask(t.id, me(c).login, resolutions(b.resolutions)));
  });
  /** Any Editor may land a task (§11.2: permissions were checked as its ops were written). */
  app.post("/api/tasks/:t/land", async (c) => {
    const t = task(c);
    may(c, "editor", "land", t.branch);
    const b = await body(c, true);
    const opts: Parameters<Repo["land"]>[2] = { resolutions: resolutions(b.resolutions) };
    if (b.message !== undefined) opts.message = str(b.message, "message");
    return c.json(repo.land(t.id, me(c).login, opts), 201);
  });

  // ------------------------------------------------------------ writes

  /** Patches (the patch-file lines of §9.4), all or nothing, as one change in the task. */
  const patches = async (c: C, id: number) => {
    const b = await body(c);
    const list = Array.isArray(b) ? b : b.patches;
    if (!Array.isArray(list)) throw new RepoError("bad-request", "Send a list of patches, or { patches: [...] }");
    const change = repo.write(id, me(c).login, (s) => s.apply(list as Patch[]));
    return c.json({ task: repo.task(id), ops: change.ops.length, formulas: change.formulas });
  };
  const schema = async (c: C, id: number) => {
    const b = await body(c);
    const change = repo.write(id, me(c).login, (s) => s.applySchema(str(b.yaml, "yaml"), { force: b.force === true }));
    return c.json({ task: repo.task(id), ops: change.ops.length, formulas: change.formulas, rules: change.rules, scratch: change.scratch, notes: change.notes });
  };

  app.post("/api/tasks/:t/patches", (c) => {
    const t = task(c);
    may(c, "editor", "write", t.branch);
    return patches(c, t.id);
  });
  app.post("/api/tasks/:t/schema", (c) => {
    const t = task(c);
    may(c, "developer", "write", t.branch);
    return schema(c, t.id);
  });
  app.post("/api/branches/:b/patches", (c) => {
    const b = c.req.param("b");
    may(c, "editor", "write", b);
    return patches(c, repo.currentTask(b, me(c).login)!.id);
  });
  app.post("/api/branches/:b/schema", (c) => {
    const b = c.req.param("b");
    may(c, "developer", "write", b);
    return schema(c, repo.currentTask(b, me(c).login)!.id);
  });

  // ------------------------------------------------------------ reads, at a head, a task or a commit

  reads(app, "/api/branches/:b", (c) => {
    const branch = c.req.param("b")!;
    may(c, "viewer", "read", branch);
    return { s: repo.head(branch), branch, files: (any) => repo.headExport(branch, any) };
  });
  reads(app, "/api/tasks/:t", (c) => {
    const t = task(c);
    may(c, "viewer", "read", t.branch);
    const s = repo.view(t.id);
    return { s, branch: t.branch, files: (any) => s.export({ branch: t.branch, allowInvalid: any }) };
  });
  reads(app, "/api/commits/:c", (c) => {
    const info = repo.commit(c.req.param("c")!);
    may(c, "viewer", "read", info.branch);
    const s = repo.at(info.id);
    return { s, branch: info.branch, files: (any) => s.export({ branch: info.branch, commit: info.id, allowInvalid: any }) };
  });

  return app;
}

function reads(app: Hono<Env>, prefix: string, place: (c: C) => Place): void {
  app.get(`${prefix}/entities/:id`, (c) => c.json(place(c).s.get(c.req.param("id")!)));
  app.get(`${prefix}/singletons/:type`, (c) => c.json(place(c).s.singleton(c.req.param("type")!)));
  /** `?where=damage>10&where=element=fire` (the CLI's --where syntax), `&pack=`, `&inactive=1`. */
  app.get(`${prefix}/query/:type`, (c) => {
    const conds = (c.req.queries("where") ?? []).map(whereFilter);
    const opts: QueryOptions = {};
    if (conds.length) opts.where = (e) => conds.every((f) => f(e));
    const pack = c.req.query("pack");
    if (pack !== undefined) opts.pack = pack;
    if (c.req.query("inactive") === "1") opts.inactive = true;
    return c.json(place(c).s.query(c.req.param("type")!, opts));
  });
  app.get(`${prefix}/schema`, (c) => c.body(place(c).s.schemaYaml(), 200, { "Content-Type": "application/yaml; charset=utf-8" }));
  app.get(`${prefix}/validate`, (c) => c.json(place(c).s.validate()));
  /** The export's files (§10), each with the ETag its download will carry. */
  app.get(`${prefix}/export`, (c) => {
    const files = place(c).files(c.req.query("allowInvalid") === "1");
    return c.json({ files: files.map((f) => ({ path: f.path, etag: etag(f), bytes: Buffer.byteLength(f.content) })) });
  });
  app.get(`${prefix}/export/:path{.+}`, (c) => {
    const path = c.req.param("path");
    const f = place(c)
      .files(c.req.query("allowInvalid") === "1")
      .find((x) => x.path === path);
    if (!f) throw new RepoError("not-found", `No exported file ${path}`);
    const tag = etag(f);
    const headers = { ETag: tag, "Cache-Control": "no-cache" };
    if (matches(c.req.header("if-none-match"), tag)) return c.body(null, 304, headers);
    return c.body(f.content, 200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  });
}

const etag = (f: ExportFile): string => `"${sha256(f.content)}"`;
const matches = (header: string | undefined, tag: string): boolean => header !== undefined && (header.trim() === "*" || header.split(",").some((t) => t.trim().replace(/^W\//, "") === tag));

const roleRank = (r: Role): number => ["viewer", "editor", "developer", "admin"].indexOf(r);

async function body(c: C, optional = false): Promise<Record<string, JsonValue> & { patches?: JsonValue }> {
  const text = await c.req.text();
  if (text.trim() === "") {
    if (optional) return {};
    throw new RepoError("bad-request", "Expected a JSON body");
  }
  try {
    return JSON.parse(text) as Record<string, JsonValue>;
  } catch {
    throw new RepoError("bad-request", "The body isn't JSON");
  }
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "") throw new RepoError("bad-request", `Expected ${name}, as text`);
  return v;
}

function role(v: unknown): Role {
  if (!isRole(v)) throw new RepoError("bad-request", "Expected role: viewer, editor, developer or admin");
  return v;
}

function resolutions(v: unknown): Resolutions {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.values(v).every((s) => s === "mine" || s === "theirs"))
    throw new RepoError("bad-request", 'Expected resolutions: { "<conflict id>": "mine" | "theirs" }');
  return v as Resolutions;
}
