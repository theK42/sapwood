import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAdmin } from "./admin.ts";
import { PROJECT, SCHEMA } from "./fixtures.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-server-"));
  dirs.push(dir);
  writeFileSync(join(dir, "schema.yaml"), SCHEMA);
  writeFileSync(join(dir, "project.yaml"), PROJECT);
  const runWith = (env: Record<string, string>, ...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const r = runAdmin(argv, { cwd: dir, env, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { r, out: out.join("\n"), err: err.join("\n") };
  };
  const run = (...argv: string[]) => runWith({}, ...argv);
  return { dir, run, runWith };
}

describe("sapwood-server", () => {
  it("init, users, tokens and serve", async () => {
    const { dir, run } = setup();
    expect(run("init", "--admin", "Ada", "--schema", "schema.yaml", "--from", "project.yaml").out).toMatch(/^Started the project on main \(commit [0-9a-f]+\), with ada as Admin/);
    expect(run("init", "--admin", "ada").r).toBe(1); // already started
    expect(run("user", "add", "bob", "--role", "editor").out).toBe("Added bob as editor.");
    expect(run("user", "add", "bob", "--role", "boss").r).toBe(2);
    const token = run("token", "bob", "--name", "laptop", "--no-land").out;
    expect(token).toMatch(/^swd_[\w-]+$/);
    expect(run("serve", "--web", "nowhere").r).toBe(2); // no web app there
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html><title>Sapwood</title>");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const s = run("serve", "--port", String(port), "--web", "web");
    expect(s.out).toBe(
      `Serving the Sapwood API on http://127.0.0.1:${port}/api\nThe web app is on http://127.0.0.1:${port}/\nGitHub sign-in is off ($SAPWOOD_GITHUB_CLIENT_ID isn't set): people need tokens from sapwood-server token.`,
    );
    const server = s.r as { close(): void };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/branches/main/entities/w1`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { damage: number }).damage).toBe(10);
      expect(await (await fetch(`http://127.0.0.1:${port}/branches/main`)).text()).toContain("<title>Sapwood");
    } finally {
      server.close();
    }
  });

  it("serve turns GitHub sign-in on from the environment", async () => {
    const { run, runWith } = setup();
    run("init", "--admin", "ada", "--schema", "schema.yaml", "--from", "project.yaml");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const s = runWith({ SAPWOOD_GITHUB_CLIENT_ID: "Iv1.abc", SAPWOOD_PUBLIC_URL: "https://sapwood.example" }, "serve", "--port", String(port));
    expect(s.out).toContain("GitHub sign-in is on: sapwood login (the web needs $SAPWOOD_GITHUB_CLIENT_SECRET too).");
    const server = s.r as { close(): void };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await res.json()).toMatchObject({ github: true });
    } finally {
      server.close();
    }
    expect(runWith({ SAPWOOD_PUBLIC_URL: "nope" }, "serve").r).toBe(2);
  });

  it("serves only a started project, and says what was typed wrong", () => {
    const { run } = setup();
    expect(run("serve").err).toContain("run sapwood-server init first");
    expect(run("init").r).toBe(2);
    expect(run("frobnicate").r).toBe(2);
    expect(run("help").out).toContain("Usage: sapwood-server");
  });
});
