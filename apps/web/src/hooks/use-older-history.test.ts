import { describe, expect, it } from "vitest";
import { mergeHistoryById } from "./use-older-history.js";

describe("mergeHistoryById", () => {
  it("prepends older records and removes page-boundary duplicates", () => {
    expect(mergeHistoryById(
      [{ id: "one" }, { id: "two" }],
      [{ id: "two" }, { id: "three" }],
    ).map((item) => item.id)).toEqual(["one", "two", "three"]);
  });
});
