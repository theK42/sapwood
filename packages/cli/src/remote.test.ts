import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Sapwood } from "@thek42/sapwood-core";
import { Auth, createApp, Db, FakeGitHub, Repo } from "@thek42/sapwood-server";
import { run } from "./cli.ts";
import { serverUrl } from "./remote.ts";

const SCHEMA = `
types:
  Weapon:
    fields:
      damage: float
      shots: "list<ref<Ammo>>"
  Ammo: { fields: { speed: float } }
  Config:
    singleton: true
    fields: { lives: int }
`;
const PROJECT = `
sheets:
  - name: Weapons
    layouts: { Weapon: [damage, shots] }
    rows:
      - [Weapon, w1, 10, '["a1"]']
      - [Weapon, w2, "=C1*2"]
  - name: Ammo
    rows:
      - [Ammo, a1, 900]
      - [Ammo, a2, 600]
      - [Config]
      - [.lives, 3]
`;
const URL = "http://sapwood.test:8417";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A server (in this process, no network) and a CLI user per login, each with their own folder and config. */
function setup() {
  const db = new Db(":memory:");
  const repo = new Repo(db);
  const auth = new Auth(db);
  auth.addUser("ada", "admin", "test");
  auth.addUser("bob", "editor", "test");
  repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
  const gh = new FakeGitHub();
  const app = createApp(repo, auth, { github: gh.github });
  const fetch = async (url: string, init?: RequestInit) => app.request(url, init);
  const token = (login: string, scopes = {}) => auth.createToken(login, { name: "test", scopes }, "test").token;
  /** Waiting between sign-in polls: what the person does at GitHub meanwhile, if anything. */
  let waits: (() => void)[] = [];
  const sleep = async () => waits.shift()?.();
  const user = (login: string) => {
    const dir = mkdtempSync(join(tmpdir(), `sapwood-${login}-`));
    dirs.push(dir);
    const env = { SAPWOOD_CONFIG: join(dir, ".sapwood", "config.json") };
    const sw = async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(argv, { cwd: dir, env, fetch, sleep, out: (l) => out.push(l), err: (l) => err.push(l) });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const json = async (...argv: string[]) => {
      const r = await sw(...argv);
      expect(r.err).toBe("");
      return JSON.parse(r.out);
    };
    return { dir, env, sw, json };
  };
  const loggedIn = async (login: string) => {
    const u = user(login);
    expect((await u.sw("login", "--server", URL, "--token", token(login))).code).toBe(0);
    return u;
  };
  const atGitHub = (...steps: (() => void)[]) => {
    waits = steps;
  };
  return { repo, auth, gh, token, user, loggedIn, atGitHub };
}

describe("the sapwood command, on a server", () => {
  it("signs in with GitHub: a code to enter there, then a token kept here", async () => {
    const { user, gh, auth, atGitHub } = setup();
    const bob = user("bob");
    // The first poll finds the code not yet entered; by the second, bob has approved it.
    atGitHub(() => {}, () => gh.approve("WXYZ-0001", { login: "bob", id: 7 }));
    const r = await bob.sw("login", "--server", URL, "--name", "laptop");
    expect(r.out).toBe(
      ["To sign in, open https://github.test/login/device and enter the code WXYZ-0001", "Waiting for GitHub…", `Logged in to ${URL} as bob (editor).`].join("\n"),
    );
    expect((await bob.sw("whoami")).out).toMatch(/^bob \(editor\)/);
    expect(auth.tokens("bob").map((t) => t.name)).toEqual(["laptop"]);
    // Someone the server doesn't know is told so.
    const eve = user("eve");
    atGitHub(() => gh.approve("WXYZ-0003", { login: "eve", id: 8 }));
    const refused = await eve.sw("login", "--server", URL);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("eve isn't a user of this server yet. Your request for access has gone to its Admins");
    expect(existsSync(eve.env.SAPWOOD_CONFIG)).toBe(false);
  });

  it("logs in, and keeps the token to itself", async () => {
    const { user, token } = setup();
    const u = user("bob");
    expect(await u.sw("get", "w1")).toMatchObject({ code: 2, err: expect.stringContaining("no server logged in to") });
    const bad = await u.sw("login", "--server", URL, "--token", "swd_nope");
    expect([bad.code, bad.err]).toEqual([1, expect.stringContaining("[unauthenticated]")]);
    expect(existsSync(u.env.SAPWOOD_CONFIG)).toBe(false);
    expect((await u.sw("login", "--server", "sapwood.test:8417/api/", "--token", token("bob"))).out).toBe(`Logged in to ${URL} as bob (editor).`);
    expect((await u.sw("whoami")).out).toBe(`bob (editor) on ${URL}, branch main.`);
    const config = JSON.parse(readFileSync(u.env.SAPWOOD_CONFIG, "utf8"));
    expect(config).toEqual({ default: URL, servers: { [URL]: { token: expect.stringMatching(/^swd_/) } } });
    if (process.platform !== "win32") expect(statSync(u.env.SAPWOOD_CONFIG).mode & 0o077).toBe(0);
    expect((await u.sw("logout")).out).toBe(`Logged out of ${URL}.`);
    expect((await u.sw("whoami")).code).toBe(2);
  });

  it("edits go into your current task; others see them once landed", async () => {
    const { loggedIn } = setup();
    const bob = await loggedIn("bob");
    const ada = await loggedIn("ada");
    expect((await bob.json("get", "w1")).damage).toBe(10);
    expect((await bob.sw("set", "w1", "damage=15")).out).toBe("Set damage on w1 (task 1).");
    expect((await bob.json("get", "w2")).damage.$value).toBe(30); // your task
    expect((await bob.json("get", "w1", "--head")).damage).toBe(10); // the branch
    expect((await ada.json("get", "w1")).damage).toBe(10); // not yours
    expect((await ada.json("get", "w1", "--task", "1")).damage).toBe(15);
    expect((await bob.sw("create", "Ammo", "a3", "speed=1")).out).toBe("Created Ammo a3 on Ammo (task 1).");
    expect((await bob.sw("query", "Ammo", "--where", "speed<700", "--ids")).out).toBe("a2\na3");
    expect((await bob.sw("set", "Config", "lives=4")).out).toBe("Set lives on Config (task 1).");
    expect((await bob.sw("task")).out).toBe("Task 1 on main, open, bob's: 3 changes.\nUp to date with main.\nValidation: 0 errors, 0 warnings.");
    expect((await bob.sw("undo")).out).toBe("Undid a change in task 1: 2 changes now.");
    expect((await bob.sw("redo")).out).toBe("Redid a change in task 1: 3 changes now.");
    expect((await bob.sw("task", "land", "-m", "Faster w1")).out).toMatch(/^Landed task 1 on main as commit [0-9a-f]{16}\.$/);
    expect((await ada.json("get", "w1")).damage).toBe(15);
    expect((await ada.json("get", "Config")).lives).toBe(4);
    expect((await bob.sw("task")).code).toBe(2); // no current task now
  });

  it("conflicts are listed, and settled on land", async () => {
    const { loggedIn } = setup();
    const bob = await loggedIn("bob");
    const ada = await loggedIn("ada");
    await bob.sw("set", "w1", "damage=30");
    await ada.sw("set", "w1", "damage=20");
    await ada.sw("task", "land");
    expect((await bob.sw("task")).out).toBe(
      "Task 1 on main, open, bob's: 1 change.\n1 commit behind main.\nValidation: 0 errors, 0 warnings.\n" +
        "Conflicts, to settle with --resolve <n>=mine|theirs on task rebase or task land:\n  1. Weapons!C1: mine 30, theirs 20",
    );
    const refused = await bob.sw("task", "land");
    expect(refused).toMatchObject({ code: 1, err: expect.stringContaining("1 conflict with the branch head") });
    expect(refused.err).toContain("1. Weapons!C1: mine 30, theirs 20");
    expect((await bob.sw("task", "land", "--resolve", "3=mine")).code).toBe(2);
    expect((await bob.sw("task", "land", "--resolve", "1=mine")).code).toBe(0);
    expect((await ada.json("get", "w1")).damage).toBe(30);
  });

  it("what you'd undone goes on after a land, and a rebase, so redo still works", async () => {
    const { loggedIn } = setup();
    const bob = await loggedIn("bob");
    const ada = await loggedIn("ada");
    await bob.sw("set", "a1", "speed=1");
    await bob.sw("set", "a2", "speed=2");
    await bob.sw("set", "w1", "damage=3");
    await bob.sw("undo");
    await bob.sw("undo");
    expect((await bob.sw("task", "land", "-m", "Slow a1")).out.split("\n").slice(1)).toEqual([
      "What you'd undone is in task 2, your current task now: sapwood redo goes on from there (2 changes).",
    ]);
    expect((await bob.sw("redo")).out).toBe("Redid a change in task 2: 1 change now.");
    expect((await bob.json("get", "a2")).speed).toBe(2);
    await bob.sw("undo");
    // ada changes a2 meanwhile: hers stands, and bob's undone change to it goes.
    await ada.sw("set", "a2", "speed=5");
    await ada.sw("task", "land");
    expect((await bob.sw("task", "rebase")).out.split("\n")).toEqual([
      "Task 2 is up to date with main: 0 changes.",
      "Kept what you'd undone: sapwood redo goes on (1 change).",
      "Undone changes the head's changes now stand in the way of, dropped:",
      "  1. Ammo!C2: mine 2, theirs 5",
    ]);
    await bob.sw("redo");
    expect((await bob.json("get", "w1")).damage).toBe(3);
    expect((await bob.json("get", "a2")).speed).toBe(5);
  });

  it("refused lands say why", async () => {
    const { loggedIn, token, user } = setup();
    const bob = await loggedIn("bob");
    await bob.sw("set", "w1", "shots=nope");
    const r = await bob.sw("task", "land");
    expect(r.code).toBe(1);
    expect(r.err).toContain("would leave 1 validation error [invalid]");
    expect(r.err).toContain('error Weapons!D1 (w1) ref.missing: shots[0]: no entity "nope"');
    expect((await bob.sw("validate")).code).toBe(1); // your task
    expect((await bob.sw("validate", "--head")).code).toBe(0);
    // A token that can't land.
    const llm = user("bob");
    await llm.sw("login", "--server", URL, "--token", token("bob", { noLand: true }));
    expect((await llm.sw("task", "land")).err).toContain("can't land");
  });

  it("tasks: new, list, switch, name, abandon, reopen", async () => {
    const { loggedIn } = setup();
    const bob = await loggedIn("bob");
    await bob.sw("set", "a1", "speed=1");
    expect((await bob.sw("task", "new", "Second", "go")).out).toBe("Started task 2 on main; it's your current task there.");
    await bob.sw("set", "a1", "speed=2");
    expect((await bob.sw("task", "list")).out).toBe("  1  open  bob  1 change\n* 2  open  bob  1 change  Second go");
    expect((await bob.sw("task", "switch", "1")).out).toBe("Task 1 is now your current task on main.");
    expect((await bob.json("get", "a1")).speed).toBe(1);
    await bob.sw("task", "name", "First");
    expect((await bob.sw("task", "abandon")).out).toBe("Abandoned task 1; task reopen 1 brings it back.");
    expect((await bob.sw("task", "list")).out).toBe("  2  open  bob  1 change  Second go");
    expect((await bob.sw("task", "list", "--all")).out).toContain("  1  abandoned  bob  1 change  First");
    await bob.sw("task", "reopen", "1");
    expect((await bob.json("get", "a1")).speed).toBe(1);
    expect((await bob.sw("task", "status", "2")).out).toContain('Task 2 "Second go" on main');
  });

  it("branches", async () => {
    const { loggedIn } = setup();
    const bob = await loggedIn("bob");
    expect((await bob.sw("branch", "create", "qa/7")).out).toBe("Created branch qa/7 from main. Work on it with sapwood branch switch qa/7.");
    expect((await bob.sw("branch", "switch", "qa/7")).out).toBe("Now on branch qa/7.");
    expect((await bob.sw("branch")).out).toMatch(/^  main  head [0-9a-f]{8}\n\* qa\/7  head [0-9a-f]{8}  from main$/);
    await bob.sw("set", "a2", "speed=5");
    await bob.sw("task", "land");
    expect((await bob.json("get", "a2")).speed).toBe(5);
    expect((await bob.json("get", "a2", "--branch", "main")).speed).toBe(600);
    expect((await bob.sw("branch", "discard", "qa/7")).code).toBe(0);
    expect((await bob.sw("branch", "switch", "qa/7")).code).toBe(2);
    expect((await bob.sw("branch", "list", "--all")).out).toContain("(discarded)");
  });

  it("branch status, sync and merge", async () => {
    const { loggedIn } = setup();
    const bob = await loggedIn("bob");
    const ada = await loggedIn("ada");
    await bob.sw("branch", "create", "dev");
    await bob.sw("branch", "switch", "dev");
    await bob.sw("set", "a1", "speed=1");
    await bob.sw("task", "land");
    await ada.sw("set", "a1", "speed=2");
    await ada.sw("set", "a2", "speed=3");
    await ada.sw("task", "land");
    expect((await bob.sw("branch", "status")).out).toBe(
      "dev: 1 commit to merge into main, 1 commit of main's to sync.\n" +
        "Conflicts a sync would have (mine is dev), to settle with --resolve <n>=mine|theirs on branch sync or branch merge:\n" +
        "  1. Ammo!C1: mine 1, theirs 2",
    );
    expect((await bob.sw("branch", "sync")).err).toContain("[conflict]");
    expect((await bob.sw("branch", "sync", "--resolve", "1=mine")).out).toMatch(/^Synced dev from its parent as commit [0-9a-f]{16}\.$/);
    expect((await bob.json("get", "a2")).speed).toBe(3);
    expect((await bob.sw("branch", "sync")).out).toBe("dev is up to date with its parent.");
    expect((await bob.sw("branch", "merge", "-m", "Ship dev")).out).toMatch(/^Merged dev into main as commit [0-9a-f]{16}\.$/);
    expect((await ada.json("get", "a1")).speed).toBe(1);
    expect((await bob.sw("branch", "status", "main")).out).toBe("main has no parent: it's the root branch.");
  });

  it("log, revert and restore", async () => {
    const { loggedIn } = setup();
    const ada = await loggedIn("ada");
    await ada.sw("set", "a1", "speed=1");
    await ada.sw("task", "land", "-m", "Faster a1");
    await ada.sw("delete", "a2");
    await ada.sw("task", "land", "-m", "No a2");
    const log = (await ada.sw("log")).out.split("\n");
    expect(log).toHaveLength(3);
    expect(log[0]).toMatch(/^[0-9a-f]{8}  \d{4}-\d\d-\d\d \d\d:\d\d  ada  No a2$/);
    expect((await ada.sw("log", "-n", "1")).out.split("\n")).toHaveLength(1);
    const [faster, first] = [log[1]!.slice(0, 8), log[2]!.slice(0, 8)];
    expect((await ada.sw("revert", faster)).out).toBe(
      `Task 3: Revert "Faster a1". It's now your current task on main.\nCheck it with sapwood task status, then land it with sapwood task land.`,
    );
    await ada.sw("task", "land");
    expect((await ada.json("get", "a1")).speed).toBe(900);
    expect((await ada.sw("restore", first)).out).toMatch(/^Task 4: Restore to [0-9a-f]{8} "/);
    await ada.sw("task", "land");
    expect((await ada.json("get", "a2")).speed).toBe(600);
    expect((await ada.sw("revert", "nothing")).err).toContain("[not-found]");
  });

  it("schema, patch files and export", async () => {
    const { loggedIn } = setup();
    const ada = await loggedIn("ada");
    const yaml = (await ada.sw("schema", "get")).out;
    writeFileSync(join(ada.dir, "edited.yaml"), yaml.replace("speed:", "velocity:"));
    expect((await ada.sw("schema", "apply", "edited.yaml")).out).toBe("Schema updated (task 1).");
    expect((await ada.json("get", "a1")).velocity).toBe(900);
    writeFileSync(join(ada.dir, "p.jsonl"), '{"op":"create","type":"Ammo","fields":{"$id":"a3","velocity":1}}\n{"op":"commentOut","id":"a2"}\n');
    expect((await ada.sw("apply", "p.jsonl")).out).toBe("Applied 2 patches (task 1).");
    expect((await ada.sw("query", "Ammo", "--ids")).out).toBe("a1\na3");
    // Export is the branch head unless asked otherwise.
    expect((await ada.sw("export", "--out", "head")).out).toContain("Exported 2 files");
    expect(Object.keys(JSON.parse(readFileSync(join(ada.dir, "head", "root.json"), "utf8")).types.Ammo)).toEqual(["a1", "a2"]);
    await ada.sw("export", "--out", "mine", "--task", "1");
    expect(Object.keys(JSON.parse(readFileSync(join(ada.dir, "mine", "root.json"), "utf8")).types.Ammo)).toEqual(["a1", "a3"]);
    expect(readdirSync(join(ada.dir, "mine")).sort()).toEqual(["manifest.json", "root.json"]);
    await ada.sw("task", "land");
    const commit = (await ada.sw("task", "list", "--all")).out;
    expect(commit).toContain("landed");
  });

  it("tokens", async () => {
    const { loggedIn, user } = setup();
    const bob = await loggedIn("bob");
    const made = await bob.sw("token", "create", "--name", "llm", "--no-land", "--only-branch", "main");
    expect(made.out).toMatch(/^swd_/);
    const llm = user("bob");
    await llm.sw("login", "--server", URL, "--token", made.out);
    expect((await llm.sw("whoami")).out).toBe(`bob (editor) on ${URL}, branch main; this token: noLand, branches main.`);
  });

  it("a local project file here comes first, unless --server says otherwise", async () => {
    const { loggedIn } = setup();
    const bob = await loggedIn("bob");
    writeFileSync(join(bob.dir, "schema.yaml"), SCHEMA);
    writeFileSync(join(bob.dir, "project.yaml"), PROJECT.replace("900", "1"));
    await bob.sw("init", "--schema", "schema.yaml", "--from", "project.yaml");
    expect((await bob.json("get", "a1")).speed).toBe(1);
    expect((await bob.json("get", "a1", "--server", URL)).speed).toBe(900);
    expect((await bob.sw("get", "a1", "--head")).err).toContain("needs a server");
  });
});

describe("server addresses", () => {
  it("are read leniently", () => {
    expect(serverUrl("localhost:8417")).toBe("http://localhost:8417");
    expect(serverUrl("https://sw.example.com/api/")).toBe("https://sw.example.com");
  });
});
