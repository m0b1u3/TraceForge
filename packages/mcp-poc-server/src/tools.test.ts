import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand, writeFile, readFile, listDir } from "./tools.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "poc-ws-")); });

describe("write/read/list", () => {
  it("write then read returns original content", async () => {
    const w = await writeFile(root, { caseId: "c1", path: "poc.py", content: "print(1)" });
    expect(w.ok).toBe(true);
    const r = await readFile(root, { caseId: "c1", path: "poc.py" });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("print(1)");
  });

  it("list_dir lists written files", async () => {
    await writeFile(root, { caseId: "c1", path: "a.txt", content: "x" });
    const l = await listDir(root, { caseId: "c1" });
    expect(l.ok).toBe(true);
    expect(l.text).toContain("a.txt");
  });

  it("rejects a path that escapes the workspace", async () => {
    const w = await writeFile(root, { caseId: "c1", path: "../../evil.txt", content: "x" });
    expect(w.ok).toBe(false);
    expect(w.text).toMatch(/escape/i);
  });
});

describe("exec_command", () => {
  it("runs a harmless node command and captures stdout + exit code", async () => {
    const res = await execCommand(root, { caseId: "c1", command: 'node -e "console.log(1+1)"' });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("exit=0");
    expect(res.text).toContain("2");
  });

  it("reports a non-zero exit code", async () => {
    const res = await execCommand(root, { caseId: "c1", command: 'node -e "process.exit(3)"' });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("exit=3");
  });
});
