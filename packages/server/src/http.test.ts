import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { docFromJson, docsEqual, Project, Sapwood } from "@thek42/sapwood-core";
import { Auth, type Scopes } from "./auth.ts";
import { Db } from "./db.ts";
import { createApp } from "./http.ts";
import { Repo } from "./repo.ts";
import { PROJECT, SCHEMA } from "./fixtures.ts";

function setup() {
  const db = new Db(":memory:");
  const repo = new Repo(db);
  const auth = new Auth(db);
  auth.addUser("Ada", "admin", "test");
  auth.addUser("bob", "editor", "test");
  auth.addUser("vic", "viewer", "test");
  repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
  const app = createApp(repo, auth);
  const tokenFor = (login: string, scopes: Scopes = {}) => auth.createToken(login, { name: "test", scopes }, "test").token;
  /** A client for one token: `call("POST /api/…", body)` gives the status and the JSON (or text) back. */
  const as = (token: string) => async (route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const [method, path] = route.split(" ") as [string, string];
    const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, ...headers } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await app.request(path, init);
    const text = await res.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      // YAML or empty
    }
    return { status: res.status, json, headers: res.headers };
  };
  return { db, repo, auth, app, tokenFor, as, ada: as(tokenFor("ada")), bob: as(tokenFor("bob")), vic: as(tokenFor("vic")) };
}

describe("the HTTP API", () => {
  it("needs a token", async () => {
    const { app, as } = setup();
    const r = await app.request("/api/branches");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
    expect((await as("swd_nope")("GET /api/me")).status).toBe(401);
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("reads at a branch head", async () => {
    const { vic } = setup();
    expect((await vic("GET /api/me")).json).toEqual({ login: "vic", role: "viewer", scopes: {} });
    expect((await vic("GET /api/branches")).json.map((b: { name: string }) => b.name)).toEqual(["main"]);
    expect((await vic("GET /api/branches/main/entities/w1")).json).toMatchObject({ $type: "Weapon", damage: 10, shots: ["a1"] });
    expect((await vic("GET /api/branches/main/entities/nope")).json.error.code).toBe("not-found");
    expect((await vic("GET /api/branches/main/singletons/Config")).json.lives).toBe(3);
    const q = await vic("GET /api/branches/main/query/Ammo?where=speed%3E700");
    expect(q.json.map((e: { $id: string }) => e.$id)).toEqual(["a1"]);
    expect((await vic("GET /api/branches/main/query/Ammo?where=nonsense")).status).toBe(400);
    expect((await vic("GET /api/branches/main/schema")).json).toContain("Weapon:");
    expect((await vic("GET /api/branches/main/validate")).json).toMatchObject({ errors: 0 });
    expect((await vic("GET /api/branches/main/commits")).json).toHaveLength(1);
  });

  it("edits go into the caller's current task, and land", async () => {
    const { bob, vic } = setup();
    const w = await bob("POST /api/branches/main/patches", [{ op: "set", id: "w1", fields: { damage: 15 } }]);
    expect(w.status).toBe(200);
    const id = w.json.task.id;
    expect(w.json.task).toMatchObject({ owner: "bob", state: "open", changes: 1 });
    expect((await bob("GET /api/branches/main/tasks/current")).json.id).toBe(id);
    expect((await bob(`GET /api/tasks/${id}/entities/w2`)).json.damage.$value).toBe(30);
    expect((await vic("GET /api/branches/main/entities/w1")).json.damage).toBe(10); // not landed yet
    expect((await vic(`GET /api/tasks/${id}`)).json).toMatchObject({ behind: 0, conflicts: [], validation: { errors: 0 } });
    expect((await vic(`GET /api/tasks/${id}/ops`)).json).toHaveLength(1);
    expect((await bob(`POST /api/tasks/${id}/undo`)).json.done).toBe(true);
    expect((await bob(`POST /api/tasks/${id}/redo`)).json.done).toBe(true);
    const land = await bob(`POST /api/tasks/${id}/land`, { message: "Buff w1" });
    expect(land.status).toBe(201);
    expect((await vic("GET /api/branches/main/entities/w1")).json.damage).toBe(15);
    const log = (await vic("GET /api/branches/main/commits")).json;
    expect(log[0]).toMatchObject({ message: "Buff w1", author: "bob", task: id });
    expect((await vic(`GET /api/commits/${log[1].id}/entities/w1`)).json.damage).toBe(10);
    expect((await vic(`GET /api/commits/${log[0].id}`)).json.ops).toHaveLength(1);
  });

  it("refusals carry a code and status", async () => {
    const { bob, vic } = setup();
    expect((await vic("POST /api/branches/main/patches", [{ op: "set", id: "w1", fields: { damage: 1 } }])).status).toBe(403);
    const f = await bob("POST /api/branches/main/patches", [{ op: "set", id: "w2", fields: { damage: 1 } }]);
    expect([f.status, f.json.error.code]).toEqual([409, "formula"]);
    const bad = await bob("POST /api/branches/main/patches", [{ op: "set", id: "w1", fields: { damage: "lots" } }]);
    expect([bad.status, bad.json.error.code]).toEqual([400, "bad-value"]);
    expect((await bob("POST /api/branches/main/patches", { nope: 1 })).status).toBe(400);
    expect((await bob("POST /api/branches/main/schema", { yaml: "types: {}" })).status).toBe(403); // a Developer's
    const t = (await bob("POST /api/branches/main/tasks", { name: "Broken" })).json;
    await bob(`POST /api/tasks/${t.id}/patches`, [{ op: "set", id: "w1", fields: { shots: ["nope"] } }]);
    const land = await bob(`POST /api/tasks/${t.id}/land`);
    expect([land.status, land.json.error.code, land.json.error.validation.errors]).toEqual([422, "invalid", 1]);
    expect((await vic("GET /api/nothing")).status).toBe(404);
  });

  it("conflicts come back with IDs to resolve them by", async () => {
    const { ada, bob } = setup();
    const a = (await ada("POST /api/branches/main/tasks", {})).json.id;
    const b = (await bob("POST /api/branches/main/tasks", {})).json.id;
    await ada(`POST /api/tasks/${a}/patches`, [{ op: "set", id: "a1", fields: { speed: 1 } }]);
    await bob(`POST /api/tasks/${b}/patches`, [{ op: "set", id: "a1", fields: { speed: 2 } }]);
    await ada(`POST /api/tasks/${a}/land`);
    const st = (await bob(`GET /api/tasks/${b}`)).json;
    expect(st.conflicts).toHaveLength(1);
    expect(st.conflicts[0].where).toEqual({ sheet: "Ammo", cell: "C1" });
    const refused = await bob(`POST /api/tasks/${b}/land`);
    expect([refused.status, refused.json.error.code, refused.json.error.conflicts.length]).toEqual([409, "conflict", 1]);
    expect((await bob(`POST /api/tasks/${b}/land`, { resolutions: { [st.conflicts[0].id]: "mine" } })).status).toBe(201);
    expect((await bob("GET /api/branches/main/entities/a1")).json.speed).toBe(2);
  });

  it("schema apply, by a Developer", async () => {
    const { ada } = setup();
    const yaml = (await ada("GET /api/branches/main/schema")).json as string;
    const r = await ada("POST /api/branches/main/schema", { yaml: yaml.replace("speed:", "velocity:") });
    expect(r.status).toBe(200);
    await ada(`POST /api/tasks/${r.json.task.id}/land`);
    expect((await ada("GET /api/branches/main/entities/a1")).json.velocity).toBe(900);
  });

  it("exports with ETags", async () => {
    const { bob, vic } = setup();
    const list = (await vic("GET /api/branches/main/export")).json.files;
    expect(list.map((f: { path: string }) => f.path).sort()).toEqual(["manifest.json", "root.json"]);
    const root = list.find((f: { path: string }) => f.path === "root.json");
    const r = await vic("GET /api/branches/main/export/root.json");
    expect(r.headers.get("etag")).toBe(root.etag);
    expect(r.json.singletons).toEqual({ Config: { lives: 3 } });
    expect((await vic("GET /api/branches/main/export/root.json", undefined, { "if-none-match": root.etag })).status).toBe(304);
    const t = (await bob("POST /api/branches/main/patches", [{ op: "setSingleton", type: "Config", fields: { lives: 4 } }])).json.task.id;
    await bob(`POST /api/tasks/${t}/land`);
    const after = await vic("GET /api/branches/main/export/root.json", undefined, { "if-none-match": root.etag });
    expect(after.status).toBe(200);
    expect(after.json.singletons.Config.lives).toBe(4);
    expect((await vic("GET /api/branches/main/export/nope.json")).status).toBe(404);
  });

  it("tokens can be read-only, no-land, or for some branches", async () => {
    const { as, tokenFor, bob, ada } = setup();
    const ro = as(tokenFor("bob", { readOnly: true }));
    expect((await ro("GET /api/branches/main/entities/w1")).status).toBe(200);
    expect((await ro("POST /api/branches/main/patches", [{ op: "set", id: "w1", fields: { damage: 1 } }])).json.error.message).toContain("read-only");
    const llm = as(tokenFor("bob", { noLand: true }));
    const id = (await llm("POST /api/branches/main/patches", [{ op: "set", id: "w1", fields: { damage: 1 } }])).json.task.id;
    expect((await llm(`POST /api/tasks/${id}/land`)).status).toBe(403);
    expect((await bob(`POST /api/tasks/${id}/land`)).status).toBe(201); // a person lands it
    await ada("POST /api/branches", { name: "staging" });
    const st = as(tokenFor("bob", { branches: ["staging"] }));
    expect((await st("GET /api/branches")).json.map((b: { name: string }) => b.name)).toEqual(["staging"]);
    expect((await st("GET /api/branches/main/entities/w1")).status).toBe(403);
    expect((await st("POST /api/branches/staging/patches", [{ op: "set", id: "w1", fields: { damage: 2 } }])).status).toBe(200);
    const capped = as(tokenFor("ada", { role: "viewer" }));
    expect((await capped("GET /api/me")).json.role).toBe("viewer");
    // A token can only make tokens as limited as itself.
    const made = (await ro("POST /api/tokens", { name: "more", scopes: { readOnly: false } })).status;
    expect(made).toBe(403); // a read-only token can't write, and making a token is a write
    const fromLlm = (await llm("POST /api/tokens", { name: "more", scopes: {} })).json;
    expect(fromLlm.info.scopes).toEqual({ noLand: true });
  });

  it("users and roles are an Admin's", async () => {
    const { ada, bob, as, auth } = setup();
    expect((await bob("GET /api/users")).status).toBe(403);
    expect((await ada("POST /api/users", { login: "Cy", role: "developer" })).json).toMatchObject({ login: "cy", role: "developer" });
    expect((await ada("POST /api/users", { login: "cy", role: "editor" })).status).toBe(409);
    expect((await ada("PATCH /api/users/bob", { role: "viewer" })).json.role).toBe("viewer");
    expect((await bob("POST /api/branches/main/patches", [{ op: "set", id: "w1", fields: { damage: 1 } }])).status).toBe(403); // the role is read per request
    expect((await ada("PATCH /api/users/ada", { role: "editor" })).status).toBe(409); // the last Admin
    const { token, info } = auth.createToken("cy", { name: "x" }, "test");
    expect((await as(token)("GET /api/me")).status).toBe(200);
    expect((await ada(`DELETE /api/tokens/${info.id}`)).json.revoked).toBe(true);
    expect((await as(token)("GET /api/me")).status).toBe(401);
  });

  it("merge and sync", async () => {
    const { bob, vic, as, tokenFor } = setup();
    await bob("POST /api/branches", { name: "dev" });
    let t = (await bob("POST /api/branches/dev/patches", [{ op: "set", id: "a1", fields: { speed: 1 } }])).json.task.id;
    await bob(`POST /api/tasks/${t}/land`);
    t = (await bob("POST /api/branches/main/patches", [{ op: "set", id: "a1", fields: { speed: 2 } }])).json.task.id;
    await bob(`POST /api/tasks/${t}/land`);
    const cmp = (await vic("GET /api/branches/dev/compare")).json;
    expect(cmp).toMatchObject({ behind: 1, ahead: 1 });
    expect(cmp.conflicts[0].where).toEqual({ sheet: "Ammo", cell: "C1" });
    expect((await vic("POST /api/branches/dev/sync")).status).toBe(403);
    expect((await as(tokenFor("bob", { noLand: true }))("POST /api/branches/dev/merge")).status).toBe(403);
    const refused = await bob("POST /api/branches/dev/merge");
    expect([refused.status, refused.json.error.code]).toEqual([409, "conflict"]);
    const m = await bob("POST /api/branches/dev/merge", { message: "Ship dev", resolutions: { [cmp.conflicts[0].id]: "mine" } });
    expect(m.status).toBe(201);
    expect(m.json.sync).not.toBeNull();
    expect(m.json.merge).toMatchObject({ branch: "main", message: "Ship dev" });
    expect((await vic("GET /api/branches/main/entities/a1")).json.speed).toBe(1);
    expect((await vic("POST /api/branches/main/sync", {})).status).toBe(403);
    expect((await bob("POST /api/branches/main/sync", {})).json.error.code).toBe("bad-request");
  });

  it("revert and restore", async () => {
    const { bob, vic } = setup();
    const point = (await vic("GET /api/branches/main/commits")).json[0].id as string;
    let t = (await bob("POST /api/branches/main/patches", [{ op: "set", id: "a1", fields: { speed: 1 } }])).json.task.id;
    const c = (await bob(`POST /api/tasks/${t}/land`)).json.commit;
    expect((await vic(`GET /api/commits/${c.id.slice(0, 6)}`)).json.id).toBe(c.id); // a start of the ID will do
    expect((await vic(`POST /api/commits/${c.id}/revert`)).status).toBe(403);
    const r = await bob(`POST /api/commits/${c.id.slice(0, 8)}/revert`);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ task: { branch: "main", owner: "bob", state: "open" }, conflicts: [] });
    expect((await bob(`GET /api/tasks/${r.json.task.id}/entities/a1`)).json.speed).toBe(900);
    await bob(`POST /api/tasks/${r.json.task.id}/land`);
    expect((await vic("GET /api/branches/main/entities/a1")).json.speed).toBe(900);
    t = (await bob("POST /api/branches/main/patches", [{ op: "delete", id: "a2" }])).json.task.id;
    await bob(`POST /api/tasks/${t}/land`);
    const back = await bob("POST /api/branches/main/restore", { commit: point });
    expect(back.status).toBe(201);
    await bob(`POST /api/tasks/${back.json.task.id}/land`);
    expect((await vic("GET /api/branches/main/entities/a2")).json.speed).toBe(600);
    expect((await bob("POST /api/branches/main/restore", {})).status).toBe(400);
    expect((await bob("POST /api/commits/zzzz/revert")).status).toBe(404);
  });

  it("branches", async () => {
    const { bob, vic } = setup();
    expect((await bob("POST /api/branches", { name: "qa/build-7" })).status).toBe(201);
    const enc = encodeURIComponent("qa/build-7");
    const id = (await bob(`POST /api/branches/${enc}/patches`, [{ op: "set", id: "a2", fields: { speed: 5 } }])).json.task.id;
    await bob(`POST /api/tasks/${id}/land`);
    expect((await vic(`GET /api/branches/${enc}/entities/a2`)).json.speed).toBe(5);
    expect((await vic("GET /api/branches/main/entities/a2")).json.speed).toBe(600);
    expect((await vic(`DELETE /api/branches/${enc}`)).status).toBe(403);
    expect((await bob(`DELETE /api/branches/${enc}`)).json.archived).toBe(true);
    expect((await vic("GET /api/branches?archived=1")).json).toHaveLength(2);
  });

  it("a client keeps its own copy of a task, writes ops into it, and is told when it's behind", async () => {
    const { bob, ada, vic, tokenFor, as } = setup();
    const id = (await bob("POST /api/branches/main/tasks", {})).json.id;
    // The client builds its project from the task's document, with the task's ID salt.
    const load = async () => {
      const r = (await bob(`GET /api/tasks/${id}/doc`)).json;
      const p = Project.fromDoc(docFromJson(r.doc));
      p.wb.idSalt = `${id}_`;
      return { p, rev: r.task.rev as number };
    };
    let { p, rev } = await load();
    const same = async () => docsEqual(docFromJson((await bob(`GET /api/tasks/${id}/doc`)).json.doc), p.doc);
    const weapons = p.sheetId("Weapons");
    // Edits made here, then sent: the server ends up with the same document.
    for (const e of [p.set(weapons, "C1", "12"), p.insert(weapons, "row", 3), p.set(weapons, "A3", "Weapon"), p.set(weapons, "B3", "w3"), p.set(weapons, "C3", "=C1+1")]) {
      const w = await bob(`POST /api/tasks/${id}/ops`, { ops: e.ops, rev });
      expect(w.status).toBe(200);
      expect(w.json.task.rev).toBe(rev + 1);
      rev = w.json.task.rev;
    }
    expect(await same()).toBe(true);
    expect((await bob(`GET /api/tasks/${id}/entities/w3`)).json.damage.$value).toBe(13);
    // Undo and redo answer with the ops they applied, for the client to apply too.
    const u = await bob(`POST /api/tasks/${id}/undo`, { rev });
    expect(u.json.done).toBe(true);
    p.apply(u.json.ops);
    rev = u.json.task.rev;
    expect(await same()).toBe(true);
    const r = await bob(`POST /api/tasks/${id}/redo`, { rev });
    p.apply(r.json.ops);
    rev = r.json.task.rev;
    expect(await same()).toBe(true);
    // Something else writes into the task (the CLI, an LLM): the client's next write is refused.
    await bob(`POST /api/tasks/${id}/patches`, [{ op: "set", id: "w1", fields: { damage: 20 } }]);
    const stale = await bob(`POST /api/tasks/${id}/ops`, { ops: p.set(weapons, "C1", "99").ops, rev });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatchObject({ code: "stale", rev: rev + 1 });
    expect((await bob(`POST /api/tasks/${id}/undo`, { rev })).json.error.code).toBe("stale");
    ({ p, rev } = await load());
    expect(p.engine.cellById(weapons, p.doc.sheets.get(weapons)!.rows.order[0]!, p.doc.sheets.get(weapons)!.cols.order[2]!).value).toBe(20);
    // Another task lands: the next read rebases this one, and its revision moves on.
    const other = (await ada("POST /api/branches/main/patches", [{ op: "set", id: "a2", fields: { speed: 650 } }])).json.task.id;
    await ada(`POST /api/tasks/${other}/land`, {});
    const after = (await bob(`GET /api/tasks/${id}/doc`)).json;
    expect(after.task.rev).toBeGreaterThan(rev);
    expect(after.task.base).toBe((await vic("GET /api/branches/main")).json.head);
    // A head, or a commit, gives its document too.
    expect(docFromJson((await vic("GET /api/branches/main/doc")).json.doc).sheets.size).toBe(2);
    // Refused: a Viewer, a malformed op, an op that doesn't apply, a pack by an Editor, a landed task.
    expect((await vic(`POST /api/tasks/${id}/ops`, { ops: [] })).status).toBe(403);
    const bad = await bob(`POST /api/tasks/${id}/ops`, { ops: [{ kind: "setCell", sheet: weapons }] });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toMatchObject({ code: "bad-op", message: "ops[0].row: expected a non-empty string" });
    expect((await bob(`POST /api/tasks/${id}/ops`, { ops: [{ kind: "setCell", sheet: "nowhere", row: "r1", col: "c1", content: null }] })).json.error.code).toBe("bad-op");
    expect((await bob(`POST /api/tasks/${id}/ops`, { ops: [{ kind: "createPack", pack: "px", name: "dlc", parent: "root" }] })).status).toBe(403);
    expect((await bob(`POST /api/tasks/${id}/ops`, { ops: [{ kind: "setSchema", id: "t1", key: "name", value: "X" }] })).json.error.message).toContain("YAML");
    await bob(`POST /api/tasks/${id}/land`, {});
    expect((await bob(`POST /api/tasks/${id}/ops`, { ops: p.set(weapons, "C2", "1").ops })).json.error.code).toBe("state");
    // A Developer may make a pack.
    const dev = as(tokenFor("ada", { role: "developer" }));
    const t2 = (await dev("POST /api/branches/main/tasks", {})).json.id;
    expect((await dev(`POST /api/tasks/${t2}/ops`, { ops: [{ kind: "createPack", pack: "px", name: "dlc", parent: "root" }] })).status).toBe(200);
  });

  it("signs a browser in with a token, as a session no more able than the token", async () => {
    const { app, tokenFor, auth } = setup();
    const post = (body: unknown, headers: Record<string, string> = { "x-sapwood-request": "1" }) =>
      app.request("/auth/token", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post({ token: tokenFor("bob") }, {})).status).toBe(403); // no write header: a form on another site
    expect((await post({ token: "swd_nope" })).status).toBe(401);
    const r = await post({ token: tokenFor("ada", { readOnly: true }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ login: "ada", role: "admin" });
    const cookie = /sapwood_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")![1]!;
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
    const me = await app.request("/api/me", { headers: { cookie: `sapwood_session=${cookie}` } });
    expect(((await me.json()) as { scopes: unknown }).scopes).toEqual({ readOnly: true });
    expect(auth.tokens("ada").at(-1)).toMatchObject({ name: "Web sign-in", scopes: { readOnly: true } });
  });

  it("serves the web app, with index.html for its own routes", async () => {
    const base = mkdtempSync(join(tmpdir(), "sapwood-web-"));
    const dir = join(base, "dist");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Sapwood</title>");
    writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(base, "secret.txt"), "no");
    const db = new Db(":memory:");
    const repo = new Repo(db);
    repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
    const app = createApp(repo, new Auth(db), { web: dir });
    const page = await app.request("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await (await app.request("/branches/main/sheets/Weapons")).text()).toContain("<title>Sapwood");
    const js = await app.request("/assets/app-abc123.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect((await app.request("/..%2fsecret.txt")).status).toBe(404);
    expect((await app.request("/api/branches")).status).toBe(401); // the API is still the API
    expect((await app.request("/api/nope")).status).toBe(401);
  });

  it("a wizard that makes packs is a Developer's to run, unless its step allows Editors", async () => {
    const { ada, bob } = setup();
    const wizards = `
wizards:
  Event:
    params: { key: { type: string, required: true } }
    steps: [{ createPack: "ev_{key}" }]
    sheet: { pack: "ev_{key}", name: Ammo, create: true }
    rows: [{ type: Ammo, id: "a_{key}", fields: { speed: 1 } }]
  OpenEvent:
    params: { key: { type: string, required: true } }
    steps: [{ createPack: "open_{key}", editors: true }]
    sheet: { pack: "open_{key}", name: Ammo, create: true }
    rows: [{ type: Ammo, id: "o_{key}", fields: { speed: 1 } }]
`;
    const put = await ada("POST /api/branches/main/schema", { yaml: SCHEMA + wizards });
    expect(put.status).toBe(200);
    expect((await ada(`POST /api/tasks/${put.json.task.id}/land`, { message: "Wizards" })).status).toBe(201);
    expect((await bob("POST /api/branches/main/patches", [{ op: "runWizard", wizard: "Event", params: { key: "x" } }])).status).toBe(403);
    const ok = await bob("POST /api/branches/main/patches", [{ op: "runWizard", wizard: "OpenEvent", params: { key: "x" } }]);
    expect(ok.status).toBe(200);
    expect((await bob(`GET /api/tasks/${ok.json.task.id}/entities/o_x`)).json).toMatchObject({ $pack: "open_x" });
    const preview = await bob("GET /api/branches/main/wizard-preview?wizard=OpenEvent&params=" + encodeURIComponent('{"key":"y"}'));
    expect(preview.json).toMatchObject({ packs: ["open_y"], made: [{ id: "o_y", sheet: "Ammo", cell: "A1" }] });
  });

  it("an Editor makes sheets, and only a Developer makes packs", async () => {
    const { ada, bob } = setup();
    expect((await bob("POST /api/branches/main/patches", [{ op: "createPack", name: "dlc" }])).status).toBe(403);
    expect((await ada("POST /api/branches/main/patches", [{ op: "createPack", name: "dlc" }])).status).toBe(200);
    const w = await bob("POST /api/branches/main/patches", [{ op: "createSheet", name: "More" }, { op: "create", type: "Ammo", sheet: "More", fields: { $id: "a3", speed: 5 } }]);
    expect(w.status).toBe(200);
    expect((await bob(`GET /api/tasks/${w.json.task.id}/entities/a3`)).json).toMatchObject({ $sheet: "More", speed: 5 });
    // Renaming and moving: sheets an Editor's, packs a Developer's, as patches and as ops.
    expect((await bob("POST /api/branches/main/patches", [{ op: "renameSheet", name: "More", to: "Extra" }])).status).toBe(200);
    expect((await bob("POST /api/branches/main/patches", [{ op: "renamePack", name: "dlc", to: "season1" }])).status).toBe(403);
    expect((await bob("POST /api/branches/main/patches", [{ op: "movePack", name: "dlc", parent: "root" }])).status).toBe(403);
    expect((await bob(`POST /api/tasks/${w.json.task.id}/ops`, { ops: [{ kind: "setPackParent", pack: "dlc", parent: "root" }] })).status).toBe(403);
    expect((await ada("POST /api/branches/main/patches", [{ op: "renamePack", name: "dlc", to: "season1" }])).status).toBe(200);
  });
});
