import { describe, expect, it } from "vitest";
import { formatTrafficTime } from "./TrafficPanel.js";

describe("formatTrafficTime", () => {
  it("renders a compact request time for traffic cards", () => {
    expect(formatTrafficTime("2026-07-07T08:09:10.000Z", "en-US", "UTC")).toBe("08:09:10");
  });
});
