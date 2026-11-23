// The MCP server (DESIGN §9.4): an LLM reads and edits a Sapwood project through it, on a
// server or in a local project file, like the CLI. On a server its edits go into your
// current task on the branch, as yours from the CLI do; it has no tools to land, merge
// or discard, so a person always lands what it did.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { ApiError, type Patch, type ValidationJson } from "@thek42/sapwood-core";
import { LocalBackend, type Backend, type Written } from "@thek42/sapwood-cli/backend";
import { Client, configPath, enc, readConfig, RemoteBackend, serverUrl, ServerError, writeConfig, type Fetch, type TaskJson } from "@thek42/sapwood-cli/remote";
import { findProject, loadProjectFile, PROJECT_FILE } from "@thek42/sapwood-cli/store";
import { UsageError } from "@thek42/sapwood-cli/values";

export const MCP_VERSION = "0.0.0";

export interface ConnectOptions {
  /** A project file, or a folder holding one. */
  project?: string;
  /** A server you've logged in to with `sapwood login`. */
  server?: string;
  /** The branch (default: the one `sapwood branch switch` saved, else main). */
  branch?: string;
}

export interface McpIo {
  cwd: string;
  env: Record<string, string | undefined>;
  fetch?: Fetch;
}

/** Where the tools work. Each tool call looks again, so `sapwood branch switch` or a new login takes effect at once. */
export interface Connection {
  /** Said to the LLM: what it's working on. */
  readonly where: string;
  backend(): Backend;
  /** On a server: the client and branch, for the task tools. */
  remote?(): { client: Client; branch: string };
  /** On a server: work on another branch from now on. Saved for the CLI too, as `sapwood branch switch` does, when the branch comes from your saved login. */
  switchBranch?(name: string): { saved: boolean };
}

/** The same choice the CLI makes: `--project`, else `--server` (or `$SAPWOOD_SERVER`), else a project file here or above, else the server last logged in to. */
export function connect(opts: ConnectOptions, io: McpIo): Connection {
  const env = io.env;
  const local = (file: string): Connection => ({ where: `the project file ${file}`, backend: () => new LocalBackend(file, loadProjectFile(file)) });
  if (opts.project !== undefined) return local(findProject(io.cwd, opts.project));
  const given = opts.server ?? env.SAPWOOD_SERVER;
  if (given === undefined) {
    try {
      return local(findProject(io.cwd));
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
    }
  }
  const server = given !== undefined ? serverUrl(given) : readConfig(configPath(env)).default;
  if (server === undefined) throw new UsageError(`No ${PROJECT_FILE} here or in any folder above, and no server logged in to: run sapwood login --server <url>`);
  /** A branch switched to here, when it can't be saved: --branch or $SAPWOOD_BRANCH fixed it, or there's no saved login. */
  let switched: string | undefined;
  const remote = () => {
    const saved = readConfig(configPath(env)).servers[server];
    const token = env.SAPWOOD_TOKEN ?? saved?.token;
    if (token === undefined) throw new UsageError(`Not logged in to ${server}: run sapwood login --server ${server}`);
    return { client: new Client(server, token, io.fetch ?? fetch), branch: switched ?? opts.branch ?? env.SAPWOOD_BRANCH ?? saved?.branch ?? "main" };
  };
  remote(); // logged in, or say so now
  return {
    where: `the Sapwood server ${server}`,
    backend: () => {
      const r = remote();
      return new RemoteBackend(r.client, r.branch, { current: true });
    },
    remote,
    switchBranch: (name) => {
      const file = configPath(env);
      const config = readConfig(file);
      const saved = config.servers[server];
      if (switched === undefined && opts.branch === undefined && env.SAPWOOD_BRANCH === undefined && saved) {
        config.servers[server] = { ...saved, branch: name };
        writeConfig(file, config);
        return { saved: true };
      }
      switched = name;
      return { saved: false };
    },
  };
}

// ------------------------------------------------------------ the tools

const LIMIT = 100;

const fields = z.record(z.string(), z.unknown()).describe('Field name to value. Null clears a field; {"$formula": "=…"} writes a formula.');
const PATCH = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set"),
    id: z.string(),
    fields: fields.describe('Fields to change; the rest stay. "$id" renames the entity (mentions are rewritten), "$active": false comments it out.'),
    force: z.boolean().optional().describe("Overwrite a field backed by a formula"),
  }),
  z.object({
    op: z.literal("create"),
    type: z.string(),
    fields: fields.describe('The new entity\'s fields, with its ID as "$id".'),
    sheet: z.string().optional().describe("The sheet to put it on (default: after the last entity of its type)"),
    pack: z.string().optional(),
    after: z.string().optional().describe("Put it right after this entity"),
  }),
  z.object({ op: z.enum(["commentOut", "uncomment", "delete"]), id: z.string() }),
  z.object({
    op: z.literal("setSingleton"),
    type: z.string().describe("The singleton's type: singletons have no ID"),
    fields,
    force: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("createPack"),
    name: z.string().describe("A new pack's name, unique; content packs such as DLC hold their own sheets"),
    parent: z.string().optional().describe("The pack it goes in (default: root)"),
  }),
  z.object({
    op: z.literal("createSheet"),
    name: z.string().describe("A new sheet's name, unique in its pack"),
    pack: z.string().optional().describe("Its pack (default: root)"),
    kind: z.enum(["data", "scratch"]).optional().describe("data (the default) holds entities; scratch holds notes and working"),
  }),
]);

const INSTRUCTIONS = `Sapwood holds a game's data: entities of types the schema defines, kept in spreadsheet sheets, with formulas and validation.

- Read the schema first (the schema tool) to know the types, their fields and the rules.
- Read with get and query. Entities come as JSON: "$type", "$id", "$pack", "$sheet", "$active", then fields. A field backed by a formula shows {"$value", "$formula"}.
- Change things with patch: a list of patches applied all or nothing, as one change. Prefer one patch call with several patches to many calls.
- Packs: entities in a pack may refer to entities in it and in the packs above it, not below. To add content in a new pack (a DLC), make the pack and a sheet in it (createPack, createSheet), then create entities with that sheet and pack. Making a pack needs a Developer's token.
- Errors come with a code in brackets ([not-found], [bad-value], [formula], …) and a message saying what to fix.
- After editing, check validate: a change with validation errors can't land.
- On a server, your edits go into the user's current task on the branch, alongside theirs. You can't land, merge or discard: the user reviews the task and lands it. undo takes back the last change in the task, yours or theirs.
- Work in the current task and branch unless the user asks otherwise. Start a task (task_new) or a branch (branch_create), or switch to another (task_switch, branch_switch), only when asked: a switch changes where the user's own edits go too.`;

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A refusal, as the LLM can act on it: the message, the code, and any conflicts or validation. */
function failed(e: unknown): CallToolResult {
  let t: string;
  if (e instanceof ApiError || e instanceof ServerError) {
    t = `${e.message} [${e.code}]`;
    const detail = e instanceof ServerError ? e.detail : {};
    if (detail.conflicts) t += `\nConflicts: ${JSON.stringify(detail.conflicts)}`;
    if (detail.validation) t += `\nValidation: ${JSON.stringify(trimmed(detail.validation as ValidationJson))}`;
  } else t = (e as Error).message ?? String(e);
  return { content: [{ type: "text", text: t }], isError: true };
}

function trimmed(v: ValidationJson): ValidationJson & { shown?: string } {
  if (v.issues.length <= LIMIT) return v;
  return { ...v, issues: v.issues.slice(0, LIMIT), shown: `the first ${LIMIT} of ${v.issues.length} issues` };
}

/** Run a tool, turning a refusal into a tool error rather than a protocol one. */
const guard =
  <A>(fn: (a: A) => Promise<CallToolResult>) =>
  async (a: A): Promise<CallToolResult> => {
    try {
      return await fn(a);
    } catch (e) {
      return failed(e);
    }
  };

/** What a write did, and what it left to check. */
async function wrote(b: Backend, w: Written, what: string): Promise<CallToolResult> {
  const lines = [w.task === undefined ? what : `${what.replace(/\.$/, "")} (in task ${w.task}).`];
  if (w.formulas.length) lines.push(`Formulas that mention the old name, left as they are: ${w.formulas.map((a) => `${a.sheet}!${a.cell}`).join(", ")}`);
  const v = await b.validate();
  lines.push(`Validation now: ${plural(v.errors, "error")}, ${plural(v.warnings, "warning")}.`);
  return text(lines.join("\n"));
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function createServer(conn: Connection): McpServer {
  const server = new McpServer(
    { name: "sapwood", version: MCP_VERSION },
    { instructions: `${INSTRUCTIONS}\n\nThis connection works on ${conn.where}.` },
  );

  server.registerTool(
    "get",
    {
      title: "Get an entity",
      description: "One entity by ID, as JSON. A singleton's type name stands in for an ID.",
      inputSchema: { id: z.string().describe("The entity's ID, or a singleton's type") },
      annotations: READ,
    },
    guard(async ({ id }) => json(await conn.backend().get(id))),
  );

  server.registerTool(
    "query",
    {
      title: "Find entities",
      description: `Entities of a type (or a trait), as JSON. At most ${LIMIT} unless limit says otherwise.`,
      inputSchema: {
        type: z.string().describe("A type or trait name"),
        where: z
          .array(z.string())
          .optional()
          .describe('Conditions that must all hold: field<op>value with =, !=, <, <=, >, >= or ~ (contains, ignoring case). "field=" matches a blank field; a list matches = when it has the value.'),
        pack: z.string().optional().describe("Only this content pack"),
        inactive: z.boolean().optional().describe("Include commented-out entities"),
        idsOnly: z.boolean().optional().describe("Just the IDs"),
        limit: z.number().int().positive().optional(),
      },
      annotations: READ,
    },
    guard(async ({ type, where, pack, inactive, idsOnly, limit }) => {
      const q: Parameters<Backend["query"]>[1] = { where: where ?? [] };
      if (pack !== undefined) q.pack = pack;
      if (inactive) q.inactive = true;
      const all = await conn.backend().query(type, q);
      const n = limit ?? LIMIT;
      const shown = idsOnly ? all.slice(0, n).map((e) => e.$id) : all.slice(0, n);
      return all.length > n ? json({ shown: `the first ${n} of ${all.length}`, entities: shown }) : json(shown);
    }),
  );

  server.registerTool(
    "schema",
    {
      title: "Read the schema",
      description: "The project's schema, as YAML: types, fields, traits, enums and validation rules.",
      annotations: READ,
    },
    guard(async () => text(await conn.backend().schemaYaml())),
  );

  server.registerTool(
    "validate",
    {
      title: "Validate",
      description: `Validation errors and warnings, each with its sheet, cell and entity. At most ${LIMIT} issues are listed.`,
      annotations: READ,
    },
    guard(async () => json(trimmed(await conn.backend().validate()))),
  );

  server.registerTool(
    "patch",
    {
      title: "Edit entities",
      description:
        "Apply patches, all or nothing, as one change: set fields, create, comment out, uncomment or delete entities, and set a singleton's fields. Values are checked as the cells would be read; a bad one refuses the whole call.",
      inputSchema: { patches: z.array(PATCH).min(1) },
      annotations: EDIT,
    },
    guard(async ({ patches }) => {
      const b = conn.backend();
      return wrote(b, await b.patch(patches as Patch[]), `Applied ${plural(patches.length, "patch", "patches")}.`);
    }),
  );

  server.registerTool(
    "apply_schema",
    {
      title: "Change the schema",
      description:
        "Replace the schema with this YAML, as one change. Renames are found and carried into the data. Removing a field that has data needs force; its cells become scratch.",
      inputSchema: { yaml: z.string().describe("The whole schema, edited from what the schema tool gave"), force: z.boolean().optional() },
      annotations: EDIT,
    },
    guard(async ({ yaml, force }) => {
      const b = conn.backend();
      const c = await b.applySchema(yaml, force === true);
      if (!c.changed) return text("The schema is unchanged.");
      const r = await wrote(b, c, "Schema updated.");
      const more: string[] = [];
      if (c.scratch.length) more.push(`Cells of removed fields, scratch now: ${c.scratch.map((a) => `${a.sheet}!${a.cell}`).join(", ")}`);
      if (c.rules.length) more.push(`Rules that mention an old name, left as they are: ${c.rules.join(", ")}`);
      for (const n of c.notes) more.push(`Note: ${n}.`);
      return more.length ? text(`${(r.content[0] as { text: string }).text}\n${more.join("\n")}`) : r;
    }),
  );

  if (conn.remote) {
    const remote = conn.remote.bind(conn);
    const current = async () => {
      const r = remote();
      return { ...r, task: await r.client.json<TaskJson | null>("GET", `/api/branches/${enc(r.branch)}/tasks/current`) };
    };

    server.registerTool(
      "task_status",
      {
        title: "The current task",
        description: "The user's current task on the branch, which edits go into: its changes, how far behind the branch it is, conflicts, and validation counts.",
        annotations: READ,
      },
      guard(async () => {
        const { client, branch, task } = await current();
        if (!task) return text(`There's no current task on ${branch} yet: the first edit starts one.`);
        return json(await client.json("GET", `/api/tasks/${task.id}`));
      }),
    );

    for (const which of ["undo", "redo"] as const) {
      server.registerTool(
        which,
        {
          title: which === "undo" ? "Undo" : "Redo",
          description: which === "undo" ? "Take back the last change in the current task (yours or the user's)." : "Make the last undone change in the current task again.",
          annotations: EDIT,
        },
        guard(async () => {
          const { client, branch, task } = await current();
          if (!task) return text(`There's no current task on ${branch}: nothing to ${which}.`);
          const r = await client.json<{ done: boolean; task: TaskJson }>("POST", `/api/tasks/${task.id}/${which}`);
          return text(r.done ? `${which === "undo" ? "Undid" : "Redid"} a change in task ${task.id}: ${plural(r.task.changes, "change")} now.` : `Nothing to ${which} in task ${task.id}.`);
        }),
      );
    }

    const brief = (t: TaskJson, current: number | undefined) => ({ id: t.id, name: t.name, owner: t.owner, state: t.state, changes: t.changes, ...(t.id === current ? { current: true } : {}) });
    const switchTo = (name: string) => {
      const { saved } = conn.switchBranch!(name);
      return saved ? `Now on branch ${name}, for the sapwood command too.` : `Now on branch ${name} here (the sapwood command keeps its own).`;
    };

    server.registerTool(
      "task_list",
      {
        title: "Tasks",
        description: "The open tasks on the branch, everyone's, with the user's current one marked.",
        inputSchema: { all: z.boolean().optional().describe("Landed and abandoned tasks too") },
        annotations: READ,
      },
      guard(async ({ all }) => {
        const { client, branch, task } = await current();
        const list = await client.json<TaskJson[]>("GET", `/api/branches/${enc(branch)}/tasks${all ? "" : "?state=open"}`);
        return json({ branch, tasks: list.map((t) => brief(t, task?.id)) });
      }),
    );

    server.registerTool(
      "task_new",
      {
        title: "Start a task",
        description: "Start a new task on the branch, from its head. It becomes the user's current task there, so later edits (theirs too) go into it. Only when the user asks.",
        inputSchema: { name: z.string().optional().describe("What the task is for") },
        annotations: EDIT,
      },
      guard(async ({ name }) => {
        const { client, branch } = remote();
        const t = await client.json<TaskJson>("POST", `/api/branches/${enc(branch)}/tasks`, name ? { name } : {});
        return text(`Started task ${t.id} on ${branch}; it's the current task there now.`);
      }),
    );

    server.registerTool(
      "task_switch",
      {
        title: "Switch tasks",
        description: "Make another open task of the user's their current one, so edits go into it. A task on another branch switches the branch too. Only when the user asks.",
        inputSchema: { id: z.number().int().positive().describe("The task's number") },
        annotations: EDIT,
      },
      guard(async ({ id }) => {
        const { client, branch } = remote();
        const t = await client.json<TaskJson>("POST", `/api/tasks/${id}/switch`);
        const lines = [`Task ${t.id} is now the current task on ${t.branch}.`];
        if (t.branch !== branch) lines.push(switchTo(t.branch));
        return text(lines.join("\n"));
      }),
    );

    server.registerTool(
      "task_name",
      {
        title: "Name the task",
        description: "Name the current task: what it's for.",
        inputSchema: { name: z.string() },
        annotations: EDIT,
      },
      guard(async ({ name }) => {
        const { client, branch, task } = await current();
        if (!task) return text(`There's no current task on ${branch} to name: the first edit starts one, or task_new.`);
        await client.json("PATCH", `/api/tasks/${task.id}`, { name });
        return text(`Named task ${task.id}.`);
      }),
    );

    interface BranchJson {
      name: string;
      head: string;
      parent: string | null;
      archived: boolean;
    }

    server.registerTool(
      "branch_list",
      {
        title: "Branches",
        description: "The branches, each with its parent, and the one being worked on marked.",
        annotations: READ,
      },
      guard(async () => {
        const { client, branch } = remote();
        const list = await client.json<BranchJson[]>("GET", "/api/branches");
        return json(list.map((b) => ({ name: b.name, parent: b.parent, head: b.head.slice(0, 8), ...(b.name === branch ? { current: true } : {}) })));
      }),
    );

    server.registerTool(
      "branch_create",
      {
        title: "Create a branch",
        description: "Create a branch from another's head (default: the current branch). Only when the user asks.",
        inputSchema: {
          name: z.string(),
          from: z.string().optional(),
          switch: z.boolean().optional().describe("Work on the new branch from now on"),
        },
        annotations: EDIT,
      },
      guard(async ({ name, from, switch: go }) => {
        const { client, branch } = remote();
        await client.json("POST", "/api/branches", { name, from: from ?? branch });
        const lines = [`Created branch ${name} from ${from ?? branch}.`];
        if (go) lines.push(switchTo(name));
        return text(lines.join("\n"));
      }),
    );

    server.registerTool(
      "branch_switch",
      {
        title: "Switch branches",
        description: "Work on another branch from now on: reads and edits go to the user's current task there. Only when the user asks.",
        inputSchema: { name: z.string() },
        annotations: EDIT,
      },
      guard(async ({ name }) => {
        const { client } = remote();
        const b = await client.json<BranchJson>("GET", `/api/branches/${enc(name)}`);
        if (b.archived) return { ...text(`Branch ${name} is discarded.`), isError: true };
        return text(switchTo(name));
      }),
    );

    server.registerTool(
      "log",
      {
        title: "History",
        description: "The branch's commits, newest first: ID, time, author and message.",
        inputSchema: { branch: z.string().optional().describe("Default: the branch edits go to"), count: z.number().int().positive().max(200).optional() },
        annotations: READ,
      },
      guard(async ({ branch, count }) => {
        const r = remote();
        return json(await r.client.json("GET", `/api/branches/${enc(branch ?? r.branch)}/commits?limit=${count ?? 20}`));
      }),
    );
  }

  return server;
}
