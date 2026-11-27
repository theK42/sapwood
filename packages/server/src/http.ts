// The HTTP API (DESIGN §9.4): the Sapwood API's reads and writes as REST/JSON, plus
// branches, tasks and landing. Every /api request carries a bearer token (§11.3), or the
// session cookie a web sign-in sets; /auth has the GitHub sign-in routes (§11.1).
//
// Reads work at three places: a branch head (/api/branches/:b/…), a task's state
// (/api/tasks/:t/…) and any commit (/api/commits/:c/…). Writes only go into a task: one
// named in the path, or the caller's current task on a branch, made on first edit (§8.3).
// Branch names with a slash are URL-encoded in paths.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { serve, upgradeWebSocket, type ServerType, type WebSocketServerLike } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { WebSocketServer } from "ws";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  ApiError, checkOps, docToJson, ExportRefused, needsDeveloper, OpError, PACK_OP_KINDS, Sapwood, sha256, whereFilter,
  type ApiErrorCode, type ExportFile, type JsonValue, type Patch, type QueryOptions,
} from "@thek42/sapwood-core";
import { demand, isRole, type Auth, type Principal, type Role, type Scopes } from "./auth.ts";
import { Events } from "./events.ts";
import type { GitHub } from "./github.ts";
import { RepoError, type Repo, type Resolutions, type TaskInfo, type TaskState } from "./repo.ts";

type Env = { Variables: { me: Principal; token: string; byCookie: boolean } };
type C = Context<Env>;

interface Place {
  s: Sapwood;
  branch: string;
  files(allowInvalid: boolean): ExportFile[];
  /** At a task: the task, as it is once read (a read can rebase it). */
  task?: TaskInfo;
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
  "in-use": 409,
};

const REPO_STATUS = { "not-found": 404, exists: 409, conflict: 409, invalid: 422, state: 409, "bad-request": 400, forbidden: 403, upstream: 502, stale: 409 } as const;

export interface AppOptions {
  /** GitHub sign-in; without it, only tokens made with sapwood-server token work. */
  github?: GitHub;
  /** Where browsers reach the server, for GitHub's redirect back (default: as the request came in). */
  publicUrl?: string;
  /** What /api/events sends from (default: made here, over `repo`). */
  events?: Events;
  /** The built web app's folder (packages/web/dist), served at every other path. */
  web?: string;
}

const SESSION = "sapwood_session";
const STATE = "sapwood_oauth_state";
const SESSION_DAYS = 30;
/** A write by session cookie must carry this header, which a page on another site can't send. */
const CSRF_HEADER = "x-sapwood-request";

/** Serve the app over HTTP, with its WebSocket. `close` ends open sockets too. */
export function listen(app: Hono<Env>, opts: { port: number; hostname: string }): { server: ServerType; close(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.hostname, websocket: { server: wss as unknown as WebSocketServerLike } }); // ws's types say noServer may be undefined
  return {
    server,
    close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close();
    },
  };
}

export function createApp(repo: Repo, auth: Auth, opts: AppOptions = {}): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((e, c) => {
    if (e instanceof ApiError) return c.json({ error: { code: e.code, message: e.message } }, API_STATUS[e.code] as 400);
    if (e instanceof RepoError) return c.json({ error: { code: e.code, message: e.message, ...(e.detail as object | undefined) } }, REPO_STATUS[e.code] as 400);
    if (e instanceof OpError) return c.json({ error: { code: "bad-op", message: e.message } }, 422);
    if (e instanceof ExportRefused) return c.json({ error: { code: "invalid", message: e.message, errors: e.validation.errors, warnings: e.validation.warnings } }, 422);
    console.error(e);
    return c.json({ error: { code: "internal", message: "Something went wrong on the server" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not-found", message: `No route ${c.req.method} ${c.req.path}` } }, 404));

  app.get("/healthz", (c) => c.json({ ok: true, initialized: repo.initialized, github: !!opts.github }));

  // ------------------------------------------------------------ signing in

  const github = (): GitHub => {
    if (!opts.github) throw new RepoError("state", "This server has no GitHub sign-in set up: ask its admin for a token instead");
    return opts.github;
  };
  const base = (c: C) => (opts.publicUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
  const callback = (c: C) => `${base(c)}/auth/github/callback`;
  const secure = (c: C) => base(c).startsWith("https:");

  /** The device flow, for the CLI and MCP: a code to enter at GitHub, then poll for a token. */
  app.post("/auth/device", async (c) => c.json(await github().startDevice()));
  app.post("/auth/device/token", async (c) => {
    const b = await body(c);
    const device = str(b.device, "device");
    const name = b.name === undefined ? "sapwood login" : str(b.name, "name");
    const r = await github().pollDevice(device);
    if ("pending" in r) return c.json({ pending: true, interval: r.interval ?? null }, 202);
    const u = auth.signIn(await github().user(r.token), "device");
    const { token, info } = auth.createToken(u.login, { name }, u.login);
    return c.json({ token, id: info.id, login: u.login, role: u.role }, 201);
  });
  /** The web flow: off to GitHub, and back to a session cookie. */
  app.get("/auth/github", (c) => {
    const gh = github();
    const state = randomBytes(18).toString("base64url");
    setCookie(c, STATE, state, { httpOnly: true, secure: secure(c), sameSite: "Lax", path: "/auth", maxAge: 600 });
    return c.redirect(gh.authorizeUrl(state, callback(c)));
  });
  app.get("/auth/github/callback", async (c) => {
    const gh = github();
    const want = getCookie(c, STATE) ?? "";
    const got = c.req.query("state") ?? "";
    deleteCookie(c, STATE, { path: "/auth" });
    if (!want || want.length !== got.length || !timingSafeEqual(Buffer.from(want), Buffer.from(got)))
      throw new RepoError("forbidden", "This sign-in didn't start here, or took too long: try again");
    const code = c.req.query("code");
    if (!code) throw new RepoError("forbidden", "GitHub didn't sign you in");
    const u = auth.signIn(await gh.user(await gh.exchangeCode(code, callback(c))), "web");
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    const { token } = auth.createToken(u.login, { name: "Web sign-in", expires }, u.login);
    setCookie(c, SESSION, token, { httpOnly: true, secure: secure(c), sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86_400 });
    return c.redirect("/");
  });
  /**
   * Sign the browser in with a Sapwood token, for servers without GitHub sign-in: the session
   * is a new token, able to do no more than the one given, for 30 days at most. Needs the
   * write header, so a page on another site can't sign you in as someone else.
   */
  app.post("/auth/token", async (c) => {
    if (c.req.header(CSRF_HEADER) !== "1") throw new RepoError("forbidden", `Signing in needs the header ${CSRF_HEADER}: 1`);
    const b = await body(c);
    const p = typeof b.token === "string" ? auth.authenticate(b.token.trim()) : null;
    if (!p) return c.json({ error: { code: "unauthenticated", message: "That token doesn't work here: it may be mistyped, revoked or expired" } }, 401);
    const given = auth.token(p.token).expires;
    const most = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    const expires = given !== null && given < most ? given : most;
    const { token } = auth.createToken(p.login, { name: "Web sign-in", scopes: p.scopes, expires }, p.login);
    setCookie(c, SESSION, token, { httpOnly: true, secure: secure(c), sameSite: "Lax", path: "/", maxAge: Math.floor((Date.parse(expires) - Date.now()) / 1000) });
    return c.json({ login: p.login, role: p.role });
  });
  app.post("/auth/logout", (c) => {
    const session = getCookie(c, SESSION);
    const p = session ? auth.authenticate(session) : null;
    if (p) auth.revokeToken(p.token, p.login);
    deleteCookie(c, SESSION, { path: "/" });
    return c.json({ signedOut: !!p });
  });

  app.use("/api/*", async (c, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    let me = m ? auth.authenticate(m[1]!) : null;
    let token = m?.[1] ?? "";
    if (!m) {
      const session = getCookie(c, SESSION);
      me = session ? auth.authenticate(session) : null;
      token = session ?? "";
      if (me && !["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header(CSRF_HEADER) !== "1")
        return c.json({ error: { code: "forbidden", message: `A write with a session cookie needs the header ${CSRF_HEADER}: 1` } }, 403);
    }
    if (!me) {
      c.header("WWW-Authenticate", 'Bearer realm="sapwood"');
      return c.json({ error: { code: "unauthenticated", message: "Pass a Sapwood token: Authorization: Bearer swd_…" } }, 401);
    }
    c.set("me", me);
    c.set("token", token);
    c.set("byCookie", !m);
    await next();
  });

  const me = (c: C) => c.get("me");
  const may = (c: C, need: Role, action: "read" | "write" | "land", branch: string) => demand(me(c), need, action, branch);

  // ------------------------------------------------------------ events

  const events = opts.events ?? new Events(repo, auth);

  /**
   * The WebSocket: what changes on the branches you may read (or those in ?branch=, which
   * repeats), as JSON messages. A browser signs in with its session cookie, which only a
   * page from this server may use here (a page on another site would send its own origin).
   */
  app.get("/api/events", async (c, next) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      return c.json({ error: { code: "bad-request", message: "This is a WebSocket: connect with one" } }, 426);
    if (c.get("byCookie") && c.req.header("origin") !== new URL(base(c)).origin)
      return c.json({ error: { code: "forbidden", message: "Events by session cookie only for pages from this server" } }, 403);
    const asked = c.req.queries("branch");
    for (const b of asked ?? []) may(c, "viewer", "read", repo.branch(b).name);
    let stop = () => {};
    return upgradeWebSocket(c, {
      onOpen: (_e, ws) => {
        stop = events.add({
          token: c.get("token"),
          principal: me(c),
          branches: asked ? new Set(asked) : null,
          send: (text) => ws.send(text),
          close: (code, reason) => ws.close(code, reason),
        });
      },
      onClose: () => stop(),
    });
  });

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
    return c.json(repo.discardBranch(b, me(c).login));
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
  /** An entity's history on the branch (DESIGN §8.7), newest first: each commit that changed it, before and after. */
  app.get("/api/branches/:b/history/entities/:id", (c) => {
    const b = c.req.param("b");
    may(c, "viewer", "read", b);
    return c.json(repo.entityHistory(b, c.req.param("id")!, Math.min(Number(c.req.query("limit") ?? 50) || 50, 500)));
  });
  /** A cell's history on the branch, by stable IDs: `?sheet=&row=&col=`. */
  app.get("/api/branches/:b/history/cell", (c) => {
    const b = c.req.param("b");
    may(c, "viewer", "read", b);
    const q = (k: string) => {
      const v = c.req.query(k);
      if (!v) throw new RepoError("bad-request", `Say which cell: ${k} is missing`);
      return v;
    };
    return c.json(repo.cellHistory(b, q("sheet"), q("row"), q("col"), Math.min(Number(c.req.query("limit") ?? 50) || 50, 500)));
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
  /** `{ rev }` (optional) refuses it if the task changed since; the answer has the ops it applied. */
  for (const verb of ["undo", "redo"] as const)
    app.post(`/api/tasks/:t/${verb}`, async (c) => {
      const t = task(c);
      may(c, "editor", "write", t.branch);
      const b = await body(c, true);
      const ops = repo[verb === "undo" ? "undoChange" : "redoChange"](t.id, me(c).login, revOf(b));
      return c.json({ done: ops !== null, ops: ops ?? [], task: repo.task(t.id) });
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
    // Making, renaming, moving, ordering and deleting packs is a Developer's (DESIGN §11.2); sheets are an Editor's.
    if (list.some((x) => ["createPack", "renamePack", "movePack", "orderPack", "deletePack"].includes(String((x as { op?: unknown } | null)?.op)))) may(c, "developer", "write", repo.task(id).branch);
    // A wizard that makes packs is a Developer's to run, unless its step allows Editors (DESIGN §9.3).
    const wizards = repo.view(id).project.schema.schema.wizards;
    for (const x of list as { op?: unknown; wizard?: unknown }[])
      if (x?.op === "runWizard") {
        const w = wizards.find((y) => y.name === x.wizard);
        if (w && needsDeveloper(w)) may(c, "developer", "write", repo.task(id).branch);
      }
    const change = repo.write(id, me(c).login, (s) => s.apply(list as Patch[]));
    return c.json({ task: repo.task(id), ops: change.ops.length, formulas: change.formulas });
  };
  const schema = async (c: C, id: number) => {
    const b = await body(c);
    const change = repo.write(id, me(c).login, (s) => s.applySchema(str(b.yaml, "yaml"), { force: b.force === true }));
    return c.json({ task: repo.task(id), ops: change.ops.length, formulas: change.formulas, rules: change.rules, scratch: change.scratch, notes: change.notes });
  };

  /**
   * Ops straight into a task (DESIGN §8.1), as one change: what the web app sends, having
   * applied them to its own copy. `{ ops, rev }`: with `rev`, refused (409 stale) if the task
   * changed since, so the client reloads rather than diverging. Schema ops aren't taken here.
   */
  app.post("/api/tasks/:t/ops", async (c) => {
    const t = task(c);
    may(c, "editor", "write", t.branch);
    const b = await body(c);
    const ops = checkOps(b.ops);
    if (ops.some((o) => PACK_OP_KINDS.has(o.kind))) may(c, "developer", "write", t.branch);
    const change = repo.write(t.id, me(c).login, (s) => s.applyOps(ops), revOf(b));
    return c.json({ task: repo.task(t.id), ops: change.ops.length });
  });
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

  if (opts.web) serveWeb(app, opts.web);

  reads(app, "/api/branches/:b", (c) => {
    const branch = c.req.param("b")!;
    may(c, "viewer", "read", branch);
    return { s: repo.head(branch), branch, files: (any) => repo.headExport(branch, any) };
  });
  reads(app, "/api/tasks/:t", (c) => {
    const t = task(c);
    may(c, "viewer", "read", t.branch);
    const s = repo.view(t.id);
    return { s, branch: t.branch, task: repo.task(t.id), files: (any) => s.export({ branch: t.branch, allowInvalid: any }) };
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
  /** The whole document (DocJson), for a client that keeps its own copy; at a task, with the task. */
  app.get(`${prefix}/doc`, (c) => {
    const p = place(c);
    return c.json({ doc: docToJson(p.s.doc), ...(p.task ? { task: p.task } : {}) });
  });
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
  /** What running a wizard would make (DESIGN §9.3), changing nothing: `?wizard=&params=<JSON>&sheet=&pack=&row=` (the last three for a cursor). */
  app.get(`${prefix}/wizard-preview`, (c) => {
    let params: unknown;
    try {
      params = JSON.parse(c.req.query("params") ?? "{}");
    } catch {
      throw new RepoError("bad-request", "params is a JSON object");
    }
    const sheet = c.req.query("sheet");
    const pack = c.req.query("pack");
    const cursor = sheet ? { sheet, row: Number(c.req.query("row") ?? 1), ...(pack ? { pack } : {}) } : undefined;
    return c.json(place(c).s.previewWizard(c.req.query("wizard") ?? "", (params ?? {}) as Record<string, unknown>, cursor ? { cursor } : {}));
  });
  /** Entities that could move down the pack tree (DESIGN §7.4): `?pack=` for one pack and below. */
  app.get(`${prefix}/move-suggestions`, (c) => {
    const pack = c.req.query("pack");
    return c.json(place(c).s.suggestMoves(pack ? { pack } : {}));
  });
  /** What moving entities would do (DESIGN §7.4), changing nothing: `?ids=a&ids=b&pack=dlc&sheet=`. */
  app.get(`${prefix}/move-preview`, (c) => {
    const sheet = c.req.query("sheet");
    return c.json(place(c).s.previewMove(c.req.queries("ids") ?? [], c.req.query("pack") ?? "", sheet ? { sheet } : {}));
  });
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

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};
/** The page may only load from here, and only connect back here (its WebSocket too). Glide sets inline styles. */
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * The web app: its files, and index.html for any other path outside /api and /auth, so the
 * app's own routes load it. Vite names files under assets/ by their contents, so they keep.
 */
function serveWeb(app: Hono<Env>, dir: string): void {
  const root = resolve(dir);
  app.get("*", (c, next) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return next(); // a malformed %-escape
    }
    if (path.startsWith("/api/") || path.startsWith("/auth/") || path === "/healthz") return next();
    let file = resolve(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) return next(); // ../ out of the folder
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      // not there: the app's own route
    }
    if (!isFile) {
      if (extname(path) !== "") return next(); // a missing file, not a page
      file = join(root, "index.html");
    }
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": type, "X-Content-Type-Options": "nosniff" };
    if (path.startsWith("/assets/")) headers["Cache-Control"] = "public, max-age=31536000, immutable";
    else headers["Cache-Control"] = "no-cache";
    if (type.startsWith("text/html")) {
      headers["Content-Security-Policy"] = CSP;
      headers["Referrer-Policy"] = "same-origin";
    }
    return c.body(readFileSync(file), 200, headers);
  });
}

function revOf(b: Record<string, unknown>): { rev?: number } {
  if (b.rev === undefined) return {};
  if (!Number.isInteger(b.rev)) throw new RepoError("bad-request", "rev: expected a whole number");
  return { rev: b.rev as number };
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
