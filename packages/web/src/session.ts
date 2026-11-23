// A task, as the web app holds it (DESIGN §4.2): its own copy of the task's project, so an
// edit shows at once, with formulas recalculated and validation run here. Each edit's ops
// then go to the server, one change at a time and in order, each saying the revision it was
// made on. The server applies them again, as the authority.
//
// If the task moved on meanwhile (the CLI or an LLM wrote to it, another tab did, it was
// rebased onto a new head), the server refuses the write as stale. The session then reads
// the task again and replays on it whatever it hadn't sent yet; an edit that no longer
// applies there is dropped, and said so. Undo and redo are the server's (they survive a
// reload, and take back edits made elsewhere too), so they wait for what's being sent.

import { docFromJson, OpError, Project, type Op } from "@thek42/sapwood-core";
import { ApiError, type Api, type TaskInfo } from "./api.ts";

/** What an edit gives back: the ops it applied (every Project edit returns these). */
export interface Edited {
  ops: Op[];
}

export interface SessionState {
  task: TaskInfo;
  /** Edits made here and not yet taken by the server. */
  unsent: number;
  /** Something that went wrong that the person should know, or null. */
  notice: string | null;
}

type ApiFor = Pick<Api, "taskDoc" | "writeOps" | "undo" | "redo">;

export class TaskSession {
  project: Project;
  task: TaskInfo;
  notice: string | null = null;
  private readonly api: ApiFor;
  private unsent: Op[][] = [];
  private running: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private closed = false;

  private constructor(api: ApiFor, project: Project, task: TaskInfo) {
    this.api = api;
    this.project = project;
    this.task = task;
  }

  static async open(api: ApiFor, id: number): Promise<TaskSession> {
    const { doc, task } = await api.taskDoc(id);
    return new TaskSession(api, build(doc, task.id), task);
  }

  get state(): SessionState {
    return { task: this.task, unsent: this.unsent.length, notice: this.notice };
  }

  get editable(): boolean {
    return this.task.state === "open";
  }

  /** Called after anything here changes: the project, the task, or the notice. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  /** An edit to the project, applied here at once and then sent. False if it didn't apply. */
  edit(fn: (p: Project) => Edited): boolean {
    if (!this.editable) return this.tell(`Task ${this.task.id} is ${this.task.state}: it can't be edited`), false;
    let ops: Op[];
    try {
      ops = fn(this.project).ops;
    } catch (e) {
      if (e instanceof OpError) return this.tell(e.message), false;
      throw e;
    }
    if (ops.length === 0) return true;
    this.unsent.push(ops);
    this.changed();
    void this.run(() => this.send());
    return true;
  }

  undo(): Promise<void> {
    return this.run(() => this.step("undo"));
  }

  redo(): Promise<void> {
    return this.run(() => this.step("redo"));
  }

  /** Read the task again, as the server has it now. */
  reload(): Promise<void> {
    return this.run(() => this.resync());
  }

  /** Everything sent, or refused. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /**
   * A task event from the server's WebSocket. One that moved the task past what we have
   * (written elsewhere, rebased, landed) means reading it again; our own writes we've seen.
   */
  heard(task: TaskInfo): void {
    if (task.id !== this.task.id) return;
    if (task.rev === this.task.rev && task.name !== this.task.name) {
      this.task = { ...this.task, name: task.name }; // named: nothing else changed
      return this.changed();
    }
    if (task.rev <= this.task.rev) return;
    if (this.running) return; // our next write finds out, or this is our own write's echo
    void this.run(() => this.resync());
  }

  // ------------------------------------------------------------ inside

  /** One thing at a time, in order: sends, undo and redo, reloads. */
  private run(job: () => Promise<void>): Promise<void> {
    const next = (this.running ?? Promise.resolve()).then(job).catch((e: unknown) => this.tell(message(e)));
    const mine = next.finally(() => {
      if (this.running === mine) this.running = null;
    });
    this.running = mine;
    return mine;
  }

  private async send(): Promise<void> {
    while (this.unsent.length > 0 && !this.closed) {
      const ops = this.unsent[0]!;
      try {
        const r = await this.api.writeOps(this.task.id, ops, this.task.rev);
        this.unsent.shift();
        this.task = r.task;
        this.changed();
      } catch (e) {
        if (e instanceof ApiError && e.code === "stale") {
          await this.resync();
          continue;
        }
        // Refused for good (it didn't apply there, or we may not): go back to the server's.
        this.unsent.shift();
        await this.resync();
        this.tell(`An edit wasn't kept: ${message(e)}`);
      }
    }
  }

  private async step(which: "undo" | "redo"): Promise<void> {
    if (!this.editable) return;
    for (let tries = 0; tries < 2; tries++) {
      try {
        const r = await this.api[which](this.task.id, this.task.rev);
        if (r.ops.length > 0) this.project.apply(r.ops);
        this.task = r.task;
        this.changed();
        return;
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "stale")) throw e;
        await this.resync(); // then undo what's there now
      }
    }
  }

  /** The task as the server has it, with what we hadn't sent replayed on top. */
  private async resync(): Promise<void> {
    const { doc, task } = await this.api.taskDoc(this.task.id);
    const project = build(doc, task.id);
    const kept: Op[][] = [];
    let lost = 0;
    for (const ops of this.unsent) {
      try {
        project.apply(ops);
        kept.push(ops);
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        lost++;
      }
    }
    this.project = project;
    this.task = task;
    this.unsent = task.state === "open" ? kept : [];
    if (lost > 0) this.tell(`${lost === 1 ? "An edit" : `${lost} edits`} no longer applied after the task changed elsewhere, and ${lost === 1 ? "was" : "were"} dropped`);
    else this.changed();
  }

  private tell(notice: string): void {
    this.notice = notice;
    this.changed();
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}

/** A task's project, making new IDs with the task's salt as the server does (`s1r7_1`). */
function build(doc: Parameters<typeof docFromJson>[0], task: number): Project {
  const p = Project.fromDoc(docFromJson(doc));
  p.wb.idSalt = `${task}_`;
  return p;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
