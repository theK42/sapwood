import { describe, expect, it } from "vitest";
import { Sapwood } from "@thek42/sapwood-core";
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
});
