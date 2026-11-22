// Users, roles and personal access tokens (DESIGN §11). GitHub sign-in comes later; for
// now the first Admin is named when the server is set up, Admins add users by GitHub
// login, and tokens are made with `sapwood-server token` or over the API.

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
}

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
  constructor(db: Db) {
    this.db = db;
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

  revokeToken(id: number, actor: string): TokenInfo {
    this.token(id);
    this.db.tx(() => {
      this.db.run("UPDATE tokens SET revoked = 1 WHERE id = ?", id);
      this.db.audit(actor, "token.revoke", { id });
    });
    return this.token(id);
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
