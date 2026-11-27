// The admin page and your tokens, said plainly: what a token may do, what an audit-log line
// records, how long ago something was. Apart from React, so it's tested in Node.

import type { AuditEntry, Role, Scopes, TokenInfo } from "./api.ts";

export const ROLES: Role[] = ["viewer", "editor", "developer", "admin"];
export const ROLE_LABEL: Record<Role, string> = { viewer: "Viewer", editor: "Editor", developer: "Developer", admin: "Admin" };
/** What each role may do (DESIGN §11.2), for the role pickers. */
export const ROLE_SAYS: Record<Role, string> = {
  viewer: "reads everything",
  editor: "edits data and sheets, and lands",
  developer: "also the schema and packs",
  admin: "also people and tokens",
};

/** A token's limits beyond its user's role: "Editor at most · read-only · main, dev only". */
export function scopesSaid(s: Scopes): string {
  const parts: string[] = [];
  if (s.role) parts.push(`${ROLE_LABEL[s.role]} at most`);
  if (s.readOnly) parts.push("read-only");
  else if (s.noLand) parts.push("can't land");
  if (s.branches) parts.push(s.branches.length ? `${s.branches.join(", ")} only` : "no branches");
  return parts.length ? parts.join(" · ") : "as its user";
}

/** Live, revoked or expired. */
export function tokenState(t: TokenInfo, now = Date.now()): "live" | "revoked" | "expired" {
  if (t.revoked) return "revoked";
  if (t.expires !== null && Date.parse(t.expires) <= now) return "expired";
  return "live";
}

/** "just now", "5 minutes ago", "3 days ago", or the date beyond a month. */
export function ago(at: string | null, now = Date.now()): string {
  if (at === null) return "never";
  const ms = now - Date.parse(at);
  if (Number.isNaN(ms)) return at;
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  if (d <= 31) return `${d} ${d === 1 ? "day" : "days"} ago`;
  return at.slice(0, 10);
}

/** An audit-log line in words (without who and when, which are shown beside it). */
export function auditSaid(e: AuditEntry): string {
  const d = e.detail as Record<string, unknown>;
  const s = (k: string) => String(d[k] ?? "?");
  switch (e.action) {
    case "user.add":
      return `added ${s("login")} as ${ROLE_LABEL[d.role as Role] ?? s("role")}`;
    case "user.role":
      return `made ${s("login")} ${ROLE_LABEL[d.to as Role] ?? s("to")} (was ${ROLE_LABEL[d.from as Role] ?? s("from")})`;
    case "user.remove":
      return `removed ${s("login")}`;
    case "token.create": {
      const who = d.user === e.actor ? "" : ` for ${s("user")}`;
      const limits = scopesSaid((d.scopes ?? {}) as Scopes);
      return `made a token${who}, “${s("name")}”${limits === "as its user" ? "" : ` (${limits})`}`;
    }
    case "token.revoke":
      return `revoked token ${s("id")}`;
    case "signin":
      return `signed in${d.how ? ` (${s("how")})` : ""}`;
    case "signin.refused":
      return "was refused sign-in";
    case "user.signup":
      return `signed up, as ${ROLE_LABEL[d.role as Role] ?? s("role")}`;
    case "request.dismiss":
      return `turned down ${s("login")}'s request for access`;
    case "branch.discard":
      return `discarded the branch ${s("name")}`;
    case "branch.restore":
      return `brought back the branch ${s("name")}`;
    default:
      return `${e.action} ${JSON.stringify(d)}`;
  }
}

/** The scopes the new-token form asks for: only what narrows the token. */
export function scopesFrom(form: { role: Role | ""; readOnly: boolean; noLand: boolean; branches: string[] }, mine: Role): Scopes {
  const s: Scopes = {};
  if (form.role && ROLES.indexOf(form.role) < ROLES.indexOf(mine)) s.role = form.role;
  if (form.readOnly) s.readOnly = true;
  else if (form.noLand) s.noLand = true;
  if (form.branches.length) s.branches = [...form.branches];
  return s;
}
