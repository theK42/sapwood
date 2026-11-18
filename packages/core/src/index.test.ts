import { describe, expect, it } from "vitest";
import { SAPWOOD_CORE_VERSION } from "./index.ts";

describe("core", () => {
  it("exports a version", () => {
    expect(SAPWOOD_CORE_VERSION).toBe("0.0.0");
  });
});
