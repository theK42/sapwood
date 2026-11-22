#!/usr/bin/env node
import { runAdmin } from "./admin.ts";

const r = runAdmin(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});
if (typeof r === "number") process.exitCode = r;
else for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => r.close());
