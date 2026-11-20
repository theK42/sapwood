import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SAPWOOD_CORE_VERSION } from "./index.ts";

describe("core", () => {
  it("exports a version", () => {
    expect(SAPWOOD_CORE_VERSION).toBe("0.0.0");
  });

  // Core runs in the browser and on the server (DESIGN §4.2). Node types are on for the
  // tests' sake, so this keeps the library itself free of Node APIs.
  it("has no Node imports outside tests", () => {
    const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/from\s+["']node:|require\(|\bprocess\./);
  });
});
