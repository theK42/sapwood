// Users, roles, personal access tokens and sign-in (DESIGN §11). The first Admin is named
// when the server is set up and Admins add users by GitHub login. People sign in with
// GitHub (github.ts), which gives them a token here; `sapwood-server token` makes one too.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { now, type Db } from "./db.ts";
import { RepoError } from "./repo.ts";

export const ROLES = ["viewer", "editor", "developer", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Restrictions a token carries, beyond its user's role (§11.3). */
export interface Scopes {
  /** At most this role, below the user's own. */
  role?: Role;
  readOnly?: boolean;
  /** Edit, but a human lands (for LLMs). */
  noLand?: boolean;
  /** Only these branches. */
  branches?: string[];
}

export interface User {
  login: string;
  role: Role;
  createdAt: string;
}

export interface TokenInfo {
  id: number;
  user: string;
  name: string;
  scopes: Scopes;
  expires: string | null;
  revoked: boolean;
  createdAt: string;
  /** When it last let someone in, to within LAST_USED_STEP; null if never. */
  lastUsed: string | null;
}

/** Someone who signed in with GitHub but isn't a user here: asking for access, for an Admin to grant. */
export interface AccessRequest {
  login: string;
  firstAt: string;
  lastAt: string;
  tries: number;
}

/** One line of the audit log: who did what, when. */
export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  detail: unknown;
}

/** "Last used" is written at most this often per token, not on every request. */
const LAST_USED_STEP = 15 * 60_000;

/** Who is asking, and what their token allows. */
export interface Principal {
  login: string;
  /** The user's role, capped by the token's. */
  role: Role;
  scopes: Scopes;
  token: number;
}

export type Action = "read" | "write" | "land";

const rank = (r: Role): number => ROLES.indexOf(r);
export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);

/** GitHub logins are case-insensitive. */
const loginKey = (login: string): string => {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new RepoError("bad-request", `Not a GitHub login: ${JSON.stringify(login)}`);
  return login.toLowerCase();
};

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

export class Auth {
  readonly db: Db;
  /**
   * Open sign-up: anyone signing in with GitHub who isn't a user becomes one, with this role
   * (never Admin). Unset, they're refused, and their request for access is kept for Admins.
   */
  signupRole: Role | null = null;
  constructor(db: Db, opts: { signupRole?: Role | null } = {}) {
    this.db = db;
    if (opts.signupRole === "admin") throw new RepoError("bad-request", "Sign-up can't make Admins");
    this.signupRole = opts.signupRole ?? null;
  }

  users(): User[] {
    return this.db.all<{ login: string; role: Role; created_at: string }>("SELECT * FROM users ORDER BY login").map((r) => ({ login: r.login, role: r.role, createdAt: r.created_at }));
  }

  user(login: string): User {
    const r = this.db.one<{ login: string; role: Role; created_at: string }>("SELECT * FROM users WHERE login = ?", loginKey(login));
    if (!r) throw new RepoError("not-found", `No user ${login}`);
    return { login: r.login, role: r.role, createdAt: r.created_at };
  }

  addUser(login: string, role: Role, actor: string): User {
    const key = loginKey(login);
    if (!isRole(role)) throw new RepoError("bad-request", `Roles are ${ROLES.join(", ")}`);
    if (this.db.one("SELECT 1 FROM users WHERE login = ?", key)) throw new RepoError("exists", `There is already a user ${key}`);
    this.db.tx(() => {
      this.db.run("INSERT INTO users (login, role, created_at) VALUES (?, ?, ?)", key, role, now());
      this.db.run("DELETE FROM access_requests WHERE login = ?", key); // asked, and now granted
      this.db.audit(actor, "user.add", { login: key, role });
    });
    return this.user(key);
  }

  setRole(login: string, role: Role, actor: string): User {
    const u = this.user(login);
    if (!isRole(role)) throw new RepoError("bad-request", `Roles are ${ROLES.join(", ")}`);
    if (u.role === "admin" && role !== "admin" && this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")!.n === 1)
      throw new RepoError("state", "That's the last Admin");
    this.db.tx(() => {
      this.db.run("UPDATE users SET role = ? WHERE login = ?", role, u.login);
      this.db.audit(actor, "user.role", { login: u.login, from: u.role, to: role });
    });
    return this.user(u.login);
  }

  /** A new token for a user. The token itself is shown once; only its hash is kept. */
  createToken(login: string, opts: { name: string; scopes?: Scopes; expires?: string | null }, actor: string): { token: string; info: TokenInfo } {
    const u = this.user(login);
    const scopes = checkScopes(opts.scopes ?? {});
    if (opts.expires != null && Number.isNaN(Date.parse(opts.expires))) throw new RepoError("bad-request", `Not a date: ${opts.expires}`);
    const token = `swd_${randomBytes(24).toString("base64url")}`;
    const id = this.db.tx(() => {
      const r = this.db.run("INSERT INTO tokens (user, name, hash, scopes, expires, revoked, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)", u.login, opts.name, hash(token), JSON.stringify(scopes), opts.expires ?? null, now());
      this.db.audit(actor, "token.create", { id: r.lastInsertRowid, user: u.login, name: opts.name, scopes, expires: opts.expires ?? null });
      return r.lastInsertRowid;
    });
    return { token, info: this.token(id) };
  }

  token(id: number): TokenInfo {
    const r = this.db.one<Record<string, string | number | null>>("SELECT * FROM tokens WHERE id = ?", id);
    if (!r) throw new RepoError("not-found", `No token ${id}`);
    return tokenInfo(r);
  }

  tokens(login: string): TokenInfo[] {
    return this.db.all<Record<string, string | number | null>>("SELECT * FROM tokens WHERE user = ? ORDER BY id", loginKey(login)).map(tokenInfo);
  }

  /** Every token, everyone's (for Admins). */
  allTokens(): TokenInfo[] {
    return this.db.all<Record<string, string | number | null>>("SELECT * FROM tokens ORDER BY user, id").map(tokenInfo);
  }

  /**
   * Remove a user: their tokens are revoked (web sign-ins too) and they can't sign in. What
   * they did stays: their commits, tasks and the audit log. Not the last Admin, nor yourself.
   */
  removeUser(login: string, actor: string): User {
    const u = this.user(login);
    if (u.login === loginKey(actor)) throw new RepoError("state", "You can't remove yourself: another Admin can");
    if (u.role === "admin" && this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")!.n === 1) throw new RepoError("state", "That's the last Admin");
    this.db.tx(() => {
      this.db.run("UPDATE tokens SET revoked = 1 WHERE user = ?", u.login);
      this.db.run("DELETE FROM users WHERE login = ?", u.login);
      this.db.audit(actor, "user.remove", { login: u.login, role: u.role });
    });
    return u;
  }

  /** Who's asking for access, latest first. */
  accessRequests(): AccessRequest[] {
    return this.db
      .all<{ login: string; first_at: string; last_at: string; tries: number }>("SELECT * FROM access_requests ORDER BY last_at DESC")
      .map((r) => ({ login: r.login, firstAt: r.first_at, lastAt: r.last_at, tries: r.tries }));
  }

  /** Turn a request down (they can ask again by signing in again). */
  dismissRequest(login: string, actor: string): void {
    const key = loginKey(login);
    if (!this.db.one("SELECT 1 FROM access_requests WHERE login = ?", key)) throw new RepoError("not-found", `${key} isn't asking for access`);
    this.db.tx(() => {
      this.db.run("DELETE FROM access_requests WHERE login = ?", key);
      this.db.audit(actor, "request.dismiss", { login: key });
    });
  }

  /** The audit log, newest first: `limit` lines, before the line `before` if given. */
  auditLog(limit = 100, before?: number): AuditEntry[] {
    const rows =
      before === undefined
        ? this.db.all<Record<string, string | number>>("SELECT * FROM audit ORDER BY id DESC LIMIT ?", limit)
        : this.db.all<Record<string, string | number>>("SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?", before, limit);
    return rows.map((r) => ({ id: r.id as number, at: r.at as string, actor: r.actor as string, action: r.action as string, detail: JSON.parse(r.detail as string) as unknown }));
  }

  revokeToken(id: number, actor: string): TokenInfo {
    this.token(id);
    this.db.tx(() => {
      this.db.run("UPDATE tokens SET revoked = 1 WHERE id = ?", id);
      this.db.audit(actor, "token.revoke", { id });
    });
    return this.token(id);
  }

  /**
   * Who a GitHub account signs in as. The first sign-in binds the user to the account's
   * numeric ID, and later ones match by it, so a renamed account stays itself and someone
   * who takes its old login isn't let in. Unknown accounts are refused.
   */
  signIn(gh: { login: string; id: number }, how: string): User {
    const byId = this.db.one<{ login: string }>("SELECT login FROM users WHERE github_id = ?", gh.id);
    let login: string;
    if (byId) login = byId.login;
    else {
      const key = loginKey(gh.login);
      let u = this.db.one<{ login: string; github_id: number | null }>("SELECT login, github_id FROM users WHERE login = ?", key);
      if (!u && this.signupRole) {
        // Open sign-up: in, with the server's sign-up role.
        this.db.tx(() => {
          this.db.run("INSERT INTO users (login, role, created_at) VALUES (?, ?, ?)", key, this.signupRole, now());
          this.db.run("DELETE FROM access_requests WHERE login = ?", key);
          this.db.audit(key, "user.signup", { login: key, role: this.signupRole, github: gh });
        });
        u = { login: key, github_id: null };
      }
      if (!u) {
        // Not a user: their request is kept for an Admin to grant.
        this.db.tx(() => {
          const t = now();
          this.db.run(
            "INSERT INTO access_requests (login, first_at, last_at, tries) VALUES (?, ?, ?, 1) ON CONFLICT(login) DO UPDATE SET last_at = excluded.last_at, tries = tries + 1",
            key, t, t,
          );
          this.db.audit(key, "signin.refused", { github: gh, how });
        });
        throw new RepoError("forbidden", `${key} isn't a user of this server yet. Your request for access has gone to its Admins: sign in again once they've added you.`);
      }
      if (u.github_id !== null) {
        this.db.audit(gh.login.toLowerCase(), "signin.refused", { github: gh, how });
        throw new RepoError("forbidden", `${key} here belongs to another GitHub account`);
      }
      this.db.run("UPDATE users SET github_id = ? WHERE login = ?", gh.id, key);
      login = key;
    }
    this.db.audit(login, "signin", { github: gh, how });
    return this.user(login);
  }

  /** The principal for a bearer token, or null when it isn't a live token of a known user. */
  authenticate(token: string): Principal | null {
    const h = hash(token);
    const r = this.db.one<{ id: number; user: string; hash: string; scopes: string; expires: string | null; revoked: number }>("SELECT * FROM tokens WHERE hash = ?", h);
    if (!r || r.revoked || !timingSafeEqual(Buffer.from(r.hash), Buffer.from(h))) return null;
    if (r.expires !== null && Date.parse(r.expires) <= Date.now()) return null;
    const u = this.db.one<{ role: Role }>("SELECT role FROM users WHERE login = ?", r.user);
    if (!u) return null;
    const scopes = JSON.parse(r.scopes) as Scopes;
    const role = scopes.role !== undefined && rank(scopes.role) < rank(u.role) ? scopes.role : u.role;
    const used = (r as { last_used?: string | null }).last_used ?? null;
    if (used === null || Date.now() - Date.parse(used) > LAST_USED_STEP) this.db.run("UPDATE tokens SET last_used = ? WHERE id = ?", now(), r.id);
    return { login: r.user, role, scopes, token: r.id };
  }
}

function checkScopes(s: Scopes): Scopes {
  const out: Scopes = {};
  if (s.role !== undefined) {
    if (!isRole(s.role)) throw new RepoError("bad-request", `Roles are ${ROLES.join(", ")}`);
    out.role = s.role;
  }
  if (s.readOnly) out.readOnly = true;
  if (s.noLand) out.noLand = true;
  if (s.branches !== undefined) {
    if (!Array.isArray(s.branches) || !s.branches.every((b) => typeof b === "string")) throw new RepoError("bad-request", "branches is a list of branch names");
    out.branches = [...s.branches];
  }
  return out;
}

function tokenInfo(r: Record<string, string | number | null>): TokenInfo {
  return {
    id: r.id as number,
    user: r.user as string,
    name: r.name as string,
    scopes: JSON.parse(r.scopes as string) as Scopes,
    expires: r.expires as string | null,
    revoked: r.revoked === 1,
    createdAt: r.created_at as string,
    lastUsed: (r.last_used as string | null | undefined) ?? null,
  };
}

/**
 * May the principal do this? `need` is the least role (§11.2). A write or land also needs
 * a token that isn't read-only (or no-land), and a branch the token allows.
 */
export function allowed(p: Principal, need: Role, action: Action = "read", branch?: string): string | null {
  if (rank(p.role) < rank(need)) return `This needs the ${need} role; you have ${p.role}`;
  if (action !== "read" && p.scopes.readOnly) return "This token is read-only";
  if (action === "land" && p.scopes.noLand) return "This token can't land: a person lands its work";
  if (branch !== undefined && p.scopes.branches && !p.scopes.branches.includes(branch)) return `This token is for ${p.scopes.branches.join(", ")} only`;
  return null;
}

export function demand(p: Principal, need: Role, action: Action = "read", branch?: string): void {
  const why = allowed(p, need, action, branch);
  if (why) throw new RepoError("forbidden", why);
}
