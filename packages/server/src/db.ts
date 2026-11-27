// The server's SQLite database (DESIGN §12.3), through Node's built-in node:sqlite. One
// file holds the commit graph, tasks, users and tokens. Everything here is synchronous,
// so the server's writes, lands among them, happen one at a time.

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS branches (
  name TEXT PRIMARY KEY,
  parent TEXT,
  fork_commit TEXT,
  head TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  base_commit TEXT,
  base_point TEXT,
  net TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS commits (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  depth INTEGER NOT NULL,
  parent TEXT,
  parent2 TEXT,
  task INTEGER,
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commit_ops (
  commit_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  op TEXT NOT NULL,
  PRIMARY KEY (commit_id, seq)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT,
  base TEXT NOT NULL,
  state TEXT NOT NULL,
  landed_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_branch ON tasks (branch, state);
CREATE TABLE IF NOT EXISTS task_changes (
  task INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  ops TEXT NOT NULL,
  inverse TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task, seq)
);
CREATE TABLE IF NOT EXISTS current_tasks (
  user TEXT NOT NULL,
  branch TEXT NOT NULL,
  task INTEGER NOT NULL,
  PRIMARY KEY (user, branch)
);
CREATE TABLE IF NOT EXISTS snapshots (commit_id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (login TEXT PRIMARY KEY, role TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  expires TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;

export type Row = Record<string, string | number | null>;
type Param = string | number | null;

export class Db {
  readonly sql: DatabaseSync;
  private depth = 0;
  /** Waiting for the transaction to commit (afterCommit). */
  private readonly committed: (() => void)[] = [];

  /** Open (or create) the database file; ":memory:" for tests. */
  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.sql.exec(SCHEMA);
    // Databases made before branches kept their net change (2026-11-21).
    const cols = new Set(this.all<{ name: string }>("PRAGMA table_info(branches)").map((c) => c.name));
    if (!cols.has("net"))
      this.sql.exec("ALTER TABLE branches ADD COLUMN base_commit TEXT; ALTER TABLE branches ADD COLUMN base_point TEXT; ALTER TABLE branches ADD COLUMN net TEXT NOT NULL DEFAULT '[]'; UPDATE branches SET base_commit = fork_commit, base_point = fork_commit WHERE parent IS NOT NULL;");
    // A task's revision, which a browser's copy of the task is checked against (2026-11-22).
    if (!this.all<{ name: string }>("PRAGMA table_info(tasks)").some((c) => c.name === "rev")) this.sql.exec("ALTER TABLE tasks ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;");
    // When each token was last used (2026-11-26), for the admin page.
    if (!this.all<{ name: string }>("PRAGMA table_info(tokens)").some((c) => c.name === "last_used")) this.sql.exec("ALTER TABLE tokens ADD COLUMN last_used TEXT;");
    // The GitHub account a user signed in with first, by its numeric ID (logins can be renamed).
    if (!this.all<{ name: string }>("PRAGMA table_info(users)").some((c) => c.name === "github_id"))
      this.sql.exec("ALTER TABLE users ADD COLUMN github_id INTEGER; CREATE UNIQUE INDEX users_github_id ON users (github_id);");
  }

  all<T = Row>(query: string, ...params: Param[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  one<T = Row>(query: string, ...params: Param[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  run(query: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.sql.prepare(query).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Run `fn` in one transaction: all of it is written, or none. Nests. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.sql.exec("BEGIN IMMEDIATE");
    this.depth++;
    let out: T;
    try {
      out = fn();
      this.sql.exec("COMMIT");
    } catch (e) {
      this.sql.exec("ROLLBACK");
      this.committed.length = 0;
      throw e;
    } finally {
      this.depth--;
    }
    for (const f of this.committed.splice(0)) f();
    return out;
  }

  /** Run `fn` once what's being written now is committed: now, outside a transaction; never, if it's rolled back. */
  afterCommit(fn: () => void): void {
    if (this.depth > 0) this.committed.push(fn);
    else fn();
  }

  meta(key: string): string | undefined {
    return this.one<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  audit(actor: string, action: string, detail: unknown): void {
    this.run("INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)", now(), actor, action, JSON.stringify(detail));
  }

  close(): void {
    this.sql.close();
  }
}

export const now = (): string => new Date().toISOString();
