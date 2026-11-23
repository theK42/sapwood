// The server's HTTP API (DESIGN §9.4), as the web app uses it. Requests go to the page's own
// origin with the session cookie; writes carry the header the server asks of cookie writes.
// The shapes here mirror the server's (packages/server/src/repo.ts), which the app doesn't
// import: that code runs on Node.

import type { DocJson, Op } from "@thek42/sapwood-core";

export type Role = "viewer" | "editor" | "developer" | "admin";
export type TaskState = "open" | "landed" | "abandoned";

export interface Me {
  login: string;
  role: Role;
  scopes: Record<string, unknown>;
}

export interface BranchInfo {
  name: string;
  parent: string | null;
  forkCommit: string | null;
  head: string;
  archived: boolean;
  createdBy: string;
  createdAt: string;
}

export interface CommitInfo {
  id: string;
  branch: string;
  parents: string[];
  task: number | null;
  author: string;
  message: string;
  at: string;
}

export interface TaskInfo {
  id: number;
  branch: string;
  owner: string;
  name: string | null;
  base: string;
  state: TaskState;
  landedCommit: string | null;
  changes: number;
  canUndo: boolean;
  canRedo: boolean;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConflictJson {
  id: string;
  where?: { sheet: string; a1: string };
  conflict: unknown;
}

export interface TaskStatus {
  task: TaskInfo;
  behind: number;
  conflicts: ConflictJson[];
  validation: { errors: number; warnings: number };
}

export interface Landed {
  commit: CommitInfo;
  dropped: ConflictJson[];
  carried?: { task: TaskInfo | null; redo: number; dropped: ConflictJson[] };
}

export interface Health {
  ok: boolean;
  initialized: boolean;
  github: boolean;
}

/** What the server refused, with its error code (`stale`, `bad-op`, `invalid`…) and any detail. */
export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const seg = encodeURIComponent;

export class Api {
  private readonly fetch: Fetch;
  constructor(fetch: Fetch = (i, init) => globalThis.fetch(i, init)) {
    this.fetch = fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: "same-origin", headers: { "x-sapwood-request": "1" } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    const res = await this.fetch(path, init);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      throw new ApiError(res.status, "not-json", `The server answered ${res.status} with something that isn't JSON`);
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string } } | null)?.error ?? {};
      const { code, message, ...detail } = e as Record<string, unknown>;
      throw new ApiError(res.status, String(code ?? res.status), String(message ?? `The server answered ${res.status}`), detail);
    }
    return json as T;
  }

  health = () => this.call<Health>("GET", "/healthz");
  me = () => this.call<Me>("GET", "/api/me");
  signInWithToken = (token: string) => this.call<{ login: string; role: Role }>("POST", "/auth/token", { token });
  signOut = () => this.call<{ signedOut: boolean }>("POST", "/auth/logout");

  branches = () => this.call<BranchInfo[]>("GET", "/api/branches");
  branch = (b: string) => this.call<BranchInfo>("GET", `/api/branches/${seg(b)}`);
  commits = (b: string) => this.call<CommitInfo[]>("GET", `/api/branches/${seg(b)}/commits`);
  headDoc = (b: string) => this.call<{ doc: DocJson }>("GET", `/api/branches/${seg(b)}/doc`);

  tasks = (b: string, state: TaskState = "open") => this.call<TaskInfo[]>("GET", `/api/branches/${seg(b)}/tasks?state=${state}`);
  currentTask = (b: string) => this.call<TaskInfo | null>("GET", `/api/branches/${seg(b)}/tasks/current`);
  newTask = (b: string, name: string | null = null) => this.call<TaskInfo>("POST", `/api/branches/${seg(b)}/tasks`, name === null ? {} : { name });
  switchTask = (id: number) => this.call<TaskInfo>("POST", `/api/tasks/${id}/switch`);
  renameTask = (id: number, name: string | null) => this.call<TaskInfo>("PATCH", `/api/tasks/${id}`, { name });
  taskStatus = (id: number) => this.call<TaskStatus>("GET", `/api/tasks/${id}`);
  taskDoc = (id: number) => this.call<{ doc: DocJson; task: TaskInfo }>("GET", `/api/tasks/${id}/doc`);
  writeOps = (id: number, ops: Op[], rev: number) => this.call<{ task: TaskInfo; ops: number }>("POST", `/api/tasks/${id}/ops`, { ops, rev });
  undo = (id: number, rev: number) => this.call<{ done: boolean; ops: Op[]; task: TaskInfo }>("POST", `/api/tasks/${id}/undo`, { rev });
  redo = (id: number, rev: number) => this.call<{ done: boolean; ops: Op[]; task: TaskInfo }>("POST", `/api/tasks/${id}/redo`, { rev });
  land = (id: number, message?: string) => this.call<Landed>("POST", `/api/tasks/${id}/land`, message === undefined ? {} : { message });
}
