import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Sapwood } from "@thek42/sapwood-core";
import { run } from "@thek42/sapwood-cli";
import { saveProjectFile } from "@thek42/sapwood-cli/store";
import { Auth, createApp, Db, Repo } from "@thek42/sapwood-server";
import { connect, createServer, type ConnectOptions, type McpIo } from "./mcp.ts";

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
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "sapwood-mcp-"));
  dirs.push(d);
  return d;
};

/** An LLM's side of the connection: call a tool, get its text back. */
async function llm(opts: ConnectOptions, io: McpIo) {
  const server = createServer(connect(opts, io));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), error: r.isError === true };
  };
  const json = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    expect(r.error, r.text).toBe(false);
    return JSON.parse(r.text);
  };
  const tools = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, call, json, tools, instructions: client.getInstructions() };
}

describe("the MCP server, on a local project file", () => {
  const local = async () => {
    const dir = tempDir();
    const file = join(dir, "sapwood.json");
    saveProjectFile(file, Sapwood.load(SCHEMA, PROJECT));
    // Found from a folder below, as the CLI finds it.
    return { file, ...(await llm({}, { cwd: dir, env: { SAPWOOD_CONFIG: join(dir, "none.json") } })) };
  };

  it("reads, edits all or nothing, and says what to fix", async () => {
    const { file, call, json, tools, instructions } = await local();
    expect(await tools()).toEqual(["apply_schema", "get", "patch", "query", "schema", "validate"]);
    expect(instructions).toContain(`This connection works on the project file ${file}.`);
    expect(await json("get", { id: "w2" })).toMatchObject({ $type: "Weapon", $id: "w2", damage: { $value: 20, $formula: "=C1*2" } });
    expect(await json("get", { id: "Config" })).toMatchObject({ $type: "Config", lives: 3 });
    expect(await json("query", { type: "Ammo", where: ["speed>700"], idsOnly: true })).toEqual(["a1"]);
    expect((await call("schema")).text).toContain("Weapon:");

    const r = await call("patch", {
      patches: [
        { op: "create", type: "Ammo", fields: { $id: "a3", speed: 300 } },
        { op: "set", id: "w1", fields: { shots: ["a1", "a3"] } },
      ],
    });
    expect(r).toEqual({ error: false, text: "Applied 2 patches.\nValidation now: 0 errors, 0 warnings." });
    expect(JSON.parse(readFileSync(file, "utf8"))).toBeTruthy();
    expect(await json("get", { id: "w1" })).toMatchObject({ shots: ["a1", "a3"] });

    // A refusal comes back as a tool error with the API's code, and nothing is applied.
    const bad = await call("patch", {
      patches: [
        { op: "set", id: "a1", fields: { speed: 1 } },
        { op: "set", id: "nope", fields: { speed: 1 } },
      ],
    });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/\[not-found\]$/);
    expect(await json("get", { id: "a1" })).toMatchObject({ speed: 900 });
    const formula = await call("patch", { patches: [{ op: "set", id: "w2", fields: { damage: 5 } }] });
    expect(formula.text).toMatch(/\[formula\]$/);
    // The schema of the patch list is checked before anything runs.
    expect((await call("patch", { patches: [{ op: "explode", id: "w1" }] })).error).toBe(true);
  });

  it("reports validation, and changes the schema", async () => {
    const { call, json } = await local();
    expect((await call("patch", { patches: [{ op: "set", id: "w1", fields: { shots: ["missing"] } }] })).text).toContain("Validation now: 1 error");
    const v = await json("validate");
    expect(v.errors).toBe(1);
    expect(v.issues[0]).toMatchObject({ level: "error", sheet: "Weapons", entity: { id: "w1" } });
    const yaml = (await call("schema")).text.replace(/( +)speed: (.*)\n/, "$1speed: $2\n$1mass: float\n");
    expect((await call("apply_schema", { yaml })).text).toMatch(/^Schema updated\./);
    expect((await call("apply_schema", { yaml })).text).toBe("The schema is unchanged.");
  });
});

describe("the MCP server, on a server", () => {
  function setup() {
    const db = new Db(":memory:");
    const repo = new Repo(db);
    const auth = new Auth(db);
    auth.addUser("bob", "editor", "test");
    repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "bob");
    const app = createApp(repo, auth);
    const fetch = async (url: string, init?: RequestInit) => app.request(url, init);
    const dir = tempDir();
    const env = { SAPWOOD_CONFIG: join(dir, ".sapwood", "config.json") };
    const io = { cwd: dir, env, fetch };
    const sw = async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(argv, { ...io, out: (l) => out.push(l), err: (l) => err.push(l) });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const token = (scopes = {}) => auth.createToken("bob", { name: "test", scopes }, "test").token;
    return { repo, io, sw, token };
  }

  it("uses your sapwood login, and edits go into your current task, where the CLI sees them", async () => {
    const { io, sw, token } = setup();
    expect((await sw("login", "--server", URL, "--token", token())).code).toBe(0);
    const { call, json, tools, instructions } = await llm({}, io);
    // No tools to land, merge or discard.
    expect(await tools()).toEqual(["apply_schema", "get", "log", "patch", "query", "redo", "schema", "task_status", "undo", "validate"]);
    expect(instructions).toContain(`This connection works on the Sapwood server ${URL}.`);
    expect((await call("task_status")).text).toBe("There's no current task on main yet: the first edit starts one.");

    expect((await call("patch", { patches: [{ op: "set", id: "a1", fields: { speed: 950 } }] })).text).toBe("Applied 1 patch (in task 1).\nValidation now: 0 errors, 0 warnings.");
    // bob edits the same task from the CLI, and each sees the other's edits.
    expect((await sw("set", "a2", "speed=650")).out).toBe("Set speed on a2 (task 1).");
    expect(await json("get", { id: "a2" })).toMatchObject({ speed: 650 });
    expect((await sw("get", "a1")).out).toContain('"speed": 950');
    expect(await json("task_status")).toMatchObject({ task: { id: 1, changes: 2, owner: "bob" }, behind: 0, conflicts: [], validation: { errors: 0 } });

    expect((await call("undo")).text).toBe("Undid a change in task 1: 1 change now.");
    expect(await json("get", { id: "a2" })).toMatchObject({ speed: 600 });
    expect((await call("redo")).text).toBe("Redid a change in task 1: 2 changes now.");

    // A person lands it.
    expect((await sw("task", "land", "-m", "Faster ammo")).code).toBe(0);
    const log = await json("log");
    expect(log[0]).toMatchObject({ author: "bob", message: "Faster ammo" });
  });

  it("follows the branch you switch to, takes $SAPWOOD_TOKEN, and says when you aren't logged in", async () => {
    const { io, sw, token } = setup();
    expect(() => connect({ server: URL }, io)).toThrow(`Not logged in to ${URL}: run sapwood login --server ${URL}`);
    const { call } = await llm({ server: URL }, { ...io, env: { ...io.env, SAPWOOD_TOKEN: token({ noLand: true }) } });
    expect((await call("patch", { patches: [{ op: "set", id: "a1", fields: { speed: 1 } }] })).text).toContain("(in task 1)");

    expect((await sw("login", "--server", URL, "--token", token())).code).toBe(0);
    const saved = await llm({}, io);
    expect((await sw("branch", "create", "dev")).code).toBe(0);
    expect((await sw("branch", "switch", "dev")).code).toBe(0);
    expect((await saved.call("patch", { patches: [{ op: "set", id: "a2", fields: { speed: 1 } }] })).text).toContain("(in task 2)");
    expect((await sw("task")).out).toMatch(/^Task 2 on dev/);
    // Refusals carry the server's code.
    const r = await saved.call("get", { id: "nope" });
    expect([r.error, r.text]).toEqual([true, expect.stringMatching(/\[not-found\]$/)]);
  });
});
