import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Sapwood } from "@thek42/sapwood-core";
import { Auth } from "./auth.ts";
import { Db } from "./db.ts";
import { CLOSE_SIGNED_OUT, Events, type EventMessage } from "./events.ts";
import { PROJECT, SCHEMA } from "./fixtures.ts";
import { createApp, listen } from "./http.ts";
import { Repo, RepoError, type RepoEvent } from "./repo.ts";

const running: { close(): void }[] = [];
afterEach(() => {
  for (const r of running.splice(0)) r.close();
});

/** A real server on a free port, with its WebSocket. */
async function serveIt(publicUrl?: string) {
  const db = new Db(":memory:");
  const repo = new Repo(db);
  const auth = new Auth(db);
  auth.addUser("ada", "admin", "test");
  auth.addUser("bob", "editor", "test");
  repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
  const events = new Events(repo, auth, { validateAfter: 5 });
  const app = createApp(repo, auth, { events, ...(publicUrl ? { publicUrl } : {}) });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const s = listen(app, { port, hostname: "127.0.0.1" });
  running.push({ close: () => (events.stop(), s.close()) });
  await new Promise<void>((done) => (s.server.listening ? done() : s.server.once("listening", () => done())));
  const token = (login: string, scopes = {}) => auth.createToken(login, { name: "test", scopes }, "test").token;
  const url = `ws://127.0.0.1:${port}/api/events`;
  return { db, repo, auth, app, events, port, token, url };
}

/** A client: every message it gets, and a way to wait for one. */
function connect(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const got: EventMessage[] = [];
  const waiting: { pred: (m: EventMessage) => boolean; done: (m: EventMessage) => void }[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data)) as EventMessage;
    got.push(m);
    for (const w of [...waiting]) if (w.pred(m)) (waiting.splice(waiting.indexOf(w), 1), w.done(m));
  });
  const next = (pred: (m: EventMessage) => boolean, ms = 2000) =>
    new Promise<EventMessage>((done, fail) => {
      const seen = got.find(pred);
      if (seen) return done(seen);
      const timer = setTimeout(() => fail(new Error(`No such message; got ${JSON.stringify(got.map((m) => m.type))}`)), ms);
      waiting.push({ pred, done: (m) => (clearTimeout(timer), done(m)) });
    });
  const opened = new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("unexpected-response", (_req, res) => fail(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once("error", fail);
  });
  const closed = new Promise<{ code: number; reason: string }>((done) => ws.once("close", (code, reason) => done({ code, reason: String(reason) })));
  return { ws, got, next, opened, closed };
}

const is = (type: string, more: (m: any) => boolean = () => true) => (m: EventMessage) => m.type === type && more(m);

describe("events, over a WebSocket", () => {
  it("says hello, then pushes task changes, lands and validation as they're committed", async () => {
    const { repo, token, url } = await serveIt();
    const ada = connect(url, { authorization: `Bearer ${token("ada")}` });
    await ada.opened;
    expect(await ada.next(is("hello"))).toMatchObject({ login: "ada", role: "admin", branches: ["main"] });

    // bob edits his task: ada hears of it, and of its validation once the burst is over.
    const t = repo.createTask("main", "bob").id;
    repo.write(t, "bob", (s) => s.set("a1", { speed: 1 }));
    repo.write(t, "bob", (s) => s.set("w1", { shots: ["nope"] }));
    expect(await ada.next(is("task", (m) => m.change === "created"))).toMatchObject({ task: { id: t, owner: "bob" }, by: "bob" });
    const v = await ada.next(is("validation", (m) => m.task === t));
    expect(v).toMatchObject({ branch: "main", errors: 1 });
    expect(ada.got.filter(is("validation", (m) => m.task === t))).toHaveLength(1); // one for the burst
    repo.write(t, "bob", (s) => s.set("w1", { shots: ["a1"] }));
    await ada.next(is("validation", (m) => m.task === t && m.errors === 0));

    const landed = repo.land(t, "bob", { message: "Slow a1" });
    expect(await ada.next(is("head"))).toMatchObject({ branch: "main", commit: { id: landed.commit.id, message: "Slow a1" }, by: "bob" });
    expect(await ada.next(is("task", (m) => m.change === "landed"))).toMatchObject({ task: { id: t, state: "landed" } });
    expect(await ada.next(is("validation", (m) => m.task === undefined))).toMatchObject({ branch: "main", commit: landed.commit.id, errors: 0 });
    // Order: as committed.
    const order = ada.got.map((m) => (m.type === "task" ? `task ${m.change}` : m.type));
    expect(order.indexOf("head")).toBeLessThan(order.indexOf("task landed"));
  });

  it("only what each may read, and only the branches asked for", async () => {
    const { repo, token, url } = await serveIt();
    repo.createBranch("dev", "main", "ada");
    const all = connect(url, { authorization: `Bearer ${token("bob")}` });
    const devOnly = connect(`${url}?branch=dev`, { authorization: `Bearer ${token("bob")}` });
    const scoped = connect(url, { authorization: `Bearer ${token("bob", { branches: ["dev"] })}` });
    await Promise.all([all.opened, devOnly.opened, scoped.opened]);
    expect(await scoped.next(is("hello"))).toMatchObject({ branches: ["dev"] });
    repo.createTask("main", "ada");
    repo.createTask("dev", "ada");
    await all.next(is("task", (m) => m.task.branch === "dev"));
    await devOnly.next(is("task", (m) => m.task.branch === "dev"));
    await scoped.next(is("task", (m) => m.task.branch === "dev"));
    expect(all.got.some(is("task", (m) => m.task.branch === "main"))).toBe(true);
    for (const c of [devOnly, scoped]) expect(c.got.some(is("task", (m) => m.task.branch === "main"))).toBe(false);
    // Asking for a branch the token can't read, or one there isn't, is refused before it opens.
    await expect(connect(`${url}?branch=main`, { authorization: `Bearer ${token("bob", { branches: ["dev"] })}` }).opened).rejects.toMatchObject({ status: 403 });
    await expect(connect(`${url}?branch=nope`, { authorization: `Bearer ${token("bob")}` }).opened).rejects.toMatchObject({ status: 404 });
    await expect(connect(url, {}).opened).rejects.toMatchObject({ status: 401 });
  });

  it("by session cookie, only for pages from this server", async () => {
    const { token, url, port } = await serveIt();
    const cookie = `sapwood_session=${token("ada")}`;
    await expect(connect(url, { cookie }).opened).rejects.toMatchObject({ status: 403 });
    await expect(connect(url, { cookie, origin: "https://evil.example" }).opened).rejects.toMatchObject({ status: 403 });
    const ok = connect(url, { cookie, origin: `http://127.0.0.1:${port}` });
    await ok.opened;
    expect(await ok.next(is("hello"))).toMatchObject({ login: "ada" });
  });

  it("closes a socket whose token stops working", async () => {
    const { auth, events, token, url } = await serveIt();
    const t = token("bob");
    const bob = connect(url, { authorization: `Bearer ${t}` });
    await bob.opened;
    await bob.next(is("hello"));
    expect(events.size).toBe(1);
    auth.revokeToken(auth.authenticate(t)!.token, "bob");
    events.recheckNow();
    expect(await bob.closed).toEqual({ code: CLOSE_SIGNED_OUT, reason: "Signed out: the token no longer works" });
    expect(events.size).toBe(0);
  });

  it("says it's a WebSocket to a plain request", async () => {
    const { app, token } = await serveIt();
    const r = await app.request("/api/events", { headers: { authorization: `Bearer ${token("ada")}` } });
    expect(r.status).toBe(426);
  });
});

describe("repo events", () => {
  it("come once committed, and not at all for what was rolled back", () => {
    const db = new Db(":memory:");
    const repo = new Repo(db);
    repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
    const heard: RepoEvent[] = [];
    repo.on((e) => heard.push(e));
    const t = repo.createTask("main", "ada").id;
    // In a transaction: held back until it commits.
    db.tx(() => {
      repo.write(t, "ada", (s) => s.set("a1", { speed: 1 }));
      expect(heard.map((e) => e.type)).toEqual(["task"]);
    });
    expect(heard).toHaveLength(2);
    expect(() =>
      db.tx(() => {
        repo.write(t, "ada", (s) => s.set("a1", { speed: 2 }));
        throw new Error("no");
      }),
    ).toThrow("no");
    expect(heard).toHaveLength(2);
    // A refused land says nothing.
    repo.write(t, "ada", (s) => s.set("w1", { shots: ["nope"] }));
    expect(() => repo.land(t, "ada")).toThrow(RepoError);
    expect(heard.map((e) => (e.type === "task" ? e.change : e.type))).toEqual(["created", "changed", "changed"]);
    // Branches, syncs and merges, and a rebase on read (by no one).
    repo.write(t, "ada", (s) => s.set("w1", { shots: ["a1"] }));
    repo.createBranch("dev", "main", "bob");
    const d = repo.createTask("dev", "bob").id;
    repo.write(d, "bob", (s) => s.set("a2", { speed: 2 }));
    repo.land(t, "ada");
    repo.land(d, "bob");
    heard.length = 0;
    repo.merge("dev", "bob");
    expect(heard.map((e) => (e.type === "head" ? `head ${e.branch}` : e.type))).toEqual(["head dev", "head main"]);
    const late = repo.createTask("dev", "bob").id;
    repo.write(late, "bob", (s) => s.set("a2", { speed: 3 }));
    const m = repo.createTask("main", "ada").id;
    repo.write(m, "ada", (s) => s.set("a1", { speed: 9 }));
    repo.land(m, "ada");
    heard.length = 0;
    repo.sync("dev", "bob");
    repo.view(late);
    expect(heard.map((e) => (e.type === "task" ? `task ${e.change} by ${e.by}` : e.type))).toEqual(["head", "task rebased by null"]);
    repo.discardBranch("dev", "ada");
    expect(heard.at(-1)).toMatchObject({ type: "branch", change: "discarded", by: "ada" });
  });
});
