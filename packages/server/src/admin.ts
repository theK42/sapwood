// The sapwood-server command: set up a server's database, add users, make tokens, serve.
// These run on the server's machine, with direct access to the database file.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { docFromJson, Sapwood } from "@thek42/sapwood-core";
import { Auth, isRole, type Scopes } from "./auth.ts";
import { Db } from "./db.ts";
import { GitHub, type GitHubConfig } from "./github.ts";
import { createApp, type AppOptions } from "./http.ts";
import { Repo, RepoError } from "./repo.ts";

export interface AdminIo {
  cwd: string;
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
}

const HELP = `Usage: sapwood-server <command> [options]

  init --admin <github login> [--schema <file>] [--from <project.yaml> | --doc <sapwood.json>]
                         Make the database, its first Admin and the project's first commit
  user add <login> --role <viewer|editor|developer|admin>
  token <login> --name <name> [--role <r>] [--read-only] [--no-land] [--branch <b>]… [--expires <date>]
                         Make a personal access token; it is shown once
  serve [--port <n>] [--host <h>] [--url <public url>]
                         Serve the HTTP API (default 127.0.0.1:8417)

Every command takes --db <file> (default: $SAPWOOD_DB, else ./sapwood.sqlite).

GitHub sign-in needs a GitHub OAuth app, with its device flow enabled. serve reads:
  $SAPWOOD_GITHUB_CLIENT_ID      the app's client ID: enough for sapwood login
  $SAPWOOD_GITHUB_CLIENT_SECRET  its secret, for signing in on the web
  $SAPWOOD_PUBLIC_URL (or --url) where browsers reach the server; the app's callback
                                 URL is this plus /auth/github/callback`;

class Usage extends Error {}

/** Run one command. Returns the exit status (0 done, 1 failed, 2 typed wrong), or the running server for `serve`. */
export function runAdmin(argv: string[], io: AdminIo): number | { close(): void } {
  try {
    return admin(argv, io);
  } catch (e) {
    if (e instanceof Usage) {
      io.err(`sapwood-server: ${e.message}`);
      io.err("Run sapwood-server help for the commands.");
      return 2;
    }
    io.err(`sapwood-server: ${(e as Error).message}`);
    return 1;
  }
}

function admin(argv: string[], io: AdminIo): number | { close(): void } {
  const [cmd, ...rest] = argv;
  const parse = (args: string[], options: NonNullable<Parameters<typeof parseArgs>[0]>["options"] = {}) => {
    try {
      return parseArgs({ args, options: { db: { type: "string" }, ...options }, allowPositionals: true, strict: true }) as {
        values: Record<string, string | boolean | string[] | undefined>;
        positionals: string[];
      };
    } catch (e) {
      throw new Usage((e as Error).message);
    }
  };
  const open = (v: Record<string, unknown>) => new Db(resolve(io.cwd, (v.db as string | undefined) ?? io.env.SAPWOOD_DB ?? "sapwood.sqlite"));
  const read = (f: unknown) => readFileSync(resolve(io.cwd, f as string), "utf8");

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      io.out(HELP);
      return 0;

    case "init": {
      const p = parse(rest, { admin: { type: "string" }, schema: { type: "string" }, from: { type: "string" }, doc: { type: "string" } });
      if (p.values.admin === undefined) throw new Usage("Expected --admin <github login>");
      if (p.values.doc !== undefined && (p.values.schema !== undefined || p.values.from !== undefined)) throw new Usage("Pass --doc, or --schema and --from, not both");
      const s =
        p.values.doc !== undefined
          ? Sapwood.fromDoc(docFromJson(JSON.parse(read(p.values.doc))))
          : Sapwood.load(p.values.schema === undefined ? "" : read(p.values.schema), p.values.from === undefined ? { sheets: [] } : read(p.values.from));
      const db = open(p.values);
      try {
        const repo = new Repo(db);
        if (repo.initialized) throw new RepoError("exists", "This database already has a project");
        const auth = new Auth(db);
        const u = auth.addUser(p.values.admin as string, "admin", "sapwood-server");
        const c = repo.init(s.doc, u.login);
        io.out(`Started the project on main (commit ${c.id}), with ${u.login} as Admin. Next: sapwood-server token ${u.login} --name <name>`);
      } finally {
        db.close();
      }
      return 0;
    }

    case "user": {
      const [sub, ...args] = rest;
      if (sub !== "add") throw new Usage("Expected user add <login> --role <role>");
      const p = parse(args, { role: { type: "string" } });
      const [login] = p.positionals;
      if (login === undefined || !isRole(p.values.role)) throw new Usage("Expected user add <login> --role <viewer|editor|developer|admin>");
      const db = open(p.values);
      try {
        const u = new Auth(db).addUser(login, p.values.role, "sapwood-server");
        io.out(`Added ${u.login} as ${u.role}.`);
      } finally {
        db.close();
      }
      return 0;
    }

    case "token": {
      const p = parse(rest, {
        name: { type: "string" },
        role: { type: "string" },
        "read-only": { type: "boolean" },
        "no-land": { type: "boolean" },
        branch: { type: "string", multiple: true },
        expires: { type: "string" },
      });
      const [login] = p.positionals;
      if (login === undefined || p.values.name === undefined) throw new Usage("Expected token <login> --name <name>");
      const scopes: Scopes = {};
      if (p.values.role !== undefined) {
        if (!isRole(p.values.role)) throw new Usage("--role is viewer, editor, developer or admin");
        scopes.role = p.values.role;
      }
      if (p.values["read-only"]) scopes.readOnly = true;
      if (p.values["no-land"]) scopes.noLand = true;
      if (p.values.branch) scopes.branches = p.values.branch as string[];
      const db = open(p.values);
      try {
        const { token } = new Auth(db).createToken(login, { name: p.values.name as string, scopes, expires: (p.values.expires as string | undefined) ?? null }, "sapwood-server");
        io.out(token);
      } finally {
        db.close();
      }
      return 0;
    }

    case "serve": {
      const p = parse(rest, { port: { type: "string" }, host: { type: "string" }, url: { type: "string" } });
      const port = Number(p.values.port ?? io.env.PORT ?? 8417);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Usage(`Not a port: ${p.values.port}`);
      const hostname = (p.values.host as string | undefined) ?? "127.0.0.1";
      const options: AppOptions = {};
      const publicUrl = (p.values.url as string | undefined) ?? io.env.SAPWOOD_PUBLIC_URL;
      if (publicUrl !== undefined) {
        if (!/^https?:\/\/[^/]+/.test(publicUrl)) throw new Usage(`Not a URL: ${publicUrl}`);
        options.publicUrl = publicUrl;
      }
      const clientId = io.env.SAPWOOD_GITHUB_CLIENT_ID;
      if (clientId) {
        const config: GitHubConfig = { clientId };
        if (io.env.SAPWOOD_GITHUB_CLIENT_SECRET) config.clientSecret = io.env.SAPWOOD_GITHUB_CLIENT_SECRET;
        options.github = new GitHub(config);
      }
      const db = open(p.values);
      const repo = new Repo(db);
      if (!repo.initialized) {
        db.close();
        throw new RepoError("state", "This database has no project: run sapwood-server init first");
      }
      const server = serve({ fetch: createApp(repo, new Auth(db), options).fetch, port, hostname });
      io.out(`Serving the Sapwood API on http://${hostname}:${port}/api`);
      io.out(
        !clientId
          ? "GitHub sign-in is off ($SAPWOOD_GITHUB_CLIENT_ID isn't set): people need tokens from sapwood-server token."
          : `GitHub sign-in is on: sapwood login${options.github!.clientSecret ? ", and the web" : " (the web needs $SAPWOOD_GITHUB_CLIENT_SECRET too)"}.`,
      );
      return {
        close() {
          server.close();
          db.close();
        },
      };
    }

    default:
      throw new Usage(`Unknown command ${cmd}`);
  }
}
