import { describe, expect, it } from "vitest";
import { inOrder, moveIn } from "./typeOrder.ts";

const items = [{ id: "t1" }, { id: "t2" }, { id: "t3" }, { id: "t4" }];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("your own type order", () => {
  it("puts saved types first, in that order; the rest follow as they came", () => {
    expect(ids(inOrder(items, []))).toEqual(["t1", "t2", "t3", "t4"]);
    expect(ids(inOrder(items, ["t3", "t1"]))).toEqual(["t3", "t1", "t2", "t4"]);
    // A type that's gone is passed over.
    expect(ids(inOrder(items, ["t9", "t4"]))).toEqual(["t4", "t1", "t2", "t3"]);
  });

  it("moves one before or after another", () => {
    const shown = ["t1", "t2", "t3", "t4"];
    expect(moveIn(shown, "t4", "t1", "before")).toEqual(["t4", "t1", "t2", "t3"]);
    expect(moveIn(shown, "t1", "t3", "after")).toEqual(["t2", "t3", "t1", "t4"]);
    expect(moveIn(shown, "t2", "t2", "after")).toEqual(shown);
    expect(moveIn(shown, "t2", "nope", "after")).toEqual(shown);
  });
});
