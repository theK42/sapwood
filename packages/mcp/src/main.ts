#!/usr/bin/env node
// sapwood-mcp: the MCP server over stdio, for an AI tool to start. stdout is the protocol,
// so anything said to a person goes to stderr.

import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connect, createServer } from "./mcp.ts";

const HELP = `Usage: sapwood-mcp [--project <file or folder>] [--server <url>] [--branch <name>]

An MCP server over stdio, for an AI tool such as Claude Code to start, e.g.
  claude mcp add sapwood -- npx sapwood-mcp

It works where the sapwood command would: --project, else --server (or $SAPWOOD_SERVER),
else a sapwood.json here or in a folder above, else the server you last logged in to with
sapwood login. $SAPWOOD_TOKEN stands in for the saved login.

On a server, the LLM's edits go into your current task on the branch. It can't land,
merge or discard: you check the task with sapwood task status and land it yourself.`;

let opts;
try {
  opts = parseArgs({ options: { project: { type: "string" }, server: { type: "string" }, branch: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true }).values;
} catch (e) {
  process.stderr.write(`sapwood-mcp: ${(e as Error).message}\n${HELP}\n`);
  process.exit(2);
}
if (opts.help) {
  process.stderr.write(HELP + "\n");
  process.exit(0);
}
try {
  const { help: _, ...where } = opts;
  const conn = connect(where, { cwd: process.cwd(), env: process.env });
  await createServer(conn).connect(new StdioServerTransport());
  process.stderr.write(`sapwood-mcp: working on ${conn.where}\n`);
} catch (e) {
  process.stderr.write(`sapwood-mcp: ${(e as Error).message}\n`);
  process.exit(1);
}
