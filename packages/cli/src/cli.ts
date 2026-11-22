// The sapwood command (DESIGN §9.4). The data, schema, validation and export commands go
// through a Backend: a local project file (sapwood.json, store.ts) or a Sapwood server
// (remote.ts). Login, branches, tasks and tokens are the server's.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApiError, Sapwood, type CellAddress, type Patch, type ValidationJson } from "@thek42/sapwood-core";
import { LocalBackend, type Backend, type Written } from "./backend.ts";
import { Client, configPath, enc, readConfig, RemoteBackend, ServerError, serverUrl, writeConfig, type Config, type Fetch, type ReadAt, type TaskJson } from "./remote.ts";
import { findProject, loadProjectFile, PROJECT_FILE, saveProjectFile } from "./store.ts";
import { assignments, UsageError } from "./values.ts";

export interface Io {
  cwd: string;
  out(line: string): void;
  err(line: string): void;
  /** Environment variables: SAPWOOD_CONFIG, SAPWOOD_SERVER, SAPWOOD_TOKEN, SAPWOOD_BRANCH (default: the process's). */
  env?: Record<string, string | undefined>;
  /** For talking to the server (default: the global fetch). */
  fetch?: Fetch;
  /** For waiting between sign-in polls (default: a timer). */
  sleep?: (ms: number) => Promise<void>;
}

const HELP = `Usage: sapwood <command> [options]

Working with a server
  login --server <url> [--name <token name>]   Sign in with GitHub: enter the code it shows at github.com
  login --server <url> --token <token>         Or log in with a token (from sapwood-server token)
  logout  |  whoami
  branch [list]  |  branch create <name> [--from <b>]  |  branch switch <name>  |  branch discard <name>
  branch status [<name>]          Commits to merge, commits to sync, and conflicts
  branch sync [<name>] [--resolve <n>=mine|theirs]…            Bring in the parent's changes
  branch merge [<name>] [-m <message>] [--resolve <n>=mine|theirs]…   Into the parent
  task [status [<id>]]            Your current task: changes, how far behind, conflicts
  task new [<name>]  |  task list [--all]  |  task switch <id>  |  task name <name>
  task rebase [--resolve <n>=mine|theirs]…
  task land [-m <message>] [--resolve <n>=mine|theirs]…
  task abandon [<id>]  |  task reopen <id>
  undo  |  redo                   In your current task
  log [<branch>] [-n <count>]     Commits, newest first
  revert <commit>                 A new task that undoes the commit, to check and land
  restore <commit>                A new task that takes the branch back to that commit's state
  token create --name <n> [--read-only] [--no-land] [--only-branch <b>]… [--role <r>] [--expires <date>]

A local project file
  init [--schema <file>] [--from <project.yaml>] [--force]
                                  Start a project in ${PROJECT_FILE} here
Data (on a server: reads show your current task, writes go into it)
  get <id>                        An entity, or a singleton by type name, as JSON
  query <type|trait> [--where <field><op><value>]… [--pack <p>] [--inactive] [--ids]
                                  Entities as JSON lines; ops = != < <= > >= ~
  set <id> <field>=<value>… [--force]
                                  Set fields; blank clears, =… is a formula,
                                  $id=… renames, $active=false comments out
  create <type> <id> [<field>=<value>…] [--sheet <s>] [--pack <p>] [--after <id>]
  comment-out <id>  |  uncomment <id>  |  delete <id>
  apply <patch.jsonl>             Patches, one JSON object per line, all or nothing
Schema
  schema get                      The schema as YAML
  schema apply <file> [--force]   Apply an edited schema file
Validation and export
  validate [--json]               Exit status 1 when there are errors
  export --out <dir> [--allow-invalid]   (on a server: the branch head, unless --task or --commit)

Options for every command
  --project <path>                A local project file, or a folder holding one
                                  (default: the nearest ${PROJECT_FILE} at or above here)
  --server <url>                  A server you've logged in to (default: the last one)
  --branch <name>                 The branch (default: the one you switched to, else main)
On a server, reads also take --head, --task <id> or --commit <id>, and writes --task <id>.`;

type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];
type Parsed = { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };

const READ = { head: { type: "boolean" }, task: { type: "string" }, commit: { type: "string" } } as const;

function parse(args: string[], options: Options = {}): Parsed {
  try {
    return parseArgs({ args, options: { project: { type: "string" }, server: { type: "string" }, branch: { type: "string" }, ...options }, allowPositionals: true, strict: true }) as Parsed;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function positionals(p: { positionals: string[] }, names: string[], rest = false): string[] {
  if (p.positionals.length < names.length) throw new UsageError(`Expected ${names.map((n) => `<${n}>`).join(" ")}`);
  if (!rest && p.positionals.length > names.length) throw new UsageError(`Unexpected ${p.positionals.slice(names.length).join(" ")}`);
  return p.positionals;
}

const where = (a: CellAddress) => `${a.sheet}!${a.cell}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Run one command. Resolves to the exit status: 0 done, 1 failed or invalid, 2 typed wrong. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await command(argv, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`sapwood: ${e.message}`);
      io.err("Run sapwood help for the commands.");
      return 2;
    }
    if (e instanceof ApiError) {
      io.err(`sapwood: ${e.message} [${e.code}]`);
      return 1;
    }
    if (e instanceof ServerError) {
      io.err(`sapwood: ${e.message} [${e.code}]`);
      if (e.status === 401) io.err("Log in again: sapwood login --server <url> --token <token>");
      const conflicts = e.detail.conflicts as ConflictJson[] | undefined;
      if (conflicts) for (const line of conflictLines(conflicts)) io.err(line);
      const validation = e.detail.validation as ValidationJson | undefined;
      if (validation) for (const line of issueLines(validation)) io.err(line);
      return 1;
    }
    io.err(`sapwood: ${(e as Error).message ?? String(e)}`);
    return 1;
  }
}

// ------------------------------------------------------------ where commands go

interface Remote {
  client: Client;
  server: string;
  branch: string;
  config: Config;
  configFile: string;
}

const envOf = (io: Io) => io.env ?? process.env;

function remote(p: Parsed, io: Io): Remote {
  const env = envOf(io);
  const configFile = configPath(env);
  const config = readConfig(configFile);
  const given = (p.values.server as string | undefined) ?? env.SAPWOOD_SERVER;
  const server = given !== undefined ? serverUrl(given) : config.default;
  if (server === undefined) throw new UsageError("Not logged in to a server: run sapwood login --server <url> --token <token>");
  const token = env.SAPWOOD_TOKEN ?? config.servers[server]?.token;
  if (token === undefined) throw new UsageError(`Not logged in to ${server}: run sapwood login --server ${server} --token <token>`);
  const branch = (p.values.branch as string | undefined) ?? env.SAPWOOD_BRANCH ?? config.servers[server]?.branch ?? "main";
  return { client: new Client(server, token, io.fetch ?? fetch), server, branch, config, configFile };
}

/** A local project file when one is given or found here, else the server you're logged in to. */
function backend(p: Parsed, io: Io, defaultAt: ReadAt = { current: true }): { b: Backend; r?: Remote } {
  const env = envOf(io);
  const local = (file: string) => {
    for (const k of ["head", "task", "commit"]) if (p.values[k] !== undefined) throw new UsageError(`--${k} needs a server; this is a local project file (${file})`);
    return { b: new LocalBackend(file, loadProjectFile(file)) };
  };
  if (p.values.project !== undefined) return local(findProject(io.cwd, p.values.project as string));
  if (p.values.server === undefined && env.SAPWOOD_SERVER === undefined) {
    let file: string | undefined;
    try {
      file = findProject(io.cwd);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
    }
    if (file !== undefined) return local(file);
    if (readConfig(configPath(env)).default === undefined)
      throw new UsageError(`No ${PROJECT_FILE} here or in any folder above, and no server logged in to: run sapwood init, or sapwood login`);
  }
  const r = remote(p, io);
  const task = p.values.task === undefined ? undefined : taskId(p.values.task as string);
  const at: ReadAt = p.values.commit !== undefined ? { commit: p.values.commit as string } : task !== undefined ? { task } : p.values.head ? { head: true } : defaultAt;
  return { b: new RemoteBackend(r.client, r.branch, at, task), r };
}

function taskId(text: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`Not a task number: ${text}`);
  return n;
}

async function command(argv: string[], io: Io): Promise<number> {
  const [cmd, ...args] = argv;
  /** Report a write, and what it left for the user to check. */
  const wrote = (w: Written, what: string): number => {
    io.out(w.task === undefined ? what : what.replace(/\.$/, ` (task ${w.task}).`));
    if (w.formulas.length) io.out(`Formulas that mention the old name, left as they are: ${w.formulas.map(where).join(", ")}`);
    return 0;
  };

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(HELP);
      return 0;

    case "init": {
      const p = parse(args, { schema: { type: "string" }, from: { type: "string" }, force: { type: "boolean" } });
      positionals(p, []);
      const dir = resolve(io.cwd, (p.values.project as string | undefined) ?? ".");
      const file = dir.endsWith(".json") ? dir : join(dir, PROJECT_FILE);
      if (existsSync(file) && !p.values.force) throw new UsageError(`${file} exists: pass --force to replace it`);
      const read = (f: unknown) => readFileSync(resolve(io.cwd, f as string), "utf8");
      const schema = p.values.schema === undefined ? "" : read(p.values.schema);
      const s = Sapwood.load(schema, p.values.from === undefined ? { sheets: [] } : read(p.values.from));
      mkdirSync(dirname(file), { recursive: true });
      saveProjectFile(file, s);
      const v = s.validate();
      io.out(`Started a project in ${file}: ${s.project.project().entities.length} entities, ${v.errors} errors, ${v.warnings} warnings.`);
      return 0;
    }

    case "get": {
      const p = parse(args, READ);
      const [id] = positionals(p, ["id"]);
      io.out(JSON.stringify(await backend(p, io).b.get(id!), null, 2));
      return 0;
    }

    case "query": {
      const p = parse(args, { ...READ, where: { type: "string", multiple: true }, pack: { type: "string" }, inactive: { type: "boolean" }, ids: { type: "boolean" } });
      const [type] = positionals(p, ["type"]);
      const q: Parameters<Backend["query"]>[1] = { where: (p.values.where as string[] | undefined) ?? [] };
      if (p.values.pack !== undefined) q.pack = p.values.pack as string;
      if (p.values.inactive) q.inactive = true;
      for (const e of await backend(p, io).b.query(type!, q)) io.out(p.values.ids ? e.$id : JSON.stringify(e));
      return 0;
    }

    case "set": {
      const p = parse(args, { task: { type: "string" }, force: { type: "boolean" } });
      const [id, ...rest] = positionals(p, ["id", "field=value"], true);
      const { b } = backend(p, io);
      const current = await b.get(id!);
      const fields = assignments(await b.schema(), current.$type, rest, current);
      const force = p.values.force === true;
      const patch: Patch = "$id" in current && current.$id !== undefined ? { op: "set", id: id!, fields, force } : { op: "setSingleton", type: id!, fields, force };
      const renamed = typeof fields.$id === "string" && fields.$id !== id ? ` (now ${fields.$id})` : "";
      return wrote(await b.patch([patch]), `Set ${Object.keys(fields).join(", ")} on ${id}${renamed}.`);
    }

    case "create": {
      const p = parse(args, { task: { type: "string" }, sheet: { type: "string" }, pack: { type: "string" }, after: { type: "string" } });
      const [type, id, ...rest] = positionals(p, ["type", "id"], true);
      const { b } = backend(p, io);
      const patch: Patch = { op: "create", type: type!, fields: { ...assignments(await b.schema(), type!, rest), $id: id! } };
      for (const k of ["sheet", "pack", "after"] as const) if (p.values[k] !== undefined) patch[k] = p.values[k] as string;
      const w = await b.patch([patch]);
      const e = await b.get(id!).catch(() => null);
      return wrote(w, `Created ${type} ${id}${e && "$sheet" in e ? ` on ${e.$sheet}` : ""}.`);
    }

    case "comment-out":
    case "uncomment":
    case "delete": {
      const p = parse(args, { task: { type: "string" } });
      const [id] = positionals(p, ["id"]);
      const op = cmd === "delete" ? "delete" : cmd === "uncomment" ? "uncomment" : "commentOut";
      const w = await backend(p, io).b.patch([{ op, id: id! }]);
      return wrote(w, `${cmd === "delete" ? "Deleted" : cmd === "uncomment" ? "Uncommented" : "Commented out"} ${id}.`);
    }

    case "apply": {
      const p = parse(args, { task: { type: "string" } });
      const [path] = positionals(p, ["patch.jsonl"]);
      const patches: Patch[] = [];
      for (const [i, line] of readFileSync(resolve(io.cwd, path!), "utf8").split(/\r?\n/).entries()) {
        if (line.trim() === "") continue;
        try {
          patches.push(JSON.parse(line) as Patch);
        } catch (e) {
          throw new UsageError(`${path} line ${i + 1}: ${(e as Error).message}`);
        }
      }
      const w = await backend(p, io).b.patch(patches);
      return wrote(w, `Applied ${plural(patches.length, "patch", "patches")}.`);
    }

    case "schema": {
      const [sub, ...rest] = args;
      if (sub === "get") {
        const p = parse(rest, READ);
        positionals(p, []);
        io.out((await backend(p, io).b.schemaYaml()).trimEnd());
        return 0;
      }
      if (sub === "apply") {
        const p = parse(rest, { task: { type: "string" }, force: { type: "boolean" } });
        const [path] = positionals(p, ["file"]);
        const text = readFileSync(resolve(io.cwd, path!), "utf8");
        const c = await backend(p, io).b.applySchema(text, p.values.force === true);
        if (!c.changed) io.out("The schema is unchanged.");
        else wrote(c, "Schema updated.");
        if (c.scratch.length) io.out(`Cells of removed fields, scratch now: ${c.scratch.map(where).join(", ")}`);
        if (c.rules.length) io.out(`Rules that mention an old name, left as they are: ${c.rules.join(", ")}`);
        for (const n of c.notes) io.out(`Note: ${n}.`);
        return 0;
      }
      throw new UsageError(sub === undefined ? "Expected schema get or schema apply <file>" : `Unknown command schema ${sub}`);
    }

    case "validate": {
      const p = parse(args, { ...READ, json: { type: "boolean" } });
      positionals(p, []);
      const v = await backend(p, io).b.validate();
      if (p.values.json) io.out(JSON.stringify(v, null, 2));
      else for (const line of issueLines(v)) io.out(line);
      return v.errors ? 1 : 0;
    }

    case "export": {
      const p = parse(args, { ...READ, out: { type: "string" }, "allow-invalid": { type: "boolean" } });
      positionals(p, []);
      if (p.values.out === undefined) throw new UsageError("Expected --out <dir>");
      const files = await backend(p, io, { head: true }).b.export(p.values["allow-invalid"] === true);
      const out = resolve(io.cwd, p.values.out as string);
      for (const f of files) {
        const path = join(out, f.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.content);
      }
      io.out(`Exported ${plural(files.length, "file")} to ${out}.`);
      return 0;
    }

    case "login":
      return login(args, io);
    case "logout": {
      const p = parse(args);
      positionals(p, []);
      const file = configPath(envOf(io));
      const config = readConfig(file);
      const server = p.values.server !== undefined ? serverUrl(p.values.server as string) : config.default;
      if (server === undefined || !config.servers[server]) throw new UsageError("Not logged in to a server");
      delete config.servers[server];
      if (config.default === server) delete config.default;
      writeConfig(file, config);
      io.out(`Logged out of ${server}.`);
      return 0;
    }
    case "whoami": {
      const p = parse(args);
      positionals(p, []);
      const r = remote(p, io);
      const me = await r.client.json<{ login: string; role: string; scopes: Record<string, unknown> }>("GET", "/api/me");
      const limits = Object.entries(me.scopes).map(([k, v]) => (v === true ? k : `${k} ${Array.isArray(v) ? v.join(",") : String(v)}`));
      io.out(`${me.login} (${me.role}) on ${r.server}, branch ${r.branch}${limits.length ? `; this token: ${limits.join(", ")}` : ""}.`);
      return 0;
    }
    case "branch":
      return branch(args, io);
    case "task":
      return task(args, io);
    case "log": {
      const p = parse(args, { count: { type: "string", short: "n" } });
      positionals(p, [], true);
      const r = remote(p, io);
      const name = p.positionals[0] ?? r.branch;
      const n = p.values.count === undefined ? 20 : Number(p.values.count);
      if (!Number.isInteger(n) || n < 1) throw new UsageError("-n takes a whole number of commits");
      for (const c of await r.client.json<CommitJson[]>("GET", `/api/branches/${enc(name)}/commits?limit=${n}`))
        io.out(`${c.id.slice(0, 8)}  ${c.at.slice(0, 16).replace("T", " ")}  ${c.author}  ${c.message}${c.parents.length > 1 ? "  (two parents)" : ""}`);
      return 0;
    }
    case "revert":
    case "restore": {
      const p = parse(args);
      const [commit] = positionals(p, ["commit"]);
      const r = remote(p, io);
      const s =
        cmd === "revert"
          ? await r.client.json<StatusJson>("POST", `/api/commits/${enc(commit!)}/revert`, { branch: r.branch })
          : await r.client.json<StatusJson>("POST", `/api/branches/${enc(r.branch)}/restore`, { commit });
      const t = s.task;
      io.out(`Task ${t.id}: ${t.name}. It's now your current task on ${t.branch}.`);
      if (s.conflicts.length) {
        io.out(`Later changes conflict with it; settle them with --resolve <n>=mine|theirs on task land (mine is the ${cmd}):`);
        for (const line of conflictLines(s.conflicts)) io.out(line);
      } else if (s.validation.errors) io.out(`It would leave ${plural(s.validation.errors, "validation error")}; fix them in the task, then land it.`);
      else io.out("Check it with sapwood task status, then land it with sapwood task land.");
      return 0;
    }
    case "undo":
    case "redo": {
      const p = parse(args, { task: { type: "string" } });
      positionals(p, []);
      const r = remote(p, io);
      const t = p.values.task !== undefined ? taskId(p.values.task as string) : (await currentTask(r)).id;
      const res = await r.client.json<{ done: boolean; task: TaskJson }>("POST", `/api/tasks/${t}/${cmd}`);
      io.out(res.done ? `${cmd === "undo" ? "Undid" : "Redid"} a change in task ${t}: ${plural(res.task.changes, "change")} now.` : `Nothing to ${cmd} in task ${t}.`);
      return 0;
    }
    case "token": {
      const [sub, ...rest] = args;
      if (sub !== "create") throw new UsageError("Expected token create --name <name>");
      const p = parse(rest, { name: { type: "string" }, role: { type: "string" }, "read-only": { type: "boolean" }, "no-land": { type: "boolean" }, "only-branch": { type: "string", multiple: true }, expires: { type: "string" } });
      positionals(p, []);
      if (p.values.name === undefined) throw new UsageError("Expected --name <name>");
      const scopes: Record<string, unknown> = {};
      if (p.values.role !== undefined) scopes.role = p.values.role;
      if (p.values["read-only"]) scopes.readOnly = true;
      if (p.values["no-land"]) scopes.noLand = true;
      if (p.values["only-branch"]) scopes.branches = p.values["only-branch"];
      const r = remote(p, io);
      const made = await r.client.json<{ token: string }>("POST", "/api/tokens", { name: p.values.name, scopes, expires: p.values.expires });
      io.out(made.token);
      return 0;
    }

    default:
      throw new UsageError(`Unknown command ${cmd}`);
  }
}

// ------------------------------------------------------------ server commands

interface DeviceJson {
  device: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

/** Sign in with GitHub's device flow: a code to enter at GitHub, then a token from the server. */
async function deviceLogin(server: string, name: string, io: Io): Promise<string> {
  const anon = new Client(server, "", io.fetch ?? fetch);
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const d = await anon.json<DeviceJson>("POST", "/auth/device");
  io.out(`To sign in, open ${d.verificationUri} and enter the code ${d.userCode}`);
  io.out("Waiting for GitHub…");
  let interval = d.interval;
  const until = Date.now() + d.expiresIn * 1000;
  for (;;) {
    await sleep(interval * 1000);
    const r = await anon.json<{ token?: string; pending?: boolean; interval?: number | null }>("POST", "/auth/device/token", { device: d.device, name });
    if (r.token) return r.token;
    if (r.interval) interval = r.interval;
    if (Date.now() > until) throw new UsageError("The code expired before it was entered: run sapwood login again");
  }
}

async function login(args: string[], io: Io): Promise<number> {
  const p = parse(args, { token: { type: "string" }, name: { type: "string" } });
  positionals(p, []);
  const env = envOf(io);
  const given = (p.values.server as string | undefined) ?? env.SAPWOOD_SERVER;
  if (given === undefined) throw new UsageError("Expected --server <url>");
  const server = serverUrl(given);
  const token =
    (p.values.token as string | undefined) ?? env.SAPWOOD_TOKEN ?? (await deviceLogin(server, (p.values.name as string | undefined) ?? `sapwood login on ${hostname()}`, io));
  const me = await new Client(server, token, io.fetch ?? fetch).json<{ login: string; role: string }>("GET", "/api/me");
  const file = configPath(env);
  const config = readConfig(file);
  const login: Config["servers"][string] = { ...config.servers[server], token };
  if (p.values.branch !== undefined) login.branch = p.values.branch as string;
  config.servers[server] = login;
  config.default = server;
  writeConfig(file, config);
  io.out(`Logged in to ${server} as ${me.login} (${me.role}).`);
  return 0;
}

interface BranchJson {
  name: string;
  head: string;
  parent: string | null;
  archived: boolean;
}

async function branch(args: string[], io: Io): Promise<number> {
  const [sub = "list", ...rest] = args;
  const b = (name: string) => `/api/branches/${enc(name)}`;
  switch (sub) {
    case "list": {
      const p = parse(rest, { all: { type: "boolean" } });
      positionals(p, []);
      const r = remote(p, io);
      for (const x of await r.client.json<BranchJson[]>("GET", `/api/branches${p.values.all ? "?archived=1" : ""}`))
        io.out(`${x.name === r.branch ? "*" : " "} ${x.name}  head ${x.head.slice(0, 8)}${x.parent ? `  from ${x.parent}` : ""}${x.archived ? "  (discarded)" : ""}`);
      return 0;
    }
    case "create": {
      const p = parse(rest, { from: { type: "string" } });
      const [name] = positionals(p, ["name"]);
      const r = remote(p, io);
      const from = (p.values.from as string | undefined) ?? r.branch;
      await r.client.json("POST", "/api/branches", { name, from });
      io.out(`Created branch ${name} from ${from}. Work on it with sapwood branch switch ${name}.`);
      return 0;
    }
    case "switch": {
      const p = parse(rest);
      const [name] = positionals(p, ["name"]);
      const r = remote(p, io);
      const x = await r.client.json<BranchJson>("GET", b(name!));
      if (x.archived) throw new UsageError(`Branch ${name} is discarded`);
      r.config.servers[r.server] = { ...r.config.servers[r.server]!, branch: name! };
      writeConfig(r.configFile, r.config);
      io.out(`Now on branch ${name}.`);
      return 0;
    }
    case "status": {
      const p = parse(rest);
      positionals(p, [], true);
      const r = remote(p, io);
      const name = p.positionals[0] ?? r.branch;
      const s = await r.client.json<{ branch: BranchJson; behind: number; ahead: number; conflicts: ConflictJson[] }>("GET", `${b(name)}/compare`);
      if (s.branch.parent === null) {
        io.out(`${name} has no parent: it's the root branch.`);
        return 0;
      }
      io.out(`${name}: ${plural(s.ahead, "commit")} to merge into ${s.branch.parent}, ${plural(s.behind, "commit")} of ${s.branch.parent}'s to sync.`);
      if (s.conflicts.length) {
        io.out(`Conflicts a sync would have (mine is ${name}), to settle with --resolve <n>=mine|theirs on branch sync or branch merge:`);
        for (const line of conflictLines(s.conflicts)) io.out(line);
      }
      return 0;
    }
    case "sync":
    case "merge": {
      const p = parse(rest, { resolve: { type: "string", multiple: true }, message: { type: "string", short: "m" } });
      positionals(p, [], true);
      const r = remote(p, io);
      const name = p.positionals[0] ?? r.branch;
      const asked = (p.values.resolve as string[] | undefined) ?? [];
      const body: Record<string, unknown> = {};
      if (asked.length) body.resolutions = resolveArgs(asked, (await r.client.json<{ conflicts: ConflictJson[] }>("GET", `${b(name)}/compare`)).conflicts, name);
      if (sub === "sync") {
        const res = await r.client.json<{ commit: { id: string } | null; dropped: ConflictJson[] }>("POST", `${b(name)}/sync`, body);
        io.out(res.commit ? `Synced ${name} from its parent as commit ${res.commit.id}.` : `${name} is up to date with its parent.`);
        for (const d of res.dropped) io.out(`Dropped, no longer applies: ${d.id}`);
      } else {
        if (p.values.message !== undefined) body.message = p.values.message;
        const res = await r.client.json<{ sync: { id: string } | null; merge: { id: string; branch: string }; dropped: ConflictJson[] }>("POST", `${b(name)}/merge`, body);
        if (res.sync) io.out(`Synced ${name} first, as commit ${res.sync.id}.`);
        io.out(`Merged ${name} into ${res.merge.branch} as commit ${res.merge.id}.`);
        for (const d of res.dropped) io.out(`Dropped, no longer applies: ${d.id}`);
      }
      return 0;
    }
    case "discard": {
      const p = parse(rest);
      const [name] = positionals(p, ["name"]);
      const r = remote(p, io);
      await r.client.json("DELETE", b(name!));
      io.out(`Discarded branch ${name}; it is kept, and can still be read.`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown command branch ${sub}`);
  }
}

interface CommitJson {
  id: string;
  parents: string[];
  author: string;
  message: string;
  at: string;
}

interface ConflictJson {
  id: string;
  where?: CellAddress;
  conflict: { kind: string; mine?: unknown; theirs?: unknown };
}

interface StatusJson {
  task: TaskJson;
  behind: number;
  conflicts: ConflictJson[];
  validation: { errors: number; warnings: number };
}

async function currentTask(r: Remote): Promise<TaskJson> {
  const t = await r.client.json<TaskJson | null>("GET", `/api/branches/${enc(r.branch)}/tasks/current`);
  if (!t) throw new UsageError(`You have no current task on ${r.branch}: your first edit starts one, or run sapwood task new`);
  return t;
}

async function task(args: string[], io: Io): Promise<number> {
  const [sub = "status", ...rest] = args;
  const RESOLVE = { resolve: { type: "string", multiple: true } } as const;
  /** The task named by a positional ID, else your current one. */
  const which = async (p: Parsed, r: Remote): Promise<number> => (p.positionals[0] !== undefined ? taskId(p.positionals[0]) : (await currentTask(r)).id);
  const status = (r: Remote, id: number) => r.client.json<StatusJson>("GET", `/api/tasks/${id}`);
  /** `--resolve 2=mine`, `--resolve all=theirs`, or by conflict ID: `--resolve "cell s1/r1|c3=mine"`. */
  const resolutions = async (p: Parsed, r: Remote, id: number): Promise<Record<string, string>> => {
    const asked = (p.values.resolve as string[] | undefined) ?? [];
    return asked.length ? resolveArgs(asked, (await status(r, id)).conflicts, `Task ${id}`) : {};
  };

  switch (sub) {
    case "status": {
      const p = parse(rest);
      positionals(p, [], true);
      const r = remote(p, io);
      const s = await status(r, await which(p, r));
      const t = s.task;
      io.out(`Task ${t.id}${t.name ? ` "${t.name}"` : ""} on ${t.branch}, ${t.state}, ${t.owner}'s: ${plural(t.changes, "change")}${t.canRedo ? ", some undone" : ""}.`);
      if (t.state === "open") {
        io.out(s.behind ? `${plural(s.behind, "commit")} behind ${t.branch}.` : `Up to date with ${t.branch}.`);
        io.out(`Validation: ${plural(s.validation.errors, "error")}, ${plural(s.validation.warnings, "warning")}.`);
      }
      if (s.conflicts.length) {
        io.out(`Conflicts, to settle with --resolve <n>=mine|theirs on task rebase or task land:`);
        for (const line of conflictLines(s.conflicts)) io.out(line);
      }
      return 0;
    }
    case "new": {
      const p = parse(rest);
      const name = p.positionals.join(" ");
      const r = remote(p, io);
      const t = await r.client.json<TaskJson>("POST", `/api/branches/${enc(r.branch)}/tasks`, name ? { name } : {});
      io.out(`Started task ${t.id} on ${t.branch}; it's your current task there.`);
      return 0;
    }
    case "list": {
      const p = parse(rest, { all: { type: "boolean" } });
      positionals(p, []);
      const r = remote(p, io);
      const mine = await r.client.json<TaskJson | null>("GET", `/api/branches/${enc(r.branch)}/tasks/current`);
      const list = await r.client.json<TaskJson[]>("GET", `/api/branches/${enc(r.branch)}/tasks${p.values.all ? "" : "?state=open"}`);
      for (const t of list) io.out(`${t.id === mine?.id ? "*" : " "} ${t.id}  ${t.state}  ${t.owner}  ${plural(t.changes, "change")}${t.name ? `  ${t.name}` : ""}`);
      return 0;
    }
    case "switch": {
      const p = parse(rest);
      const [id] = positionals(p, ["id"]);
      const r = remote(p, io);
      const t = await r.client.json<TaskJson>("POST", `/api/tasks/${taskId(id!)}/switch`);
      io.out(`Task ${t.id} is now your current task on ${t.branch}.`);
      return 0;
    }
    case "name": {
      const p = parse(rest, { task: { type: "string" } });
      positionals(p, ["name"], true);
      const r = remote(p, io);
      const id = p.values.task !== undefined ? taskId(p.values.task as string) : (await currentTask(r)).id;
      await r.client.json("PATCH", `/api/tasks/${id}`, { name: p.positionals.join(" ") });
      io.out(`Named task ${id}.`);
      return 0;
    }
    case "rebase": {
      const p = parse(rest, RESOLVE);
      positionals(p, [], true);
      const r = remote(p, io);
      const id = await which(p, r);
      const res = await r.client.json<{ task: TaskJson; dropped: ConflictJson[] }>("POST", `/api/tasks/${id}/rebase`, { resolutions: await resolutions(p, r, id) });
      io.out(`Task ${id} is up to date with ${res.task.branch}: ${plural(res.task.changes, "change")}.`);
      for (const d of res.dropped) io.out(`Dropped, no longer applies: ${d.id}`);
      return 0;
    }
    case "land": {
      const p = parse(rest, { ...RESOLVE, message: { type: "string", short: "m" } });
      positionals(p, [], true);
      const r = remote(p, io);
      const id = await which(p, r);
      const body: Record<string, unknown> = { resolutions: await resolutions(p, r, id) };
      if (p.values.message !== undefined) body.message = p.values.message;
      const res = await r.client.json<{ commit: { id: string; branch: string }; dropped: ConflictJson[] }>("POST", `/api/tasks/${id}/land`, body);
      io.out(`Landed task ${id} on ${res.commit.branch} as commit ${res.commit.id}.`);
      for (const d of res.dropped) io.out(`Dropped, no longer applies: ${d.id}`);
      return 0;
    }
    case "abandon":
    case "reopen": {
      const p = parse(rest);
      positionals(p, [], true);
      const r = remote(p, io);
      if (sub === "reopen" && p.positionals[0] === undefined) throw new UsageError("Expected task reopen <id>");
      const id = await which(p, r);
      await r.client.json("POST", `/api/tasks/${id}/${sub}`);
      io.out(sub === "abandon" ? `Abandoned task ${id}; task reopen ${id} brings it back.` : `Reopened task ${id}; it's your current task.`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown command task ${sub}`);
  }
}

/** `--resolve 2=mine`, `--resolve all=theirs`, or by conflict ID: `--resolve "cell s1/r1|c3=mine"`. */
function resolveArgs(asked: string[], conflicts: ConflictJson[], what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of asked) {
    const i = a.lastIndexOf("=");
    const key = a.slice(0, i);
    const side = a.slice(i + 1);
    if (i < 0 || (side !== "mine" && side !== "theirs")) throw new UsageError(`Expected --resolve <n>=mine or <n>=theirs: got ${a}`);
    if (key === "all") for (const c of conflicts) out[c.id] ??= side;
    else if (/^\d+$/.test(key)) {
      const c = conflicts[Number(key) - 1];
      if (!c) throw new UsageError(`${what} has ${plural(conflicts.length, "conflict")}: no conflict ${key}`);
      out[c.id] = side;
    } else out[key] = side;
  }
  return out;
}

// ------------------------------------------------------------ output

function issueLines(v: ValidationJson): string[] {
  const out = v.issues.map((i) => {
    const place = i.sheet === undefined ? "" : ` ${i.sheet}!${i.cell ?? i.row ?? ""}`;
    const who = i.entity?.id ? ` (${i.entity.id})` : "";
    return `${i.level}${place}${who} ${i.code}: ${i.message}`;
  });
  out.push(`${plural(v.errors, "error")}, ${plural(v.warnings, "warning")}.`);
  return out;
}

/** A cell's content as typed: a value, or that it's a formula. */
function shown(c: unknown): string {
  if (c === null || c === undefined) return "(blank)";
  if (typeof c === "object" && "v" in c) return JSON.stringify((c as { v: unknown }).v);
  if (typeof c === "object" && "bad" in c) return String((c as { bad: unknown }).bad);
  return typeof c === "object" && "f" in c ? "a formula" : JSON.stringify(c);
}

function conflictLines(cs: ConflictJson[]): string[] {
  return cs.map((c, i) => {
    const k = c.conflict;
    const detail = k.kind === "cell" && c.where ? `${c.where.sheet}!${c.where.cell}: mine ${shown(k.mine)}, theirs ${shown(k.theirs)}` : c.id;
    return `  ${i + 1}. ${detail}`;
  });
}
