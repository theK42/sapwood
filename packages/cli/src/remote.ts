// The CLI against a Sapwood server: the saved login, an HTTP client, and the backend the
// data commands use. Reads come from your current task on the branch (your edits so
// far), or the branch head when you have none; writes go into your current task.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseSchema, resolveSchema,
  type EntityJson, type ExportFile, type Patch, type ResolvedSchema, type ValidationJson,
} from "@thek42/sapwood-core";
import type { Backend, QueryArgs, Readable, SchemaWritten, Written } from "./backend.ts";
import { UsageError } from "./values.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// ------------------------------------------------------------ the saved login

export interface ServerLogin {
  token: string;
  /** The branch commands work on, set by `branch switch` (default main). */
  branch?: string;
}

export interface Config {
  /** The server used when none is given. */
  default?: string;
  servers: Record<string, ServerLogin>;
}

export function configPath(env: Record<string, string | undefined>): string {
  return env.SAPWOOD_CONFIG ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), ".sapwood", "config.json");
}

export function readConfig(path: string): Config {
  if (!existsSync(path)) return { servers: {} };
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as Config;
    return { ...c, servers: c.servers ?? {} };
  } catch (e) {
    throw new UsageError(`Can't read ${path}: ${(e as Error).message}`);
  }
}

/** Saved readable by you only: it holds tokens. */
export function writeConfig(path: string, c: Config): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** `host:8417`, `http://host:8417/`, `http://host:8417/api` all mean http://host:8417. */
export function serverUrl(text: string): string {
  let t = text.trim().replace(/\/+$/, "").replace(/\/api$/, "");
  if (!/^https?:\/\//.test(t)) t = `http://${t}`;
  try {
    return new URL(t).origin;
  } catch {
    throw new UsageError(`Not a server address: ${text}`);
  }
}

// ------------------------------------------------------------ the client

/** The server refused a request. */
export class ServerError extends Error {
  override name = "ServerError";
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export class Client {
  readonly server: string;
  private readonly token: string;
  private readonly fetch: Fetch;

  constructor(server: string, token: string, fetch: Fetch) {
    this.server = server;
    this.token = token;
    this.fetch = fetch;
  }

  async json<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await this.text(method, path, body);
    return (text === "" ? null : JSON.parse(text)) as T;
  }

  async text(method: string, path: string, body?: unknown): Promise<string> {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await this.fetch(`${this.server}${path}`, init);
    } catch (e) {
      throw new Error(`Can't reach ${this.server}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (res.ok) return text;
    let err: { code?: string; message?: string } & Record<string, unknown> = {};
    try {
      err = (JSON.parse(text) as { error?: typeof err }).error ?? {};
    } catch {
      // not JSON
    }
    const { code = `http-${res.status}`, message = `${res.status} ${res.statusText}`, ...detail } = err;
    throw new ServerError(res.status, code, message, detail);
  }
}

export const enc = encodeURIComponent;

// ------------------------------------------------------------ the backend

export interface TaskJson {
  id: number;
  branch: string;
  owner: string;
  name: string | null;
  base: string;
  state: string;
  landedCommit: string | null;
  changes: number;
  canUndo: boolean;
  canRedo: boolean;
}

/** Where reads come from. */
export type ReadAt = { current: true } | { head: true } | { task: number } | { commit: string };

export class RemoteBackend implements Backend {
  readonly client: Client;
  readonly branch: string;
  private readonly at: ReadAt;
  private readonly writeTask: number | undefined;
  private place: string | undefined;
  private resolved: ResolvedSchema | undefined;

  constructor(client: Client, branch: string, at: ReadAt, writeTask?: number) {
    this.client = client;
    this.branch = branch;
    this.at = at;
    this.writeTask = writeTask;
  }

  /** The path prefix reads go to. */
  private async readPlace(): Promise<string> {
    if (this.place !== undefined) return this.place;
    const b = `/api/branches/${enc(this.branch)}`;
    if ("task" in this.at) this.place = `/api/tasks/${this.at.task}`;
    else if ("commit" in this.at) this.place = `/api/commits/${enc(this.at.commit)}`;
    else if ("head" in this.at) this.place = b;
    else {
      const t = await this.client.json<TaskJson | null>("GET", `${b}/tasks/current`);
      this.place = t ? `/api/tasks/${t.id}` : b;
    }
    return this.place;
  }

  private writePlace(): string {
    return this.writeTask === undefined ? `/api/branches/${enc(this.branch)}` : `/api/tasks/${this.writeTask}`;
  }

  /** Reads of your current task now find the one the write went into (it may be new). */
  private wroteTo(task: number): void {
    if ("current" in this.at) this.place = `/api/tasks/${task}`;
    this.resolved = undefined;
  }

  async get(id: string): Promise<Readable> {
    const p = await this.readPlace();
    try {
      return await this.client.json<EntityJson>("GET", `${p}/entities/${enc(id)}`);
    } catch (e) {
      if (e instanceof ServerError && e.code === "singleton") return this.client.json("GET", `${p}/singletons/${enc(id)}`);
      throw e;
    }
  }

  async query(type: string, q: QueryArgs): Promise<EntityJson[]> {
    const params = new URLSearchParams();
    for (const w of q.where) params.append("where", w);
    if (q.pack !== undefined) params.set("pack", q.pack);
    if (q.inactive) params.set("inactive", "1");
    const qs = params.toString();
    return this.client.json("GET", `${await this.readPlace()}/query/${enc(type)}${qs ? `?${qs}` : ""}`);
  }

  async schema(): Promise<ResolvedSchema> {
    if (!this.resolved) this.resolved = resolveSchema(parseSchema(await this.schemaYaml()).schema);
    return this.resolved;
  }

  async schemaYaml(): Promise<string> {
    return this.client.text("GET", `${await this.readPlace()}/schema`);
  }

  async patch(patches: Patch[]): Promise<Written> {
    const r = await this.client.json<{ task: TaskJson; formulas: Written["formulas"] }>("POST", `${this.writePlace()}/patches`, patches);
    this.wroteTo(r.task.id);
    return { formulas: r.formulas, task: r.task.id };
  }

  async applySchema(yaml: string, force: boolean): Promise<SchemaWritten> {
    const r = await this.client.json<{ task: TaskJson; ops: number } & Omit<SchemaWritten, "changed" | "task">>("POST", `${this.writePlace()}/schema`, { yaml, force });
    this.wroteTo(r.task.id);
    return { changed: r.ops > 0, formulas: r.formulas, rules: r.rules, scratch: r.scratch, notes: r.notes, task: r.task.id };
  }

  async validate(): Promise<ValidationJson> {
    return this.client.json("GET", `${await this.readPlace()}/validate`);
  }

  async export(allowInvalid: boolean): Promise<ExportFile[]> {
    const p = await this.readPlace();
    const q = allowInvalid ? "?allowInvalid=1" : "";
    const list = await this.client.json<{ files: { path: string }[] }>("GET", `${p}/export${q}`);
    const out: ExportFile[] = [];
    for (const f of list.files) out.push({ path: f.path, content: await this.client.text("GET", `${p}/export/${f.path.split("/").map(enc).join("/")}${q}`) });
    return out;
  }
}
