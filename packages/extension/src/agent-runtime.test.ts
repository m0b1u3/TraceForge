import { describe, expect, it } from "vitest";
import { classifyToolFailure } from "./agent-runtime.js";

describe("AgentRuntime failure classification", () => {
  it("classifies tool failures by retry policy", () => {
    expect(classifyToolFailure("HTTP 429 Too Many Requests")).toBe("transient");
    expect(classifyToolFailure("download failed: HTTP 503")).toBe("transient");
    expect(classifyToolFailure("out of scope: host is not allowed")).toBe("policy");
    expect(classifyToolFailure("浏览器未启动")).toBe("environment");
    expect(classifyToolFailure("unknown mcp server: poc")).toBe("environment");
    expect(classifyToolFailure("sh: nuclei: command not found")).toBe("permanent");
  });
});
