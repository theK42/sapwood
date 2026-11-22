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
  applyOps, cloneDoc, conflictId, docFromJson, docsEqual, docToJson, rebase, reconcile, Sapwood,
  type CellAddress, type Change, type Conflict, type Doc, type ExportFile, type Op, type Side, type ValidationJson,
} from "@thek42/sapwood-core";
import { now, type Db } from "./db.ts";

export type RepoErrorCode = "not-found" | "exists" | "conflict" | "invalid" | "state" | "bad-request" | "forbidden" | "upstream";

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
/** How a sync commit was made: the parent's changes alone, plus a few reconciling ops, or undo and redo. */
export type SyncRoute = "clean" | "reconciled" | "long";

/** How a branch stands against its parent. */
export interface BranchStatus {
  branch: BranchInfo;
  /** Commits on the parent the branch hasn't synced. */
  behind: number;
  /** The branch's own commits since it forked or last merged (its syncs aren't counted). */
  ahead: number;
  /** What a sync would need settled (mine is the branch, theirs the parent). */
  conflicts: ConflictJson[];
}

export interface Synced {
  /** The sync commit on the branch, or null when it was up to date. */
  commit: CommitInfo | null;
  /** Ops of the branch that no longer applied on the parent's head, dropped. */
  dropped: ConflictJson[];
}

export interface Merged {
  /** The sync the merge needed first, if the parent had moved on. */
  sync: CommitInfo | null;
  merge: CommitInfo;
  dropped: ConflictJson[];
}

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
  /** How this process's syncs were made, for tests and diagnostics. */
  readonly syncRoutes: Record<SyncRoute, number> = { clean: 0, reconciled: 0, long: 0 };

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
    this.db.run(
      "INSERT INTO branches (name, parent, fork_commit, head, archived, created_by, created_at, base_commit, base_point, net) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, '[]')",
      name, parent.name, parent.head, parent.head, actor, now(), parent.head, parent.head,
    );
    return this.branch(name);
  }

  // ------------------------------------------------------------ merge and sync
  //
  // A branch keeps its net change: ops that take its base (a commit on its parent: where
  // it forked, or last synced or merged) to its head. Lands on the branch add to it. A
  // sync rebases it onto the parent's head; a merge, once synced, is that net change.

  compare(name: string): BranchStatus {
    const b = this.branch(name);
    if (b.parent === null) return { branch: b, behind: 0, ahead: 0, conflicts: [] };
    const base = this.base(name);
    let ahead = 0; // the branch's own commits since it forked or last merged, not its syncs
    for (let id: string | null = b.head; id !== null && id !== base.point; ) {
      const c = this.commitRow(id);
      if (c.parent2 === null || this.commitRow(c.parent2).branch !== b.parent) ahead++;
      id = c.parent;
    }
    const behind = this.since(b.parent, base.commit).commits;
    let conflicts: ConflictJson[] = [];
    if (behind) {
      const blocking: Conflict[] = [];
      rebase(this.stateAt(base.commit), this.since(b.parent, base.commit).ops, base.net, (c) => (blocking.push(c), "theirs"));
      const h = this.head(name);
      conflicts = blocking.map((c) => conflictJson(c, h));
    }
    return { branch: b, behind, ahead, conflicts };
  }

  /**
   * Bring the parent's changes into a branch (DESIGN §8.6): the branch's net change is
   * rebased onto the parent's head and validated, and committed on the branch with the
   * parent's head as second parent. Conflicts are settled by `resolutions`, with mine
   * the branch's side.
   */
  sync(name: string, actor: string, opts: { resolutions?: Resolutions } = {}): Synced {
    const b = this.liveBranch(name);
    if (b.parent === null) throw new RepoError("bad-request", `${name} has no parent to sync from`);
    const out = this.db.tx(() => this.syncInTx(b, actor, opts.resolutions ?? {}));
    return { commit: out?.commit ?? null, dropped: out?.dropped ?? [] };
  }

  /**
   * Merge a branch into its parent (DESIGN §8.6). If the parent has moved on, the branch
   * is synced first (in the same step, with the same resolutions). The merge commit, on
   * the parent with the branch's head as second parent, is then the branch's net change,
   * and leaves the parent as the branch is. Refused with nothing to merge, unsettled
   * conflicts or validation errors.
   */
  merge(name: string, actor: string, opts: { message?: string; resolutions?: Resolutions } = {}): Merged {
    const b = this.liveBranch(name);
    if (b.parent === null) throw new RepoError("bad-request", `${name} has no parent to merge into`);
    const p = this.liveBranch(b.parent);
    if (this.base(name).net.length === 0) throw new RepoError("state", `${name} has no changes to merge into ${p.name}`);
    const out = this.db.tx(() => {
      const synced = this.syncInTx(b, actor, opts.resolutions ?? {});
      const head = this.branch(name).head;
      const { net } = this.base(name);
      const s = this.head(name);
      const v = s.validate();
      if (v.errors) throw new RepoError("invalid", `Merging ${name} would leave ${v.errors} validation error${v.errors === 1 ? "" : "s"} on ${p.name}`, { validation: v });
      const parentHead = this.branch(p.name).head;
      const merge = this.addCommit(p.name, parentHead, head, null, actor, opts.message ?? `Merge ${name} into ${p.name}`, net, s.doc);
      this.setBase(name, merge.id, head, []);
      return { synced, merge, doc: s.doc };
    });
    this.heads.set(p.name, { commit: out.merge.id, s: Sapwood.fromDoc(cloneDoc(out.doc)), exports: new Map() });
    this.remember(out.merge.id, cloneDoc(out.doc));
    return { sync: out.synced?.commit ?? null, merge: out.merge, dropped: out.synced?.dropped ?? [] };
  }

  /** Sync inside a transaction. Null when the branch is up to date with its parent. */
  private syncInTx(b: BranchInfo, actor: string, resolutions: Resolutions): Synced | null {
    const parent = this.liveBranch(b.parent!);
    const base = this.base(b.name);
    if (base.commit === parent.head) return null;
    const theirs = this.since(parent.name, base.commit).ops;
    const blocking: Conflict[] = [];
    // The branch's net change onto the parent's head: what the branch then holds.
    const r = rebase(this.stateAt(base.commit), theirs, base.net, (c) => {
      const side = resolutions[conflictId(c)];
      if (side === "mine" || side === "theirs") return side;
      blocking.push(c);
      return "theirs";
    });
    if (blocking.length) throw conflictError(blocking, this.head(b.name));
    const v = Sapwood.fromDoc(cloneDoc(r.state)).validate();
    if (v.errors) throw new RepoError("invalid", `Syncing ${b.name} from ${parent.name} would leave ${v.errors} validation error${v.errors === 1 ? "" : "s"}`, { validation: v });
    // The sync commit applies to the branch's head: the parent's changes rebased over the
    // branch's, as if they were a task landing on it, with the parent counted as landed
    // first, so ties go as they did above. Moves and renames can still come out a little
    // different that way round; reconcile adds the few ops that say what's left. Only if
    // it can't (the schema differs) does the commit take the long way: undo the branch's
    // net change, apply the parent's, then the branch's rebased.
    const flip = (s: Side | undefined): Side => (s === "theirs" ? "mine" : s === "mine" ? "theirs" : "mine");
    const across = rebase(this.stateAt(base.commit), base.net, theirs, (c) => flip(resolutions[conflictId(c, true)]), { mineFirst: true });
    let ops = across.ops;
    let route: SyncRoute = "clean";
    if (!docsEqual(across.state, r.state)) {
      const rest = reconcile(across.state, r.state);
      if (rest) {
        ops = [...ops, ...rest];
        route = "reconciled";
      } else {
        ops = [...applyOps(this.stateAt(base.commit), base.net), ...theirs, ...r.ops];
        route = "long";
      }
    }
    this.syncRoutes[route]++;
    const commit = this.addCommit(b.name, b.head, parent.head, null, actor, `Sync ${b.name} from ${parent.name}`, ops, r.state, false);
    this.setBase(b.name, parent.head, base.point, r.ops);
    this.heads.set(b.name, { commit: commit.id, s: Sapwood.fromDoc(cloneDoc(r.state)), exports: new Map() });
    this.remember(commit.id, cloneDoc(r.state));
    return { commit, dropped: r.conflicts.filter((c) => c.kind === "op").map((c) => conflictJson(c)) };
  }

  private base(name: string): { commit: string; point: string; net: Op[] } {
    const r = this.db.one<{ base_commit: string | null; base_point: string | null; net: string }>("SELECT base_commit, base_point, net FROM branches WHERE name = ?", name)!;
    return { commit: r.base_commit!, point: r.base_point!, net: JSON.parse(r.net) as Op[] };
  }

  private setBase(name: string, commit: string, point: string, net: Op[]): void {
    this.db.run("UPDATE branches SET base_commit = ?, base_point = ?, net = ? WHERE name = ?", commit, point, JSON.stringify(net), name);
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
    return commitInfo(this.commitRow(this.resolveCommit(id)));
  }

  /** A commit's full ID from its ID or a unique start of it (4 characters or more), as a log shows it. */
  resolveCommit(id: string): string {
    if (this.db.one("SELECT 1 FROM commits WHERE id = ?", id)) return id;
    if (!/^[0-9a-f]{4,}$/.test(id)) throw new RepoError("not-found", `No commit ${id}`);
    const rows = this.db.all<{ id: string }>("SELECT id FROM commits WHERE id LIKE ? LIMIT 2", `${id}%`);
    if (!rows.length) throw new RepoError("not-found", `No commit ${id}`);
    if (rows.length > 1) throw new RepoError("bad-request", `Commit ${id} is ambiguous: give more of its ID`);
    return rows[0]!.id;
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
    return Sapwood.fromDoc(this.stateAt(this.resolveCommit(commit)));
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

  // ------------------------------------------------------------ revert and restore

  /**
   * Revert a commit (DESIGN §8.7): a new task, the actor's current one on the branch, whose
   * one change is the commit's inverse. It is based on the commit itself and rebased onto
   * the head like any task, so later changes to the same cells come up as conflicts to
   * settle before it lands. The commit must be on the branch (its first parents).
   */
  revert(commitId: string, actor: string, opts: { branch?: string } = {}): TaskStatus {
    const c = this.commitRow(this.resolveCommit(commitId));
    const branch = opts.branch ?? c.branch;
    this.liveBranch(branch);
    if (c.parent === null) throw new RepoError("bad-request", "The first commit can't be reverted");
    this.onBranch(branch, c.id);
    const inverse = applyOps(this.stateAt(c.parent), this.commitOps(c.id));
    if (!inverse.length) throw new RepoError("state", `Commit ${short(c.id)} changed nothing`);
    const t = this.taskWith(branch, actor, `Revert "${c.message}"`, c.id, inverse);
    return this.status(t.id);
  }

  /**
   * Restore a branch to an earlier commit on it (DESIGN §8.7): a new task, the actor's
   * current one there, whose one change takes the head back to that commit's state
   * exactly. The change says the difference plainly (rows removed, cells set back) rather
   * than undoing every commit since, one by one, when it can.
   */
  restore(branch: string, commitId: string, actor: string): TaskStatus {
    const b = this.liveBranch(branch);
    const c = this.commitRow(this.resolveCommit(commitId));
    this.onBranch(branch, c.id);
    if (c.id === b.head) throw new RepoError("state", `${branch} is already at ${short(c.id)}`);
    const target = this.stateAt(c.id);
    const ops = reconcile(this.stateAt(b.head), target) ?? applyOps(this.stateAt(c.id), this.since(branch, c.id).ops);
    if (!ops.length) throw new RepoError("state", `${branch} is already as it was at ${short(c.id)}`);
    const t = this.taskWith(branch, actor, `Restore to ${short(c.id)} "${c.message}"`, b.head, ops);
    return this.status(t.id);
  }

  /** A new open task on a branch, based on `base`, with one change. The owner's current task there. */
  private taskWith(branch: string, owner: string, name: string, base: string, ops: Op[]): TaskInfo {
    const inverse = applyOps(this.stateAt(base), ops);
    const id = this.db.tx(() => {
      const at = now();
      const { lastInsertRowid: id } = this.db.run("INSERT INTO tasks (branch, owner, name, base, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)", branch, owner, name, base, at, at);
      this.db.run("INSERT INTO task_changes (task, seq, ops, inverse, undone) VALUES (?, 1, ?, ?, 0)", id, JSON.stringify(ops), JSON.stringify(inverse));
      this.setCurrent(owner, branch, id);
      return id;
    });
    return this.task(id);
  }

  /** Refuse a commit that isn't on the branch's line of first parents. */
  private onBranch(branch: string, id: string): void {
    for (let c: string | null = this.branch(branch).head; c !== null; c = this.commitRow(c).parent) if (c === id) return;
    throw new RepoError("bad-request", `Commit ${short(id)} isn't on ${branch}`);
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

  /** Add a commit on a branch, and (unless `addToNet` is false) to the branch's net change. */
  private addCommit(branch: string, parent: string, parent2: string | null, task: number | null, author: string, message: string, ops: Op[], state: Doc, addToNet = true): CommitInfo {
    const id = newId();
    const depth = this.commitRow(parent).depth + 1;
    this.db.run("INSERT INTO commits (id, branch, depth, parent, parent2, task, author, message, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, branch, depth, parent, parent2, task, author, message, now());
    ops.forEach((op, i) => this.db.run("INSERT INTO commit_ops (commit_id, seq, op) VALUES (?, ?, ?)", id, i, JSON.stringify(op)));
    if (depth % this.snapshotEvery === 0) this.db.run("INSERT INTO snapshots (commit_id, doc) VALUES (?, ?)", id, JSON.stringify(docToJson(state)));
    this.db.run("UPDATE branches SET head = ? WHERE name = ?", id, branch);
    if (addToNet && this.branch(branch).parent !== null) {
      const b = this.base(branch);
      this.setBase(branch, b.commit, b.point, [...b.net, ...ops]);
    }
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

/** A commit ID, shortened for messages. */
const short = (id: string): string => id.slice(0, 8);
