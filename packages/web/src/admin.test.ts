import { describe, expect, it } from "vitest";
import { ago, auditSaid, scopesFrom, scopesSaid, tokenState } from "./admin.ts";
import type { TokenInfo } from "./api.ts";

const token = (t: Partial<TokenInfo>): TokenInfo => ({ id: 1, user: "ana", name: "x", scopes: {}, expires: null, revoked: false, createdAt: "2026-11-01T00:00:00Z", lastUsed: null, ...t });

describe("the admin page, said plainly", () => {
  it("a token's limits and state", () => {
    expect(scopesSaid({})).toBe("as its user");
    expect(scopesSaid({ role: "editor", noLand: true, branches: ["main"] })).toBe("Editor at most · can't land · main only");
    expect(scopesSaid({ readOnly: true, noLand: true })).toBe("read-only");
    const now = Date.parse("2026-11-26T12:00:00Z");
    expect(tokenState(token({}), now)).toBe("live");
    expect(tokenState(token({ expires: "2026-11-20T00:00:00Z" }), now)).toBe("expired");
    expect(tokenState(token({ revoked: true }), now)).toBe("revoked");
  });

  it("how long ago", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    expect(ago(null, now)).toBe("never");
    expect(ago("2026-11-26T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-11-26T11:55:00Z", now)).toBe("5 minutes ago");
    expect(ago("2026-11-26T09:00:00Z", now)).toBe("3 hours ago");
    expect(ago("2026-11-25T12:00:00Z", now)).toBe("1 day ago");
    expect(ago("2026-09-01T12:00:00Z", now)).toBe("2026-09-01");
  });

  it("audit lines", () => {
    const e = (action: string, detail: Record<string, unknown>, actor = "ada") => auditSaid({ id: 1, at: "", actor, action, detail });
    expect(e("user.add", { login: "cy", role: "developer" })).toBe("added cy as Developer");
    expect(e("user.role", { login: "bob", from: "editor", to: "viewer" })).toBe("made bob Viewer (was Editor)");
    expect(e("token.create", { user: "ada", name: "laptop", scopes: {} })).toBe("made a token, “laptop”");
    expect(e("token.create", { user: "bob", name: "ci", scopes: { readOnly: true } })).toBe("made a token for bob, “ci” (read-only)");
    expect(e("branch.discard", { name: "old" })).toBe("discarded the branch old");
    expect(e("something.new", { a: 1 })).toBe('something.new {"a":1}');
  });

  it("the new-token form asks only for what narrows it", () => {
    expect(scopesFrom({ role: "", readOnly: false, noLand: false, branches: [] }, "developer")).toEqual({});
    expect(scopesFrom({ role: "developer", readOnly: false, noLand: true, branches: ["main"] }, "developer")).toEqual({ noLand: true, branches: ["main"] });
    expect(scopesFrom({ role: "viewer", readOnly: true, noLand: true, branches: [] }, "admin")).toEqual({ role: "viewer", readOnly: true });
  });
});
