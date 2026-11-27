// The MCP server hosted by the Sapwood server at /mcp, reached as a remote MCP client would:
// over HTTP, with a bearer token.

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it } from "vitest";
import { Sapwood } from "@thek42/sapwood-core";
import { Auth, createApp, Db, Repo } from "@thek42/sapwood-server";
import { serveMcp } from "./http.ts";

const SCHEMA = "types:\n  Ammo: { fields: { speed: float } }\n";
const PROJECT = "sheets:\n  - name: Ammo\n    rows:\n      - [Ammo, a1, 900]\n";
const BASE = "http://sapwood.test";

function setup() {
  const db = new Db(":memory:");
  const repo = new Repo(db);
  const auth = new Auth(db);
  auth.addUser("ada", "admin", "test");
  auth.addUser("vic", "viewer", "test");
  repo.init(Sapwood.load(SCHEMA, PROJECT).doc, "ada");
  const app = createApp(repo, auth, { mcp: serveMcp, publicUrl: BASE });
  const fetch = (url: string | URL, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)));
  /** A remote MCP client, signed in with a token (or not). */
  const connect = async (token?: string) => {
    const client = new McpClient({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch,
      ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
    });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join("\n"), error: r.isError === true };
    };
    return { client, call };
  };
  return { auth, repo, app, fetch, connect, token: (login: string) => auth.createToken(login, { name: "Claude" }, login).token };
}

describe("MCP hosted at /mcp", () => {
  it("reads and edits as the token's owner, into their current task, with the server's permissions", async () => {
    const s = setup();
    const ada = await s.connect(s.token("ada"));
    expect(ada.client.getInstructions()).toContain(`This connection works on the Sapwood server ${BASE}.`);
    const tools = (await ada.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("patch");
    expect(tools).not.toContain("land");
    expect(JSON.parse((await ada.call("get", { id: "a1" })).text)).toMatchObject({ $id: "a1", speed: 900 });
    const w = await ada.call("patch", { patches: [{ op: "set", id: "a1", fields: { speed: 1000 } }] });
    expect(w).toEqual({ error: false, text: "Applied 1 patch (in task 1).\nValidation now: 0 errors, 0 warnings." });
    // In ada's task, not landed: main is as it was.
    expect(s.repo.head("main").get("a1").speed).toBe(900);
    expect(JSON.parse((await ada.call("task_status")).text)).toMatchObject({ task: { id: 1, changes: 1 } });
    // A Viewer reads, but the API refuses their writes.
    const vic = await s.connect(s.token("vic"));
    expect(JSON.parse((await vic.call("get", { id: "a1" })).text).speed).toBe(900);
    expect((await vic.call("patch", { patches: [{ op: "set", id: "a1", fields: { speed: 1 } }] })).text).toMatch(/\[forbidden\]$/);
  });

  it("without a token, it's refused, saying where a connector finds how to sign in", async () => {
    const s = setup();
    const res = await s.fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    // A session cookie doesn't do for MCP: tokens only.
    const t = s.token("ada");
    expect((await s.fetch(`${BASE}/mcp`, { method: "POST", headers: { cookie: `sapwood_session=${t}` }, body: "{}" })).status).toBe(401);
    // Revoked, it stops.
    const id = s.auth.tokens("ada").find((x) => x.name === "Claude")!.id;
    s.auth.revokeToken(id, "ada");
    await expect(s.connect(t)).rejects.toThrow();
  });
});

describe("signing in a connector with OAuth (as Claude's custom connectors do)", () => {
  /** A connector: it registers, sends the person to sign in, and keeps what it's given. */
  const connector = (opened: URL[]) => {
    const kept: { client?: unknown; tokens?: unknown; verifier?: string } = {};
    const provider: OAuthClientProvider = {
      redirectUrl: "https://claude.example/api/mcp/auth_callback",
      clientMetadata: { client_name: "Claude", redirect_uris: ["https://claude.example/api/mcp/auth_callback"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" },
      clientInformation: () => kept.client as never,
      saveClientInformation: (c) => void (kept.client = c),
      tokens: () => kept.tokens as never,
      saveTokens: (t) => void (kept.tokens = t),
      redirectToAuthorization: (u) => void opened.push(u),
      saveCodeVerifier: (v) => void (kept.verifier = v),
      codeVerifier: () => kept.verifier!,
    };
    return { provider, kept };
  };

  it("discovers, registers, has the person sign in and allow, and gets a token that works for MCP", async () => {
    const s = setup();
    const opened: URL[] = [];
    const { provider, kept } = connector(opened);
    const transport = () => new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: s.fetch, authProvider: provider });
    const first = new McpClient({ name: "claude", version: "0" });
    const t1 = transport();
    await expect(first.connect(t1)).rejects.toBeInstanceOf(UnauthorizedError);
    // It found the server and registered itself, then sent the person to authorize.
    expect(opened).toHaveLength(1);
    const authorize = opened[0]!;
    expect(authorize.origin + authorize.pathname).toBe(`${BASE}/oauth/authorize`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    // Not signed in: the page asks them to sign in first.
    const anon = await s.fetch(authorize.toString());
    expect(await anon.text()).toContain("Sign in to Sapwood");
    // Signed in (the web's session cookie): the page asks them to agree.
    const session = s.token("ada");
    const page = await s.fetch(authorize.toString(), { headers: { cookie: `sapwood_session=${session}` } });
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const htmlText = await page.text();
    expect(htmlText).toContain("Connect Claude?");
    expect(htmlText).toContain("It can't land");
    const nonce = /sapwood_consent=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")![1]!;
    const fields = Object.fromEntries([...htmlText.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!.replaceAll("&amp;", "&")]));
    // Without the page's nonce cookie, an Allow posted from elsewhere doesn't count.
    const forged = await s.fetch(`${BASE}/oauth/authorize`, { method: "POST", headers: { cookie: `sapwood_session=${session}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, decision: "allow" }).toString() });
    expect(forged.status).toBe(403);
    const allowed = await s.fetch(`${BASE}/oauth/authorize`, {
      method: "POST",
      headers: { cookie: `sapwood_session=${session}; sapwood_consent=${nonce}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...fields, decision: "allow" }).toString(),
    });
    expect(allowed.status).toBe(302);
    const back = new URL(allowed.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("https://claude.example/api/mcp/auth_callback");
    const code = back.searchParams.get("code")!;
    expect(back.searchParams.get("state")).toBe(authorize.searchParams.get("state"));
    // The connector trades the code for a token, then connects.
    await t1.finishAuth(code);
    const second = new McpClient({ name: "claude", version: "0" });
    await second.connect(transport());
    const r = (await second.callTool({ name: "get", arguments: { id: "a1" } })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ $id: "a1" });
    // The token is ada's, named for the connector, to revoke under Your tokens.
    expect(s.auth.tokens("ada").map((t) => t.name)).toContain("Claude (connector)");
    expect((kept.tokens as { access_token: string }).access_token).toMatch(/^swd_/);
    // The code was for once only.
    const again = await s.fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: kept.verifier! }).toString() });
    expect((await again.json()) as { error: string }).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses what it shouldn't: unregistered places to go back to, no PKCE, Cancel", async () => {
    const s = setup();
    const reg = await s.fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Bad", redirect_uris: ["http://evil.example/cb"] }) });
    expect(reg.status).toBe(400);
    const ok = (await (await s.fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Tool", redirect_uris: ["http://localhost:3333/cb"] }) })).json()) as { client_id: string };
    const q = (extra: Record<string, string>) => `${BASE}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: ok.client_id, redirect_uri: "http://localhost:3333/cb", state: "s1", code_challenge: "x".repeat(43), code_challenge_method: "S256", ...extra })}`;
    expect((await s.fetch(q({ redirect_uri: "http://localhost:4444/elsewhere" }))).status).toBe(400);
    const noPkce = await s.fetch(q({ code_challenge_method: "plain" }));
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const meta = (await (await s.fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as { code_challenge_methods_supported: string[] };
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect((await s.fetch(`${BASE}/.well-known/openid-configuration`)).status).toBe(404);
  });
});
