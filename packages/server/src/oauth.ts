// OAuth for the hosted MCP server (DESIGN §9.4), as MCP's authorization spec asks of a remote
// server: how Claude's custom connectors (the Desktop app, claude.ai) sign in. The connector
// finds this server's metadata, registers itself (dynamic client registration: a public
// client, no secret), sends the person here to sign in (with GitHub, as on the web) and agree,
// and trades the code it's given (with PKCE) for an ordinary Sapwood token, named for the
// client. That token is in the person's Your tokens, to revoke like any other. MCP can't land,
// whatever the token: a person lands what it did.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Auth } from "./auth.ts";
import { now, type Db } from "./db.ts";
import { RepoError } from "./repo.ts";

export interface OAuthDeps {
  db: Db;
  auth: Auth;
  /** The server's public address. */
  base(c: Context): string;
  /** The session cookie's name, and whether GitHub sign-in is on (where to send someone not signed in). */
  session: string;
  github: boolean;
}

const CODE_MINUTES = 5;
const CONSENT = "sapwood_consent";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

/** Where a client may be sent back to: https, or http on this machine (for local tools). */
function goodRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string") return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** A small page of its own (the web app isn't involved), dark or light as the system is. */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #f6f7f5; --panel: #fff; --text: #1d2420; --muted: #5f6b64; --line: #d9ded9; --accent: #2f7d4f; }
@media (prefers-color-scheme: dark) { :root { --bg: #151816; --panel: #1d211e; --text: #e6ebe7; --muted: #9aa59e; --line: #333a35; --accent: #5fb383; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 24px; max-width: 440px; margin: 16px; }
h1 { font-size: 18px; margin: 0 0 12px; } p { margin: 0 0 12px; } .muted { color: var(--muted); font-size: 13px; }
.row { display: flex; gap: 8px; margin-top: 16px; } button, a.button { font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--line); background: none; color: var(--text); cursor: pointer; text-decoration: none; }
button.primary, a.button.primary { background: var(--accent); border-color: var(--accent); color: #fff; } code { font-size: 13px; }
</style></head><body><main>${body}</main></body></html>`;
}

function html(c: Context, body: string, status = 200) {
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'");
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", "no-store");
  return c.html(body, status as 200);
}

export function oauthRoutes(app: Hono<any>, d: OAuthDeps): void {
  const { db, auth } = d;
  const cors = (c: Context) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Headers", "content-type, authorization, mcp-protocol-version");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  };
  for (const path of ["/.well-known/*", "/oauth/register", "/oauth/token"]) app.options(path, (c) => (cors(c), c.body(null, 204)));

  // ---- discovery: the resource, and the server that signs people in for it
  const resource = (c: Context) => ({
    resource: `${d.base(c)}/mcp`,
    authorization_servers: [d.base(c)],
    bearer_methods_supported: ["header"],
    resource_name: "Sapwood",
  });
  app.get("/.well-known/oauth-protected-resource", (c) => (cors(c), c.json(resource(c))));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => (cors(c), c.json(resource(c))));
  const metadata = (c: Context) => {
    const b = d.base(c);
    return {
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    };
  };
  app.get("/.well-known/oauth-authorization-server", (c) => (cors(c), c.json(metadata(c))));

  // ---- dynamic client registration (RFC 7591): public clients, no secret
  app.post("/oauth/register", async (c) => {
    cors(c);
    let b: Record<string, unknown>;
    try {
      b = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_client_metadata", error_description: "Send the client's metadata as JSON" }, 400);
    }
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every(goodRedirect))
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris: https addresses (or http on localhost)" }, 400);
    const name = typeof b.client_name === "string" && b.client_name.trim() ? b.client_name.trim().slice(0, 80) : "An MCP client";
    const id = `mcp_${b64url(randomBytes(16))}`;
    db.run("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)", id, name, JSON.stringify(uris), now());
    return c.json(
      { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris, grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" },
      201,
    );
  });

  const client = (id: unknown) => {
    if (typeof id !== "string") return null;
    const r = db.one<{ id: string; name: string; redirect_uris: string }>("SELECT * FROM oauth_clients WHERE id = ?", id);
    return r ? { id: r.id, name: r.name, redirectUris: JSON.parse(r.redirect_uris) as string[] } : null;
  };

  // ---- the person's part: signed in, then agreeing
  /** The authorize request, checked. Errors that can't go back to the client are shown here. */
  const request = (c: Context, q: Record<string, string | undefined>) => {
    const cl = client(q.client_id);
    if (!cl) return { fail: "This app isn't registered with this server. Add the connector again." } as const;
    if (!q.redirect_uri || !cl.redirectUris.includes(q.redirect_uri)) return { fail: "This app asked to go back somewhere it didn't register." } as const;
    const back = (params: Record<string, string>) => {
      const u = new URL(q.redirect_uri!);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (q.state) u.searchParams.set("state", q.state);
      return u.toString();
    };
    if (q.response_type !== "code") return { error: back({ error: "unsupported_response_type" }) } as const;
    if (!q.code_challenge || q.code_challenge_method !== "S256") return { error: back({ error: "invalid_request", error_description: "PKCE with S256 is required" }) } as const;
    if (q.resource !== undefined && q.resource.replace(/\/+$/, "") !== `${d.base(c)}/mcp`) return { error: back({ error: "invalid_target", error_description: "This server's resource is its /mcp" }) } as const;
    return { client: cl, back, q } as const;
  };

  app.get("/oauth/authorize", (c) => {
    const q = c.req.query();
    const r = request(c, q);
    if ("fail" in r) return html(c, page("Sapwood", `<h1>Can't connect</h1><p>${esc(r.fail!)}</p>`), 400);
    if ("error" in r) return c.redirect(r.error!);
    const session = getCookie(c, d.session);
    const me = session ? auth.authenticate(session) : null;
    const here = new URL(c.req.url);
    const self = `/oauth/authorize${here.search}`;
    if (!me) {
      const signIn = d.github
        ? `<div class="row"><a class="button primary" href="/auth/github?return=${encodeURIComponent(self)}">Sign in with GitHub</a></div>`
        : `<p>Sign in to <a href="/">this Sapwood</a> first (with a token), then connect again.</p>`;
      return html(c, page("Sign in to Sapwood", `<h1>Sign in to Sapwood</h1><p><b>${esc(r.client.name)}</b> wants to connect to this Sapwood. Sign in first.</p>${signIn}`));
    }
    // A one-time value tying the Allow button to this page (a page elsewhere can't post it).
    const nonce = b64url(randomBytes(18));
    setCookie(c, CONSENT, nonce, { httpOnly: true, secure: d.base(c).startsWith("https:"), sameSite: "Lax", path: "/oauth", maxAge: 600 });
    const hidden = Object.entries(q)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v ?? "")}">`)
      .join("");
    const to = new URL(q.redirect_uri!).host;
    return html(
      c,
      page(
        "Connect to Sapwood",
        `<h1>Connect ${esc(r.client.name)}?</h1>
<p><b>${esc(r.client.name)}</b> wants to work in this Sapwood as <b>${esc(me.login)}</b> (${esc(me.role)}).</p>
<p>It can read the project, and change it in your current task, as you could. It can't land: you review and land what it did.</p>
<p class="muted">It goes back to <code>${esc(to)}</code>. You can disconnect it any time, under Your tokens.</p>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="nonce" value="${nonce}">
<div class="row"><button class="primary" name="decision" value="allow">Allow</button><button name="decision" value="deny">Cancel</button></div></form>`,
      ),
    );
  });

  app.post("/oauth/authorize", async (c) => {
    const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
    const want = getCookie(c, CONSENT) ?? "";
    const got = form.nonce ?? "";
    if (!want || want.length !== got.length || !timingSafeEqual(Buffer.from(want), Buffer.from(got))) throw new RepoError("forbidden", "This approval didn't come from this server's page, or took too long: connect again");
    const session = getCookie(c, d.session);
    const me = session ? auth.authenticate(session) : null;
    if (!me) throw new RepoError("forbidden", "Sign in to Sapwood first, then connect again");
    const r = request(c, form);
    if ("fail" in r) return html(c, page("Sapwood", `<h1>Can't connect</h1><p>${esc(r.fail!)}</p>`), 400);
    if ("error" in r) return c.redirect(r.error!);
    if (form.decision !== "allow") return c.redirect(r.back({ error: "access_denied" }));
    const code = b64url(randomBytes(24));
    db.run(
      "INSERT INTO oauth_codes (hash, client, redirect_uri, challenge, login, expires) VALUES (?, ?, ?, ?, ?, ?)",
      sha(code), r.client.id, form.redirect_uri!, form.code_challenge!, me.login, new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
    );
    db.audit(me.login, "oauth.allow", { client: r.client.id, name: r.client.name });
    return c.redirect(r.back({ code }));
  });

  // ---- the code, for a token
  app.post("/oauth/token", async (c) => {
    cors(c);
    c.header("Cache-Control", "no-store");
    const type = c.req.header("content-type") ?? "";
    const b = (type.includes("json") ? await c.req.json().catch(() => ({})) : await c.req.parseBody()) as Record<string, unknown>;
    const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
    const fail = (error: string, description: string) => c.json({ error, error_description: description }, 400);
    if (s("grant_type") !== "authorization_code") return fail("unsupported_grant_type", "Only authorization_code");
    const code = s("code");
    const verifier = s("code_verifier");
    if (!code || !verifier) return fail("invalid_request", "code and code_verifier are required");
    const row = db.one<{ hash: string; client: string; redirect_uri: string; challenge: string; login: string; expires: string }>("SELECT * FROM oauth_codes WHERE hash = ?", sha(code));
    // Once only, whatever happens next.
    db.run("DELETE FROM oauth_codes WHERE hash = ? OR expires < ?", sha(code), now());
    if (!row || Date.parse(row.expires) < Date.now()) return fail("invalid_grant", "That code is spent or expired: connect again");
    if (s("client_id") !== undefined && s("client_id") !== row.client) return fail("invalid_grant", "That code is another client's");
    if (s("redirect_uri") !== undefined && s("redirect_uri") !== row.redirect_uri) return fail("invalid_grant", "redirect_uri doesn't match");
    if (b64url(createHash("sha256").update(verifier).digest()) !== row.challenge) return fail("invalid_grant", "The code_verifier doesn't match");
    const cl = client(row.client);
    const { token } = auth.createToken(row.login, { name: `${cl?.name ?? "An MCP client"} (connector)` }, row.login);
    return c.json({ access_token: token, token_type: "Bearer" });
  });
}
