// Events for the WebSocket (DESIGN §9.4): what changed, pushed as it's committed, to the
// clients allowed to read the branch it's on. Validation counts follow a head that moved
// or a task that changed, worked out once per burst of changes, and only while someone
// is listening.

import { allowed, type Auth, type Principal } from "./auth.ts";
import type { Repo, RepoEvent } from "./repo.ts";

/** What a client gets: a repo event, a validation count, or the hello it starts with. */
export type EventMessage =
  | (RepoEvent & { at: string })
  | { type: "validation"; branch: string; commit: string; task?: number; errors: number; warnings: number; at: string }
  | { type: "hello"; login: string; role: string; branches: string[]; at: string };

export interface Listener {
  /** The token it signed in with, checked again now and then. */
  token: string;
  principal: Principal;
  /** Only these branches, or all it may read. */
  branches: Set<string> | null;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface EventsOptions {
  /** How long a burst of changes is waited out before validating (default 50 ms). */
  validateAfter?: number;
  /** How often tokens are checked again (default 30 s): a revoked or expired one is closed. */
  recheckEvery?: number;
}

/** Closed: the token no longer works (signed out, revoked, expired). */
export const CLOSE_SIGNED_OUT = 4401;

export class Events {
  private readonly repo: Repo;
  private readonly auth: Auth;
  private readonly listeners = new Set<Listener>();
  /** Validation to work out: a branch head, or a task. */
  private readonly due = new Map<string, { branch: string } | { task: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly recheck: ReturnType<typeof setInterval>;
  private readonly validateAfter: number;

  constructor(repo: Repo, auth: Auth, opts: EventsOptions = {}) {
    this.repo = repo;
    this.auth = auth;
    this.validateAfter = opts.validateAfter ?? 50;
    repo.on((e) => this.heard(e));
    this.recheck = setInterval(() => this.recheckTokens(), opts.recheckEvery ?? 30_000);
    this.recheck.unref();
  }

  get size(): number {
    return this.listeners.size;
  }

  /** Start sending to a client: hello first. Returns a function that stops it. */
  add(l: Listener): () => void {
    this.listeners.add(l);
    const branches = this.repo.branches().map((b) => b.name).filter((b) => this.reaches(l, b));
    l.send(JSON.stringify({ type: "hello", login: l.principal.login, role: l.principal.role, branches, at: new Date().toISOString() } satisfies EventMessage));
    return () => this.listeners.delete(l);
  }

  /** Stop: no more validation, no more checks. */
  stop(): void {
    clearInterval(this.recheck);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.due.clear();
  }

  private reaches(l: Listener, branch: string): boolean {
    return (!l.branches || l.branches.has(branch)) && allowed(l.principal, "viewer", "read", branch) === null;
  }

  private send(branch: string, m: EventMessage): void {
    const text = JSON.stringify(m);
    for (const l of this.listeners) if (this.reaches(l, branch)) l.send(text);
  }

  private heard(e: RepoEvent): void {
    if (!this.listeners.size) return;
    const branch = e.type === "head" ? e.branch : e.type === "branch" ? e.branch.name : e.task.branch;
    this.send(branch, { ...e, at: new Date().toISOString() });
    if (e.type === "head") this.validateLater(`b:${e.branch}`, { branch: e.branch });
    else if (e.type === "task" && e.task.state === "open" && ["created", "changed", "rebased", "reopened"].includes(e.change)) this.validateLater(`t:${e.task.id}`, { task: e.task.id });
  }

  private validateLater(key: string, what: { branch: string } | { task: number }): void {
    this.due.set(key, what);
    this.timer ??= setTimeout(() => this.validateDue(), this.validateAfter);
  }

  private validateDue(): void {
    this.timer = null;
    const due = [...this.due.values()];
    this.due.clear();
    if (!this.listeners.size) return;
    const at = () => new Date().toISOString();
    for (const d of due) {
      try {
        if ("branch" in d) {
          const b = this.repo.branch(d.branch);
          if (b.archived) continue;
          const v = this.repo.head(b.name).validate();
          this.send(b.name, { type: "validation", branch: b.name, commit: b.head, errors: v.errors, warnings: v.warnings, at: at() });
        } else {
          const t = this.repo.task(d.task);
          if (t.state !== "open") continue;
          const v = this.repo.view(t.id).validate(); // may rebase it first, which says so
          const now = this.repo.task(t.id);
          this.send(now.branch, { type: "validation", branch: now.branch, commit: now.base, task: now.id, errors: v.errors, warnings: v.warnings, at: at() });
        }
      } catch (err) {
        console.error(err); // one that can't be worked out doesn't stop the rest
      }
    }
  }

  private recheckTokens(): void {
    for (const l of this.listeners) {
      const p = this.auth.authenticate(l.token);
      if (!p) {
        this.listeners.delete(l);
        l.close(CLOSE_SIGNED_OUT, "Signed out: the token no longer works");
      } else l.principal = p; // a role changed takes effect
    }
  }

  /** Check tokens now, as the timer would (for tests). */
  recheckNow(): void {
    this.recheckTokens();
  }
}
