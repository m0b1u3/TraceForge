import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_DEFS, dispatchTool } from "./server.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "poc-srv-")); });

describe("TOOL_DEFS", () => {
  it("exposes the four tools, each requiring caseId", () => {
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(["exec_command", "list_dir", "read_file", "write_file"]);
    for (const t of TOOL_DEFS) {
      expect((t.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty("caseId");
    }
  });
});

describe("dispatchTool", () => {
  it("routes write_file then read_file", async () => {
    const w = await dispatchTool("write_file", { caseId: "c1", path: "a.txt", content: "hi" }, root);
    expect(w.ok).toBe(true);
    const r = await dispatchTool("read_file", { caseId: "c1", path: "a.txt" }, root);
    expect(r.text).toBe("hi");
  });

  it("returns ok:false for an unknown tool", async () => {
    const res = await dispatchTool("nope", { caseId: "c1" }, root);
    expect(res.ok).toBe(false);
  });
});
