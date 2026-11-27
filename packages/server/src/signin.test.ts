import { describe, expect, it } from "vitest";
import { Sapwood } from "@thek42/sapwood-core";
import { Auth } from "./auth.ts";
import { Db } from "./db.ts";
import { FakeGitHub } from "./fakegithub.ts";
import { createApp } from "./http.ts";
import { PROJECT, SCHEMA } from "./fixtures.ts";
import { Repo } from "./repo.ts";

const ADA = { login: "Ada", id: 101 };
const BOB = { login: "bob", id: 202 };

function setup(opts: { github?: boolean; publicUrl?: string; signupRole?: "viewer" | "editor" } = {}) {
  const db = new Db(":memory:");
  const repo = new Repo(db);
  const auth = new Auth(db, { signupRole: opts.signupRole ?? null });
  auth.addUser("ada", "admin", "test");
  auth.addUser("bob", "editor", "test");
  repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
  const gh = new FakeGitHub({ clientSecret: "shh" });
  const app = createApp(repo, auth, { ...(opts.github === false ? {} : { github: gh.github }), ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}) });
  const post = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { db, auth, gh, app, post };
}

/** The cookies a response sets, by name. */
const cookies = (res: Response): Record<string, string> =>
  Object.fromEntries(res.headers.getSetCookie().map((c) => [c.slice(0, c.indexOf("=")), c]));
const value = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"));

describe("signing in with GitHub, by the device flow", () => {
  it("gives a Sapwood token once the code is entered at GitHub", async () => {
    const { gh, post, app, auth } = setup();
    const start = await post("/auth/device");
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ userCode: "WXYZ-0001", verificationUri: "https://github.test/login/device", interval: 5, expiresIn: 900 });
    // Not yet: the person hasn't entered the code.
    const pending = await post("/auth/device/token", { device: start.json.device });
    expect([pending.status, pending.json]).toEqual([202, { pending: true, interval: null }]);
    gh.slowDown = true;
    expect((await post("/auth/device/token", { device: start.json.device })).json).toEqual({ pending: true, interval: 10 });
    gh.approve(start.json.userCode, ADA);
    const done = await post("/auth/device/token", { device: start.json.device, name: "laptop" });
    expect(done.status).toBe(201);
    expect(done.json).toMatchObject({ login: "ada", role: "admin", token: expect.stringMatching(/^swd_/) });
    const me = await app.request("/api/me", { headers: { authorization: `Bearer ${done.json.token}` } });
    expect(((await me.json()) as { login: string }).login).toBe("ada");
    expect(auth.tokens("ada").map((t) => t.name)).toEqual(["laptop"]);
    // Nothing more than who you are was asked for: no scope.
    expect(gh.requests.every((r) => r.body.scope === undefined)).toBe(true);
    // The code is spent.
    expect((await post("/auth/device/token", { device: start.json.device })).json.error.code).toBe("state");
  });

  it("refuses GitHub accounts that aren't users here, and cancelled sign-ins", async () => {
    const { gh, post } = setup();
    let start = await post("/auth/device");
    gh.approve(start.json.userCode, { login: "mallory", id: 666 });
    const r = await post("/auth/device/token", { device: start.json.device });
    expect([r.status, r.json.error.message]).toEqual([403, "mallory isn't a user of this server yet. Your request for access has gone to its Admins: sign in again once they've added you."]);
    start = await post("/auth/device");
    gh.deny(start.json.userCode);
    expect((await post("/auth/device/token", { device: start.json.device })).status).toBe(403);
  });

  it("binds a user to their GitHub account: a rename stays them, a new owner of the old name doesn't", async () => {
    const { gh, post, db } = setup();
    const signIn = async (who: { login: string; id: number }) => {
      const start = await post("/auth/device");
      gh.approve(start.json.userCode, who);
      return post("/auth/device/token", { device: start.json.device });
    };
    expect((await signIn(BOB)).json.login).toBe("bob");
    // bob renames his GitHub account; it's still him.
    expect((await signIn({ login: "robert", id: 202 })).json.login).toBe("bob");
    // Someone else takes the name bob.
    const taken = await signIn({ login: "bob", id: 999 });
    expect([taken.status, taken.json.error.message]).toEqual([403, "bob here belongs to another GitHub account"]);
    const log = db.all<{ action: string }>("SELECT action FROM audit WHERE action LIKE 'signin%' ORDER BY id").map((r) => r.action);
    expect(log).toEqual(["signin", "signin", "signin.refused"]);
  });

  it("says so when the server has no GitHub sign-in", async () => {
    const { post } = setup({ github: false });
    const r = await post("/auth/device");
    expect([r.status, r.json.error.code]).toEqual([409, "state"]);
  });
});

describe("asking for access, and open sign-up", () => {
  const deviceSignIn = async (s: ReturnType<typeof setup>, who: { login: string; id: number }) => {
    const start = await s.post("/auth/device");
    s.gh.approve(start.json.userCode, who);
    return s.post("/auth/device/token", { device: start.json.device });
  };

  it("someone not yet a user asks for access by signing in; an Admin adds them or turns them down", async () => {
    const s = setup();
    const ada = s.auth.createToken("ada", { name: "t" }, "test").token;
    const bob = s.auth.createToken("bob", { name: "t" }, "test").token;
    const as = (t: string) => async (method: string, path: string) => {
      const res = await s.app.request(path, { method, headers: { authorization: `Bearer ${t}` } });
      return { status: res.status, json: (await res.json()) as any };
    };
    expect((await deviceSignIn(s, { login: "Cy", id: 303 })).status).toBe(403);
    await deviceSignIn(s, { login: "cy", id: 303 });
    await deviceSignIn(s, { login: "dee", id: 404 });
    expect((await as(bob)("GET", "/api/access-requests")).status).toBe(403);
    const asked = (await as(ada)("GET", "/api/access-requests")).json as { login: string; tries: number }[];
    expect(asked.map((r) => [r.login, r.tries]).sort()).toEqual([["cy", 2], ["dee", 1]]);
    // Adding them grants it: their next sign-in works, and the request is gone.
    s.auth.addUser("cy", "editor", "ada");
    expect((await deviceSignIn(s, { login: "cy", id: 303 })).json).toMatchObject({ login: "cy", role: "editor" });
    expect(((await as(ada)("GET", "/api/access-requests")).json as { login: string }[]).map((r) => r.login)).toEqual(["dee"]);
    expect((await as(ada)("DELETE", "/api/access-requests/dee")).json).toEqual({ dismissed: true });
    expect((await as(ada)("GET", "/api/access-requests")).json).toEqual([]);
    expect((await as(ada)("DELETE", "/api/access-requests/dee")).status).toBe(404);
  });

  it("with open sign-up, signing in makes you a user with the sign-up role", async () => {
    const s = setup({ signupRole: "editor" });
    expect((await deviceSignIn(s, { login: "Cy", id: 303 })).json).toMatchObject({ login: "cy", role: "editor" });
    expect(s.auth.user("cy").role).toBe("editor");
    expect(s.auth.accessRequests()).toEqual([]);
    expect(s.db.all<{ action: string }>("SELECT action FROM audit WHERE action = 'user.signup'")).toHaveLength(1);
    // Still bound to the account: someone else taking the login later isn't them.
    expect((await deviceSignIn(s, { login: "cy", id: 999 })).status).toBe(403);
    expect(() => new Auth(s.db, { signupRole: "admin" })).toThrow(/can't make Admins/);
  });

  it("on the web, a refusal goes back to the sign-in page, saying why", async () => {
    const { gh, app } = setup();
    const go = await app.request("/auth/github");
    const to = new URL(go.headers.get("location")!);
    const back = await app.request(`/auth/github/callback?code=${gh.codeFor({ login: "mallory", id: 666 })}&state=${to.searchParams.get("state")}`, {
      headers: { cookie: `sapwood_oauth_state=${value(cookies(go).sapwood_oauth_state!)}` },
    });
    expect(back.status).toBe(302);
    const where = new URL(back.headers.get("location")!, "http://x");
    expect(where.pathname).toBe("/");
    expect(where.searchParams.get("signin")).toMatch(/^mallory isn't a user of this server yet/);
  });
});

describe("signing in with GitHub, on the web", () => {
  it("goes to GitHub and back to a session cookie, which works like a token", async () => {
    const { gh, app } = setup({ publicUrl: "https://sapwood.example" });
    const go = await app.request("/auth/github");
    expect(go.status).toBe(302);
    const to = new URL(go.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://github.test/login/oauth/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe("https://sapwood.example/auth/github/callback");
    expect(to.searchParams.get("scope")).toBeNull();
    const state = cookies(go).sapwood_oauth_state!;
    expect(state).toMatch(/HttpOnly/);
    expect(state).toMatch(/Secure/);
    expect(state).toMatch(/SameSite=Lax/);
    const back = await app.request(`/auth/github/callback?code=${gh.codeFor(ADA)}&state=${to.searchParams.get("state")}`, { headers: { cookie: `sapwood_oauth_state=${value(state)}` } });
    expect([back.status, back.headers.get("location")]).toEqual([302, "/"]);
    const session = cookies(back).sapwood_session!;
    expect(session).toMatch(/HttpOnly/);
    const cookie = `sapwood_session=${value(session)}`;
    const me = await app.request("/api/me", { headers: { cookie } });
    expect(((await me.json()) as { login: string }).login).toBe("ada");
    // Writes by cookie need the header a page elsewhere can't send.
    const patch = { method: "POST", body: JSON.stringify([{ op: "set", id: "a1", fields: { speed: 1 } }]) };
    expect((await app.request("/api/branches/main/patches", { ...patch, headers: { cookie } })).status).toBe(403);
    expect((await app.request("/api/branches/main/patches", { ...patch, headers: { cookie, "x-sapwood-request": "1" } })).status).toBe(200);
    // Signing out ends the session.
    const out = await app.request("/auth/logout", { method: "POST", headers: { cookie } });
    expect(await out.json()).toEqual({ signedOut: true });
    expect((await app.request("/api/me", { headers: { cookie } })).status).toBe(401);
  });

  it("refuses a callback that didn't start here", async () => {
    const { gh, app } = setup();
    const go = await app.request("/auth/github");
    const to = new URL(go.headers.get("location")!);
    // http://localhost: the cookies aren't Secure.
    expect(to.searchParams.get("redirect_uri")).toBe("http://localhost/auth/github/callback");
    expect(cookies(go).sapwood_oauth_state).not.toMatch(/Secure/);
    const forged = await app.request(`/auth/github/callback?code=${gh.codeFor(ADA)}&state=${to.searchParams.get("state")}`);
    expect(forged.status).toBe(403);
    const wrong = await app.request(`/auth/github/callback?code=${gh.codeFor(ADA)}&state=nope`, { headers: { cookie: `sapwood_oauth_state=${value(cookies(go).sapwood_oauth_state!)}` } });
    expect(wrong.status).toBe(403);
  });
});
