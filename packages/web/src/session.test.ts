// The web app's task session against a real server, in-process: what the browser shows must
// end up exactly what the server has, whatever else writes to the task meanwhile.

import { describe, expect, it } from "vitest";
import { docFromJson, docsEqual, Sapwood } from "@thek42/sapwood-core";
import { Auth, createApp, Db, Repo } from "@thek42/sapwood-server";
import { PROJECT, SCHEMA } from "../../server/src/fixtures.ts";
import { Api, type Fetch } from "./api.ts";
import { TaskSession } from "./session.ts";

function setup() {
  const db = new Db(":memory:");
  const repo = new Repo(db);
  const auth = new Auth(db);
  auth.addUser("ada", "admin", "test");
  auth.addUser("bob", "editor", "test");
  repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
  const app = createApp(repo, auth);
  /** A browser signed in as `login`: the bearer token stands in for the cookie. */
  const client = (login: string) => {
    const token = auth.createToken(login, { name: "test" }, "test").token;
    const fetch: Fetch = async (path, init = {}) => app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
    return new Api(fetch);
  };
  return { repo, bob: client("bob"), ada: client("ada") };
}

/** The server's copy of the task is the session's, exactly. */
async function agrees(api: Api, s: TaskSession) {
  await s.settled();
  const { doc, task } = await api.taskDoc(s.task.id);
  expect(task.rev).toBe(s.task.rev);
  expect(docsEqual(docFromJson(doc), s.project.doc)).toBe(true);
}

const sheet = (s: TaskSession) => s.project.sheetId("Weapons");
/** An entity's field as the session shows it: a value, or a formula's value. */
const value = (s: TaskSession, id: string, field: string) => {
  const v = new Sapwood(s.project).get(id)[field] as unknown;
  return v !== null && typeof v === "object" && "$value" in v ? v.$value : v;
};
const exists = (s: TaskSession, id: string) => new Sapwood(s.project).query("Weapon").some((e) => e.$id === id);

describe("the web app's task session", () => {
  it("shows an edit at once, sends it, and undo and redo go through the server", async () => {
    const { bob } = setup();
    const t = await bob.newTask("main");
    const s = await TaskSession.open(bob, t.id);
    s.edit((p) => p.set(sheet(s), "C1", "12"));
    expect(s.state.unsent).toBe(1);
    expect(value(s, "w2", "damage")).toBe(24); // recalculated here, before the server answers
    s.edit((p) => p.insert(sheet(s), "row", 3));
    s.edit((p) => p.setRows(sheet(s), [["Weapon", "w3", "=C1+1"]], 3));
    await agrees(bob, s);
    expect(s.task.changes).toBe(3);
    await s.undo();
    expect(exists(s, "w3")).toBe(false);
    await agrees(bob, s);
    await s.redo();
    expect(value(s, "w3", "damage")).toBe(13);
    await agrees(bob, s);
    expect(s.notice).toBe(null);
    // Named elsewhere: the session takes the name, without reading the task again.
    const rev = s.task.rev;
    s.heard(await bob.renameTask(t.id, "Buffs"));
    expect(s.task).toMatchObject({ name: "Buffs", rev });
  });

  it("reads the task again when something else wrote to it, and keeps its own edit", async () => {
    const { bob } = setup();
    const t = await bob.newTask("main");
    const s = await TaskSession.open(bob, t.id);
    // The CLI, or an LLM, writes to the same task.
    await fetchPatch(bob, t.id, [{ op: "set", id: "a1", fields: { speed: 950 } }]);
    s.edit((p) => p.set(sheet(s), "C1", "11"));
    await agrees(bob, s);
    expect(s.task.changes).toBe(2);
    expect(value(s, "a1", "speed")).toBe(950);
    expect(value(s, "w1", "damage")).toBe(11);
  });

  it("drops an unsent edit that no longer applies, and says so", async () => {
    const { bob } = setup();
    const t = await bob.newTask("main");
    const s = await TaskSession.open(bob, t.id);
    await fetchPatch(bob, t.id, [{ op: "delete", id: "w2" }]);
    s.edit((p) => p.set(sheet(s), "C2", "5")); // w2's row, gone on the server
    await agrees(bob, s);
    expect(s.notice).toMatch(/no longer applied/);
    expect(exists(s, "w2")).toBe(false);
  });

  it("goes back to the server's copy when an edit is refused", async () => {
    const { bob } = setup();
    const t = await bob.newTask("main");
    const s = await TaskSession.open(bob, t.id);
    s.edit((p) => p.setDef("Weapon", { description: "Guns" })); // a schema op: the server takes YAML
    await agrees(bob, s);
    expect(s.notice).toMatch(/wasn't kept.*YAML/);
    expect(s.task.changes).toBe(0);
  });

  it("follows the task when it's rebased onto a new head", async () => {
    const { bob, ada } = setup();
    const t = await bob.newTask("main");
    const s = await TaskSession.open(bob, t.id);
    s.edit((p) => p.set(sheet(s), "C1", "11"));
    await s.settled();
    const other = await ada.newTask("main");
    await fetchPatch(ada, other.id, [{ op: "set", id: "a2", fields: { speed: 650 } }]);
    await ada.land(other.id);
    // The server rebases bob's task when it's next read; its event says so.
    const status = await bob.taskStatus(t.id);
    s.heard(status.task);
    await agrees(bob, s);
    expect(value(s, "a2", "speed")).toBe(650);
    expect(value(s, "w1", "damage")).toBe(11);
    // A land ends the session's editing.
    await bob.land(t.id);
    s.heard((await bob.taskStatus(t.id)).task);
    await s.settled();
    expect(s.editable).toBe(false);
    expect(s.edit((p) => p.set(sheet(s), "C1", "1"))).toBe(false);
  });
});

/** A patch through the HTTP API, as the CLI would send it. */
async function fetchPatch(api: Api, task: number, patches: unknown[]) {
  return (api as unknown as { call(m: string, p: string, b: unknown): Promise<unknown> }).call("POST", `/api/tasks/${task}/patches`, patches);
}
