// Branches, commits and tasks (DESIGN §8.3–8.7), stored in the database (db.ts) and
// kept in memory as `Sapwood` projects: one for each branch head that has been read, and
// one for each open task that has been read or written.
//
// A commit's ops apply to its first parent's state. A task holds the changes its owner
// made on top of its base commit, one row per change so undo and redo survive a restart.
// Landing rebases the task onto the branch head, validates the result and commits it.
// Everything is synchronous, so lands happen one at a time: the land queue is the event loop.

import { randomBytes } from "node:crypto";
import {
  applyOps, cloneDoc, conflictId, docFromJson, docToJson, rebase, Sapwood,
  type CellAddress, type Change, type Conflict, type Doc, type ExportFile, type Op, type Side, type ValidationJson,
} from "@thek42/sapwood-core";
import { now, type Db } from "./db.ts";

export type RepoErrorCode = "not-found" | "exists" | "conflict" | "invalid" | "state" | "bad-request" | "forbidden";

export class RepoError extends Error {
  override name = "RepoError";
  readonly code: RepoErrorCode;
  readonly detail: unknown;
  constructor(code: RepoErrorCode, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
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

/** `landing` from DESIGN §8.3 never shows: a land runs start to finish in one call. */
export type TaskState = "open" | "landed" | "abandoned";

export interface TaskInfo {
  id: number;
  branch: string;
  owner: string;
  name: string | null;
  base: string;
  state: TaskState;
  landedCommit: string | null;
  /** Changes in effect (undone ones not counted). */
  changes: number;
  canUndo: boolean;
  canRedo: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A conflict, with the ID to resolve it by (`resolutions: { [id]: "mine" | "theirs" }`). */
export interface ConflictJson {
  id: string;
  /** Where it is on the head, by sheet name and A1 address. */
  where?: CellAddress;
  conflict: Conflict;
}

export interface TaskStatus {
  task: TaskInfo;
  /** Commits landed on the branch since the task's base. */
  behind: number;
  /** What blocks landing until resolved. */
  conflicts: ConflictJson[];
  validation: { errors: number; warnings: number };
}

export interface Landed {
  commit: CommitInfo;
  /** Ops of the task that no longer applied on the head, dropped (DESIGN §8.5). */
  dropped: ConflictJson[];
}

export type Resolutions = Record<string, Side>;

interface CommitRow {
  id: string;
  branch: string;
  depth: number;
  parent: string | null;
  parent2: string | null;
  task: number | null;
  author: string;
  message: string;
  at: string;
}

interface TaskRow {
  id: number;
  branch: string;
  owner: string;
  name: string | null;
  base: string;
  state: TaskState;
  landed_commit: string | null;
  created_at: string;
  updated_at: string;
}

interface ChangeRow {
  seq: number;
  ops: string;
  inverse: string;
  undone: number;
}

interface Rebased {
  ops: Op[];
  /** The rebased ops, grouped as the task's changes were, in order (see regroup). */
  changes: Op[][];
  state: Doc;
  behind: number;
  /** Unresolved conflicts: they block a land. */
  blocking: Conflict[];
  dropped: Conflict[];
}

export interface RepoOptions {
  /** Store the full state every this many commits along a branch, for loading (default 50). */
  snapshotEvery?: number;
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const DOC_CACHE = 16;

const newId = (): string => randomBytes(8).toString("hex");

export class Repo {
  private readonly snapshotEvery: number;
  private readonly heads = new Map<string, { commit: string; s: Sapwood; exports: Map<string, ExportFile[]> }>();
  private readonly views = new Map<number, { base: string; s: Sapwood }>();
  private readonly docs = new Map<string, Doc>();

  readonly db: Db;

  constructor(db: Db, opts: RepoOptions = {}) {
    this.db = db;
    this.snapshotEvery = opts.snapshotEvery ?? 50;
  }

  get initialized(): boolean {
    return this.db.meta("initialized") !== undefined;
  }

  /** Start the project: its first commit, on `main`. */
  init(doc: Doc, author: string, message = "Start the project"): CommitInfo {
    if (this.initialized) throw new RepoError("exists", "The project is already started");
    return this.db.tx(() => {
      const id = newId();
      const at = now();
      this.db.run("INSERT INTO commits (id, branch, depth, parent, parent2, task, author, message, at) VALUES (?, 'main', 0, NULL, NULL, NULL, ?, ?, ?)", id, author, message, at);
      this.db.run("INSERT INTO snapshots (commit_id, doc) VALUES (?, ?)", id, JSON.stringify(docToJson(doc)));
      this.db.run("INSERT INTO branches (name, parent, fork_commit, head, archived, created_by, created_at) VALUES ('main', NULL, NULL, ?, 0, ?, ?)", id, author, at);
      this.db.setMeta("initialized", at);
      return this.commit(id);
    });
  }

  // ------------------------------------------------------------ branches

  branches(includeArchived = false): BranchInfo[] {
    const rows = this.db.all<Record<string, string | number | null>>(`SELECT * FROM branches ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY name = 'main' DESC, name`);
    return rows.map(branchInfo);
  }

  branch(name: string): BranchInfo {
    const r = this.db.one("SELECT * FROM branches WHERE name = ?", name);
    if (!r) throw new RepoError("not-found", `No branch ${name}`);
    return branchInfo(r);
  }

  /** A branch forked from another's head (DESIGN §8.6). */
  createBranch(name: string, from: string, actor: string): BranchInfo {
    if (!BRANCH_NAME.test(name)) throw new RepoError("bad-request", `Branch names are letters, digits and . _ / -, starting with a letter or digit: got ${JSON.stringify(name)}`);
    const parent = this.liveBranch(from);
    if (this.db.one("SELECT 1 FROM branches WHERE name = ?", name)) throw new RepoError("exists", `There is already a branch ${name}`);
    this.db.run("INSERT INTO branches (name, parent, fork_commit, head, archived, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)", name, parent.name, parent.head, parent.head, actor, now());
    return this.branch(name);
  }

  /** Archive a branch: it is kept, but can't be changed. */
  discardBranch(name: string): BranchInfo {
    if (name === "main") throw new RepoError("bad-request", "main can't be discarded");
    this.liveBranch(name);
    this.db.run("UPDATE branches SET archived = 1 WHERE name = ?", name);
    this.heads.delete(name);
    return this.branch(name);
  }

  // ------------------------------------------------------------ commits

  commit(id: string): CommitInfo {
    return commitInfo(this.commitRow(id));
  }

  /** A branch's commits, newest first, following first parents. */
  log(branch: string, limit = 50): CommitInfo[] {
    const out: CommitInfo[] = [];
    for (let id: string | null = this.branch(branch).head; id !== null && out.length < limit; ) {
      const r = this.commitRow(id);
      out.push(commitInfo(r));
      id = r.parent;
    }
    return out;
  }

  /** The ops a commit applied to its first parent. */
  commitOps(id: string): Op[] {
    this.commitRow(id);
    return this.db.all<{ op: string }>("SELECT op FROM commit_ops WHERE commit_id = ? ORDER BY seq", id).map((r) => JSON.parse(r.op) as Op);
  }

  /** The document at a commit: its nearest snapshot, then the ops after it. A fresh copy. */
  stateAt(id: string): Doc {
    const chain: string[] = [];
    let doc: Doc | undefined;
    for (let c: string | null = id; doc === undefined; ) {
      if (c === null) throw new Error(`Commit ${id} has no snapshot to start from`);
      const cached = this.docs.get(c);
      if (cached) {
        doc = cloneDoc(cached);
        break;
      }
      const snap = this.db.one<{ doc: string }>("SELECT doc FROM snapshots WHERE commit_id = ?", c);
      if (snap) {
        doc = docFromJson(JSON.parse(snap.doc));
        break;
      }
      chain.push(c);
      c = this.commitRow(c).parent;
    }
    for (const c of chain.reverse()) applyOps(doc, this.commitOps(c));
    this.remember(id, cloneDoc(doc));
    return doc;
  }

  /** The project at a branch's head, for reading. Don't write to it. */
  head(branch: string): Sapwood {
    return this.headEntry(branch).s;
  }

  /** A branch head's export, kept until the head moves. */
  headExport(branch: string, allowInvalid: boolean): ExportFile[] {
    const h = this.headEntry(branch);
    const key = allowInvalid ? "any" : "valid";
    let files = h.exports.get(key);
    if (!files) {
      files = h.s.export({ branch, commit: h.commit, allowInvalid });
      h.exports.set(key, files);
    }
    return files;
  }

  /** The project at any commit, for reading. */
  at(commit: string): Sapwood {
    return Sapwood.fromDoc(this.stateAt(commit));
  }

  // ------------------------------------------------------------ tasks

  task(id: number): TaskInfo {
    const r = this.db.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    if (!r) throw new RepoError("not-found", `No task ${id}`);
    const counts = this.db.one<{ live: number; undone: number }>("SELECT COALESCE(SUM(undone = 0), 0) AS live, COALESCE(SUM(undone = 1), 0) AS undone FROM task_changes WHERE task = ?", id)!;
    return {
      id: r.id,
      branch: r.branch,
      owner: r.owner,
      name: r.name,
      base: r.base,
      state: r.state,
      landedCommit: r.landed_commit,
      changes: Number(counts.live),
      canUndo: r.state === "open" && Number(counts.live) > 0,
      canRedo: r.state === "open" && Number(counts.undone) > 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  tasks(filter: { branch?: string; state?: TaskState; owner?: string } = {}): TaskInfo[] {
    const where: string[] = [];
    const params: string[] = [];
    for (const [k, v] of Object.entries(filter)) {
      if (v === undefined) continue;
      where.push(`${k} = ?`);
      params.push(v);
    }
    const ids = this.db.all<{ id: number }>(`SELECT id FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`, ...params);
    return ids.map((r) => this.task(r.id));
  }

  /** A new task on a branch, based on its head. It becomes the owner's current task there. */
  createTask(branch: string, owner: string, name: string | null = null): TaskInfo {
    const b = this.liveBranch(branch);
    const at = now();
    const { lastInsertRowid: id } = this.db.run("INSERT INTO tasks (branch, owner, name, base, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)", b.name, owner, name, b.head, at, at);
    this.setCurrent(owner, b.name, id);
    return this.task(id);
  }

  /** The user's current task on a branch: the implicit working task, made on first use. */
  currentTask(branch: string, user: string, create = true): TaskInfo | null {
    const r = this.db.one<{ task: number }>("SELECT c.task FROM current_tasks c JOIN tasks t ON t.id = c.task WHERE c.user = ? AND c.branch = ? AND t.state = 'open'", user, branch);
    if (r) return this.task(r.task);
    return create ? this.createTask(branch, user) : null;
  }

  /** Make an open task its owner's current one on its branch. */
  switchTask(id: number, actor: string): TaskInfo {
    const t = this.openTask(id, actor);
    this.setCurrent(actor, t.branch, id);
    return this.task(id);
  }

  renameTask(id: number, actor: string, name: string | null): TaskInfo {
    this.ownTask(id, actor);
    this.db.run("UPDATE tasks SET name = ?, updated_at = ? WHERE id = ?", name, now(), id);
    return this.task(id);
  }

  /** The project as the task has it, for reading. Brings an open task up to the head first, when that has no conflicts. */
  view(id: number): Sapwood {
    const t = this.task(id);
    if (t.state === "landed") return this.at(t.landedCommit!);
    if (t.state === "open" && t.base !== this.branch(t.branch).head) this.tryAutoRebase(t);
    return this.viewOf(this.task(id)).s;
  }

  /**
   * Make a change in a task: `fn` writes to the task's project (any `Sapwood` write) and
   * its change is recorded. A refused write changes nothing.
   */
  write<C extends Change>(id: number, actor: string, fn: (s: Sapwood) => C): C {
    const t = this.openTask(id, actor);
    if (t.base !== this.branch(t.branch).head) this.tryAutoRebase(t);
    const v = this.viewOf(this.task(id));
    const change = fn(v.s);
    if (change.ops.length === 0) return change;
    try {
      this.db.tx(() => {
        this.db.run("DELETE FROM task_changes WHERE task = ? AND undone = 1", id);
        this.db.run("INSERT INTO task_changes (task, seq, ops, inverse, undone) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_changes WHERE task = ?), ?, ?, 0)", id, id, JSON.stringify(change.ops), JSON.stringify(change.inverse));
        this.touch(id);
      });
    } catch (e) {
      this.views.delete(id);
      throw e;
    }
    return change;
  }

  undo(id: number, actor: string): boolean {
    this.openTask(id, actor);
    const r = this.db.one<ChangeRow>("SELECT * FROM task_changes WHERE task = ? AND undone = 0 ORDER BY seq DESC LIMIT 1", id);
    if (!r) return false;
    const v = this.viewOf(this.task(id));
    v.s.project.apply(JSON.parse(r.inverse) as Op[]);
    this.db.tx(() => {
      this.db.run("UPDATE task_changes SET undone = 1 WHERE task = ? AND seq = ?", id, r.seq);
      this.touch(id);
    });
    return true;
  }

  redo(id: number, actor: string): boolean {
    this.openTask(id, actor);
    const r = this.db.one<ChangeRow>("SELECT * FROM task_changes WHERE task = ? AND undone = 1 ORDER BY seq LIMIT 1", id);
    if (!r) return false;
    const v = this.viewOf(this.task(id));
    const inverse = v.s.project.apply(JSON.parse(r.ops) as Op[]);
    this.db.tx(() => {
      this.db.run("UPDATE task_changes SET undone = 0, inverse = ? WHERE task = ? AND seq = ?", JSON.stringify(inverse), id, r.seq);
      this.touch(id);
    });
    return true;
  }

  /** The task's ops in effect, in order: its diff against its base. */
  taskOps(id: number): Op[] {
    this.task(id);
    return this.db.all<{ ops: string }>("SELECT ops FROM task_changes WHERE task = ? AND undone = 0 ORDER BY seq", id).flatMap((r) => JSON.parse(r.ops) as Op[]);
  }

  status(id: number): TaskStatus {
    const s = this.view(id);
    const t = this.task(id);
    let behind = 0;
    let conflicts: ConflictJson[] = [];
    if (t.state === "open" && t.base !== this.branch(t.branch).head) {
      const r = this.rebased(t, {});
      behind = r.behind;
      const h = this.head(t.branch);
      conflicts = r.blocking.map((c) => conflictJson(c, h));
    }
    const v = s.validate();
    return { task: t, behind, conflicts, validation: { errors: v.errors, warnings: v.warnings } };
  }

  /**
   * Rebase a task onto its branch's head, settling conflicts by `resolutions`. Refused
   * while any conflict is unresolved. Each change stays its own undo step, and the
   * resolutions make one more; what was undone can't be redone after.
   */
  rebaseTask(id: number, actor: string, resolutions: Resolutions = {}): { task: TaskInfo; dropped: ConflictJson[] } {
    const t = this.openTask(id, actor);
    const head = this.branch(t.branch).head;
    if (t.base === head) return { task: t, dropped: [] };
    const r = this.rebased(t, resolutions);
    if (r.blocking.length) throw conflictError(r.blocking, this.head(t.branch));
    this.adopt(t, head, r.changes);
    return { task: this.task(id), dropped: r.dropped.map((c) => conflictJson(c)) };
  }

  /**
   * Land a task (DESIGN §8.4): rebase it onto the head, validate the result, and commit.
   * Refused with unresolved conflicts or validation errors, leaving the task as it was.
   */
  land(id: number, actor: string, opts: { message?: string; resolutions?: Resolutions } = {}): Landed {
    const t = this.task(id);
    if (t.state !== "open") throw new RepoError("state", `Task ${id} is ${t.state}`);
    const b = this.liveBranch(t.branch);
    let ops: Op[];
    let s: Sapwood;
    let dropped: Conflict[] = [];
    if (t.base === b.head) {
      ops = this.taskOps(id);
      s = this.viewOf(t).s;
    } else {
      const r = this.rebased(t, opts.resolutions ?? {});
      if (r.blocking.length) throw conflictError(r.blocking, this.head(t.branch));
      ops = r.ops;
      dropped = r.dropped;
      s = Sapwood.fromDoc(r.state);
    }
    if (ops.length === 0) throw new RepoError("state", `Task ${id} has no changes to land`);
    const v = s.validate();
    if (v.errors) throw new RepoError("invalid", `Landing task ${id} would leave ${v.errors} validation error${v.errors === 1 ? "" : "s"}`, { validation: v });
    const commit = this.db.tx(() => {
      const c = this.addCommit(b.name, b.head, null, id, actor, opts.message ?? t.name ?? `Task ${id}`, ops, s.doc);
      this.db.run("UPDATE tasks SET state = 'landed', landed_commit = ?, updated_at = ? WHERE id = ?", c.id, now(), id);
      this.db.run("DELETE FROM current_tasks WHERE task = ?", id);
      return c;
    });
    this.views.delete(id);
    this.heads.set(b.name, { commit: commit.id, s, exports: new Map() });
    this.remember(commit.id, s.doc);
    return { commit, dropped: dropped.map((c) => conflictJson(c)) };
  }

  abandon(id: number, actor: string): TaskInfo {
    this.openTask(id, actor);
    this.db.run("UPDATE tasks SET state = 'abandoned', updated_at = ? WHERE id = ?", now(), id);
    this.db.run("DELETE FROM current_tasks WHERE task = ?", id);
    this.views.delete(id);
    return this.task(id);
  }

  /** Reopen an abandoned task, as its owner's current one. */
  reopen(id: number, actor: string): TaskInfo {
    const t = this.ownTask(id, actor);
    if (t.state !== "abandoned") throw new RepoError("state", `Task ${id} is ${t.state}, not abandoned`);
    this.liveBranch(t.branch);
    this.db.run("UPDATE tasks SET state = 'open', updated_at = ? WHERE id = ?", now(), id);
    this.setCurrent(actor, t.branch, id);
    return this.task(id);
  }

  // ------------------------------------------------------------ inside

  private commitRow(id: string): CommitRow {
    const r = this.db.one<CommitRow>("SELECT * FROM commits WHERE id = ?", id);
    if (!r) throw new RepoError("not-found", `No commit ${id}`);
    return r;
  }

  private liveBranch(name: string): BranchInfo {
    const b = this.branch(name);
    if (b.archived) throw new RepoError("state", `Branch ${name} is discarded`);
    return b;
  }

  private ownTask(id: number, actor: string): TaskInfo {
    const t = this.task(id);
    if (t.owner !== actor) throw new RepoError("forbidden", `Task ${id} is ${t.owner}'s`);
    return t;
  }

  private openTask(id: number, actor: string): TaskInfo {
    const t = this.ownTask(id, actor);
    if (t.state !== "open") throw new RepoError("state", `Task ${id} is ${t.state}`);
    return t;
  }

  private setCurrent(user: string, branch: string, task: number): void {
    this.db.run("INSERT INTO current_tasks (user, branch, task) VALUES (?, ?, ?) ON CONFLICT (user, branch) DO UPDATE SET task = excluded.task", user, branch, task);
  }

  private touch(id: number): void {
    this.db.run("UPDATE tasks SET updated_at = ? WHERE id = ?", now(), id);
  }

  private headEntry(branch: string) {
    const head = this.branch(branch).head;
    let h = this.heads.get(branch);
    if (!h || h.commit !== head) {
      h = { commit: head, s: Sapwood.fromDoc(this.stateAt(head)), exports: new Map() };
      this.heads.set(branch, h);
    }
    return h;
  }

  private viewOf(t: TaskInfo): { base: string; s: Sapwood } {
    let v = this.views.get(t.id);
    if (!v || v.base !== t.base) {
      const s = taskProject(this.stateAt(t.base), t.id);
      const ops = this.taskOps(t.id);
      if (ops.length) s.project.apply(ops);
      v = { base: t.base, s };
      this.views.set(t.id, v);
    }
    return v;
  }

  private remember(commit: string, doc: Doc): void {
    this.docs.delete(commit);
    this.docs.set(commit, doc);
    while (this.docs.size > DOC_CACHE) this.docs.delete(this.docs.keys().next().value!);
  }

  /** The ops landed on the branch since `base`, in order, and how many commits that is. */
  private since(branch: string, base: string): { ops: Op[]; commits: number } {
    const ids: string[] = [];
    for (let id: string | null = this.branch(branch).head; id !== base; ) {
      if (id === null) throw new Error(`Commit ${base} isn't on branch ${branch}`);
      ids.push(id);
      id = this.commitRow(id).parent;
    }
    return { ops: ids.reverse().flatMap((id) => this.commitOps(id)), commits: ids.length };
  }

  private rebased(t: TaskInfo, resolutions: Resolutions): Rebased {
    const theirs = this.since(t.branch, t.base);
    const blocking: Conflict[] = [];
    const changes = this.db.all<{ ops: string }>("SELECT ops FROM task_changes WHERE task = ? AND undone = 0 ORDER BY seq", t.id).map((r) => JSON.parse(r.ops) as Op[]);
    const r = rebase(this.stateAt(t.base), theirs.ops, changes.flat(), (c) => {
      const side = resolutions[conflictId(c)];
      if (side === "mine" || side === "theirs") return side;
      blocking.push(c);
      return "theirs";
    });
    return { ops: r.ops, changes: regroup(changes, r.ops, r.origins), state: r.state, behind: theirs.commits, blocking, dropped: r.conflicts.filter((c) => c.kind === "op") };
  }

  /**
   * Bring a task up to the head when nothing is in the way: no conflicts, and nothing to
   * redo (a rebase would drop it, and the user didn't ask for one).
   */
  private tryAutoRebase(t: TaskInfo): void {
    if (t.canRedo) return;
    const head = this.branch(t.branch).head;
    const r = this.rebased(t, {});
    if (!r.blocking.length) this.adopt(t, head, r.changes);
  }

  /**
   * Move a task onto `head` with its rebased changes, each still its own undo step, with
   * its inverse worked out again on the head. What was undone is dropped.
   */
  private adopt(t: TaskInfo, head: string, changes: Op[][]): void {
    const doc = this.stateAt(head);
    const rows = changes.map((ops) => ({ ops, inverse: applyOps(doc, ops) }));
    this.db.tx(() => {
      this.db.run("DELETE FROM task_changes WHERE task = ?", t.id);
      rows.forEach((c, i) => this.db.run("INSERT INTO task_changes (task, seq, ops, inverse, undone) VALUES (?, ?, ?, ?, 0)", t.id, i + 1, JSON.stringify(c.ops), JSON.stringify(c.inverse)));
      this.db.run("UPDATE tasks SET base = ?, updated_at = ? WHERE id = ?", head, now(), t.id);
    });
    this.views.set(t.id, { base: head, s: taskProject(doc, t.id) });
  }

  private addCommit(branch: string, parent: string, parent2: string | null, task: number | null, author: string, message: string, ops: Op[], state: Doc): CommitInfo {
    const id = newId();
    const depth = this.commitRow(parent).depth + 1;
    this.db.run("INSERT INTO commits (id, branch, depth, parent, parent2, task, author, message, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, branch, depth, parent, parent2, task, author, message, now());
    ops.forEach((op, i) => this.db.run("INSERT INTO commit_ops (commit_id, seq, op) VALUES (?, ?, ?)", id, i, JSON.stringify(op)));
    if (depth % this.snapshotEvery === 0) this.db.run("INSERT INTO snapshots (commit_id, doc) VALUES (?, ?)", id, JSON.stringify(docToJson(state)));
    this.db.run("UPDATE branches SET head = ? WHERE name = ?", id, branch);
    return this.commit(id);
  }
}

function branchInfo(r: Record<string, string | number | null>): BranchInfo {
  return {
    name: r.name as string,
    parent: r.parent as string | null,
    forkCommit: r.fork_commit as string | null,
    head: r.head as string,
    archived: r.archived === 1,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
  };
}

function commitInfo(r: CommitRow): CommitInfo {
  return {
    id: r.id,
    branch: r.branch,
    parents: [r.parent, r.parent2].filter((p): p is string => p !== null),
    task: r.task,
    author: r.author,
    message: r.message,
    at: r.at,
  };
}

/**
 * Group rebased ops into the changes they came from. A change keeps its ops in order; one
 * left with nothing (theirs won all of it) goes. Ops that settle conflicts (no origin) make
 * a step of their own where they fall: restores before the changes, fix-ups after them.
 */
export function regroup(changes: readonly (readonly Op[])[], ops: readonly Op[], origins: readonly (number | null)[]): Op[][] {
  const changeOf: number[] = [];
  changes.forEach((c, i) => c.forEach(() => changeOf.push(i)));
  const out: Op[][] = [];
  let last: number | null | undefined;
  ops.forEach((op, i) => {
    const o = origins[i]!;
    const key = o === null ? null : changeOf[o]!;
    if (key !== last || out.length === 0) out.push([]);
    out.at(-1)!.push(op);
    last = key;
  });
  return out;
}

/**
 * A task's project. Its new rows, columns, sheets and schema IDs carry the task's salt,
 * so two tasks writing at once never make the same ID (DESIGN §8.1: ops are against
 * stable IDs, and a rebase keeps them).
 */
function taskProject(doc: Doc, task: number): Sapwood {
  const s = Sapwood.fromDoc(doc);
  s.project.wb.idSalt = `${task}_`;
  return s;
}

function conflictJson(c: Conflict, head?: Sapwood): ConflictJson {
  const out: ConflictJson = { id: conflictId(c), conflict: c };
  if (head && c.kind === "cell" && head.doc.sheets.has(c.sheet)) out.where = head.address(c.sheet, c.row, c.col);
  return out;
}

function conflictError(cs: Conflict[], head: Sapwood): RepoError {
  return new RepoError("conflict", `${cs.length} conflict${cs.length === 1 ? "" : "s"} with the branch head: resolve each as mine or theirs`, { conflicts: cs.map((c) => conflictJson(c, head)) });
}

export type { ValidationJson };
