// The MCP server hosted by the Sapwood server, at /mcp (Streamable HTTP), for Claude's custom
// connectors and anything else that connects to a remote MCP server: nothing to install.
//
// The server passes each request here with the caller's token, and a way to call its own HTTP
// API in-process. The tools then work exactly as from `sapwood-mcp` on a laptop (the same
// RemoteBackend), so every permission check is the API's. Stateless: each request makes its
// own MCP server. A branch switched to is remembered per token while the server runs.

import { createHash } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Client, RemoteBackend, type Fetch } from "@thek42/sapwood-cli/remote";
import { createServer, type Connection } from "./mcp.ts";

export interface HostContext {
  /** The server's public address, as its API is reached. */
  base: string;
  /** Its HTTP API, in-process. */
  api: Fetch;
}

/** Branch switched to, by token (hashed): main until switched. */
const branches = new Map<string, string>();

/** One MCP request (POST, GET or DELETE on /mcp), as the token's owner. */
export async function serveMcp(req: Request, token: string, ctx: HostContext): Promise<Response> {
  const key = createHash("sha256").update(token).digest("hex");
  const remote = () => ({ client: new Client(ctx.base, token, ctx.api), branch: branches.get(key) ?? "main" });
  const conn: Connection = {
    where: `the Sapwood server ${ctx.base}`,
    backend: () => {
      const r = remote();
      return new RemoteBackend(r.client, r.branch, { current: true });
    },
    remote,
    switchBranch: (name) => {
      branches.set(key, name);
      return { saved: false };
    },
  };
  const server = createServer(conn);
  // No session IDs given: stateless. Answers come as JSON, whole, not as an event stream.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
