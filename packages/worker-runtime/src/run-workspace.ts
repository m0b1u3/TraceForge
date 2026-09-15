import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { allowsFileSystemPath, type PermissionProfile } from "@traceforge/orchestration-core";
import type { ExecutionToolAdapter } from "./tool-gateway.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./model.js";

const FILE_BYTES = 256 * 1024;
const TREE_BYTES = 16 * 1024 * 1024;
const TREE_ENTRIES = 512;
export const MAX_WORKSPACE_EXECUTION_SECONDS = 3600;
export function workspaceExecutionSeconds(payload: unknown): number {
  const value = (payload as Record<string, unknown> | null)?.maximumScriptSeconds ?? 60;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_WORKSPACE_EXECUTION_SECONDS) throw new Error("Invalid authorized script duration");
  return value as number;
}
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function managedWorkspacePath(base: string, caseId: string, runId: string, sharedKey?: string): string {
  if (![caseId, runId].every(value => typeof value === "string" && value.length > 0 && value.length <= 512)
    || sharedKey !== undefined && (typeof sharedKey !== "string" || !sharedKey.length || sharedKey.length > 512)) throw new Error("Workspace ownership is required");
  return join(resolve(base), digest(JSON.stringify(sharedKey === undefined ? [caseId, runId] : [caseId, "shared", sharedKey])));
}
const operations = ["read", "list", "search", "write", "edit", "remove", "execute", "stage"] as const;
type Operation = typeof operations[number];
const actionFor = (op: Operation) => `workspace.${["read", "list", "search"].includes(op) ? "read" : op === "execute" ? "execute" : "write"}`;
export function workspaceAction(tool: string): string | undefined {
  if (["workspace_start", "workspace_stop", "workspace_input"].includes(tool)) return "workspace.execute";
  if (tool === "workspace_poll") return "workspace.read";
  const op = tool.replace(/^workspace_/, "") as Operation;
  return tool.startsWith("workspace_") && operations.includes(op) ? actionFor(op) : undefined;
}
export interface WorkspaceProject { id: string; digest: string; files: { path: string; bytes: Buffer }[]; entryScript: string; usage: string }

/** Host-owned directories only. Scripts never receive a write grant to their parent or
 * the durable busy marker. A crashed/uncertain process quarantines its workspace;
 * reopening the host cannot silently clear that fence. No host filesystem API is
 * allowed while an owned script could still be running. */
export class RunWorkspace {
  private readonly active = new Set<string>();
  constructor(private readonly base: string, private readonly processTool: ExecutionToolAdapter,
    private readonly authorize: (context: ToolExecutionContext, action: string) => void,
    private readonly prepareExecution?: () => Promise<void>,
    private readonly loadProject?: (context: ToolExecutionContext, id: string) => Promise<WorkspaceProject>,
    private readonly executionSeconds: (context: ToolExecutionContext) => number = () => 60,
    private readonly sharedWorkspaceKey?: (caseId: string, runId: string) => string | undefined) {}

  root(caseId: string, runId: string): string {
    return managedWorkspacePath(this.base, caseId, runId, this.sharedWorkspaceKey?.(caseId, runId));
  }

  /** Pure calculation: catalog reads never create directories or launch processes. */
  profile(caseId: string, runId: string, tool: string, enabled: boolean, network = false, interactive = false): PermissionProfile {
    const action = workspaceAction(tool), root = this.root(caseId, runId);
    // First supported native platform; no unrestricted fallback on other hosts.
    enabled = enabled && process.platform === "darwin" && process.arch === "arm64" && !!action;
    const execute = action === "workspace.execute";
    return { version: 1, platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
      filesystem: { read: enabled ? [{ path: root, scope: "tree" }, ...(execute ? [{ path: "/bin", scope: "tree" as const }, { path: "/usr/bin", scope: "tree" as const },
        ...(network ? [{ path: "/private/etc/ssl/openssl.cnf", scope: "exact" as const }, { path: "/private/etc/ssl/cert.pem", scope: "exact" as const }] : [])] : [])] : [],
        write: enabled && action !== "workspace.read" ? [{ path: root, scope: "tree" }] : [], deny: [] },
      network: enabled && execute && network ? "brokered" : "deny", process: { access: enabled ? "sandboxed" : "deny", interactive: enabled && execute && interactive, background: false }, secrets: "deny" };
  }

  tools(): ExecutionToolAdapter[] {
    const text = { type: "string", maxLength: FILE_BYTES };
    const schemas: Record<Operation, { properties: Record<string, unknown>; required: string[] }> = {
      read: { properties: { path: text }, required: ["path"] },
      list: { properties: {}, required: [] },
      search: { properties: { text: { type: "string", minLength: 1, maxLength: 256 } }, required: ["text"] },
      write: { properties: { path: text, content: text, expectedDigest: { type: ["string", "null"] } }, required: ["path", "content", "expectedDigest"] },
      edit: { properties: { path: text, expectedDigest: text, before: text, after: text }, required: ["path", "expectedDigest", "before", "after"] },
      remove: { properties: { path: text, expectedDigest: text }, required: ["path", "expectedDigest"] },
      execute: { properties: { path: text, expectedDigest: text, terminal: { type: "boolean", description: "Use a managed terminal, only with interactiveWorkspace consent; use workspace_start for later workspace_input calls." }, timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_WORKSPACE_EXECUTION_SECONDS, description: "Requested execution time; defaults to 60 seconds and cannot exceed this Run's authorized maximumScriptSeconds." }, arguments: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4096 } } }, required: ["path", "expectedDigest"] },
      stage: { properties: { projectId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,80}$" } }, required: ["projectId"] },
    };
    const descriptions: Record<Operation, string> = {
      read: "Read a UTF-8 Run workspace file and its SHA-256 revision (maximum 256 KiB).",
      list: "List relative files in this Run workspace (bounded to 512 entries / 16 MiB).",
      search: "Search literal text in this Run's UTF-8 files; return at most 100 matching lines, not regex execution.",
      write: "Create/replace a UTF-8 file in this Run. expectedDigest=null creates only; replacing requires the last read SHA-256. Parent folders are created within this workspace.",
      edit: "Replace exactly one literal occurrence in a Run file, conditional on its last read SHA-256.",
      remove: "Delete one Run file, conditional on its last read SHA-256. No recursive deletion.",
      execute: "Run a workspace Bash script pinned to its last read SHA-256 expectedDigest, without startup profiles, in the local native sandbox defaulting to 60 seconds; timeoutSeconds may request up to the separately authorized maximumScriptSeconds (at most 3600 seconds). Offline unless separately granted workspace.network; supported HTTP/SOCKS5 TCP clients then use the host-controlled destination scope. Opaque tunnels are connection-level, not per-path inspection. terminal=true requires interactiveWorkspace consent; use workspace_start and workspace_input for later interaction. No user home, other Runs or detached execution. System /bin and /usr/bin utilities are readable. Output is bounded and is not verified security evidence.",
      stage: "Copy an enabled source project from this Run's pinned tool library into its workspace, without running it or installing dependencies. Read tools_catalog first. Returns the saved entry script and digest for a separately approved workspace_execute call; missing dependencies must be reported, not installed through an unrestricted fallback.",
    };
    return operations.filter(op => op !== "stage" || this.loadProject).map(op => ({ name: `workspace_${op}`, source: "traceforge.builtin", version: "1.0.0", priority: 100,
      description: descriptions[op], inputSchema: { type: "object", additionalProperties: false, ...schemas[op] },
      providedCapabilities: [`workspace.${op}`], dependencyCapabilities: op === "execute" ? ["workspace.read", "workspace.list", "workspace.search", "workspace.write", "workspace.edit", "workspace.remove"] : op === "stage" ? ["tools.use", "workspace.execute"] : [], permissionRequirements: { process: "sandboxed" },
      risk: op === "execute" || op === "stage" ? "privileged" : op === "remove" ? "destructive" : ["write", "edit"].includes(op) ? "bounded_write" : "read_only",
      timeoutMs: op === "execute" ? MAX_WORKSPACE_EXECUTION_SECONDS * 1000 + 30_000 : 5_000,
      execute: (input, context) => this.perform(op, input, context, Object.keys(schemas[op].properties)),
    }));
  }

  private async perform(op: Operation, input: unknown, context: ToolExecutionContext, keys: string[]): Promise<ToolExecutionResult> {
    context.signal?.throwIfAborted();
    this.authorize(context, actionFor(op));
    if (!(Date.parse(context.leaseExpiresAt) > Date.now())) throw new Error("Workspace lease expired");
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new Error("Invalid workspace input");
    const args = input as Record<string, unknown>, root = this.root(context.caseId, context.runId);
    const permissions = context.effectivePermissions;
    if (!["deny", "brokered"].includes(permissions.network) || permissions.process.access !== "sandboxed" || permissions.secrets !== "deny"
      || !allowsFileSystemPath(permissions, "read", root)
      || (actionFor(op) !== "workspace.read" && !allowsFileSystemPath(permissions, "write", root))) throw new Error("Workspace permissions are unavailable");
    if (this.active.has(root)) throw new Error("Run workspace is busy; wait for the active operation");
    this.active.add(root);
    try {
      if (permissions.network === "brokered") this.authorize(context, "workspace.network");
      this.directory(root);
      const marker = `${root}.busy`;
      if (existsSync(marker)) throw new Error("Workspace requires reconciliation: previous process cleanup is unconfirmed");
      const entries = this.inventory(root);
      if (op === "stage") {
        if (typeof args.projectId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(args.projectId) || !this.loadProject) throw new Error("Invalid source project selection");
        const project = await this.loadProject(context, args.projectId);
        context.signal?.throwIfAborted(); this.authorize(context, "workspace.write");
        if (project.id !== args.projectId || !project.files.length || project.files.length > TREE_ENTRIES) throw new Error("Invalid source project manifest");
        const directory = `tools/${project.id}`, entrypoint = `tools/${project.id}.traceforge.sh`;
        const target = this.path(root, directory, context, true), entryPath = this.path(root, entrypoint, context, true);
        if (existsSync(target) || existsSync(entryPath)) throw new Error("Project is already staged; inspect it instead of overwriting Run files");
        const script = `cd -- '${directory}' || exit 1\n${this.text(project.entryScript)}\n`;
        const directories = new Set<string>(["tools", directory]); const names = new Set<string>();
        let bytes = Buffer.byteLength(script);
        for (const file of project.files) {
          this.path(root, `${directory}/${file.path}`, context, true);
          const key = file.path.toLowerCase(); if (names.has(key)) throw new Error("Conflicting source project paths"); names.add(key);
          for (let parent = dirname(`${directory}/${file.path}`); parent !== "."; parent = dirname(parent)) directories.add(parent);
          bytes += file.bytes.length;
        }
        if (entries.length + project.files.length + directories.size + 1 > TREE_ENTRIES || entries.reduce((n, e) => n + e.bytes, 0) + bytes > TREE_BYTES) throw new Error("Project exceeds Run workspace capacity");
        const staging = `${root}.stage-${randomUUID()}`;
        this.directory(staging);
        try {
          for (const file of project.files) { const path = join(staging, file.path); this.directory(dirname(path)); writeFileSync(path, file.bytes, { flag: "wx", mode: 0o600 }); }
          this.directory(dirname(target)); renameSync(staging, target);
          writeFileSync(entryPath, script, { flag: "wx", mode: 0o600 }); this.syncDirectory(dirname(target));
        } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
        return this.result({ directory, entrypoint, expectedDigest: digest(script), sourceDigest: project.digest, usage: project.usage, executed: false });
      }
      if (op === "list") return this.result(entries);
      if (op === "search") {
        const query = this.text(args.text, 256);
        if (!query) throw new Error("Search text cannot be empty");
        const matches: unknown[] = [];
        let omittedFiles = 0;
        for (const entry of entries) {
          if (entry.type !== "file") continue;
          if (entry.bytes > FILE_BYTES) { omittedFiles++; continue; }
          let content: string;
          try { content = this.read(this.path(root, entry.path, context, false)); } catch { omittedFiles++; continue; }
          for (const [index, line] of content.split("\n").entries()) {
            if (line.includes(query)) matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 512) });
            if (matches.length === 100) return this.result({ matches, omittedFiles, truncated: true });
          }
        }
        return this.result({ matches, omittedFiles, truncated: omittedFiles > 0 });
      }
      const path = this.path(root, args.path, context, actionFor(op) !== "workspace.read");
      if (op === "read") { const content = this.read(path); return this.result({ path: args.path, content, digest: digest(content) }); }
      if (op === "execute") {
        if (args.terminal !== undefined && typeof args.terminal !== "boolean") throw new Error("Invalid terminal option");
        if (args.terminal && !permissions.process.interactive) throw new Error("Interactive workspace execution is not authorized");
        const maximum = workspaceExecutionSeconds({ maximumScriptSeconds: this.executionSeconds(context) });
        const seconds = args.timeoutSeconds ?? Math.min(60, maximum);
        if (!Number.isSafeInteger(seconds) || (seconds as number) < 1 || (seconds as number) > maximum) throw new Error(`Requested script duration exceeds authorized maximum (${maximum} seconds)`);
        if (args.expectedDigest !== digest(this.read(path))) throw new Error("Workspace script revision conflict; read and approve the current script before execution");
        const argv = args.arguments ?? [];
        if (!Array.isArray(argv) || argv.length > 64 || argv.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))) throw new Error("Invalid script arguments");
        await this.prepareExecution?.();
        context.signal?.throwIfAborted();
        this.authorize(context, actionFor(op));
        if (!(Date.parse(context.leaseExpiresAt) > Date.now())) throw new Error("Workspace lease expired");
        // Durable fence precedes dispatch; only a native terminal tree barrier releases it.
        const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, JSON.stringify({ runId: context.runId, idempotencyKey: context.idempotencyKey })); fsyncSync(fd); } finally { closeSync(fd); }
        this.syncDirectory(dirname(marker));
        const result = await this.processTool.execute({ executable: "/bin/bash", arguments: ["--noprofile", "--norc", path, ...argv], workingDirectory: root,
          environment: {}, timeoutMs: (seconds as number) * 1000, outputLimitBytes: 65_536,
          ...(args.terminal ? { terminal: { columns: 80, rows: 24 } } : {}),
          resources: { cpuTimeMs: (seconds as number) * 1000, memoryBytes: 256 * 1024 * 1024, maximumProcesses: 8, writeBytes: TREE_BYTES } }, context);
        const enforcement = result.metadata?.enforcement as Record<string, unknown> | undefined;
        if (enforcement?.sandboxed !== true || enforcement?.filesystemPolicyApplied !== true || enforcement?.network !== permissions.network
          || enforcement?.processTreeEmptyBarrier !== true || (typeof result.metadata?.exitCode !== "number" && typeof result.metadata?.exitSignal !== "string")) {
          throw new Error("Workspace execution lacks a confirmed native cleanup barrier; reconciliation required");
        }
        unlinkSync(marker);
        this.syncDirectory(dirname(marker));
        return result;
      }
      const exists = existsSync(path);
      const previous = exists ? this.read(path) : undefined;
      if (args.expectedDigest !== (previous === undefined ? null : digest(previous))) throw new Error("Workspace revision conflict; read the current file before modifying it");
      if (op === "remove") {
        if (previous === undefined) throw new Error("Workspace file does not exist");
        unlinkSync(path); this.syncDirectory(dirname(path)); return this.result({ path: args.path, removed: true });
      }
      let content: string;
      if (op === "edit") {
        const before = this.text(args.before), after = this.text(args.after);
        if (previous === undefined || !before || previous.indexOf(before) < 0 || previous.indexOf(before) !== previous.lastIndexOf(before)) throw new Error("Edit requires exactly one matching literal occurrence");
        content = previous.replace(before, () => after);
      } else content = this.text(args.content);
      if (Buffer.byteLength(content) > FILE_BYTES || entries.reduce((n, e) => n + e.bytes, 0) - Buffer.byteLength(previous ?? "") + Buffer.byteLength(content) > TREE_BYTES) throw new Error("Workspace byte capacity exceeded");
      let missingDirectories = 0;
      for (let parent = dirname(path); parent !== root && !existsSync(parent); parent = dirname(parent)) missingDirectories++;
      if (entries.length + missingDirectories + (exists ? 0 : 1) > TREE_ENTRIES) throw new Error("Workspace entry capacity exceeded");
      this.directory(dirname(path));
      const temporary = join(dirname(path), `.write-${randomUUID()}`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
      this.syncDirectory(dirname(path));
      return this.result({ path: args.path, digest: digest(content), bytes: Buffer.byteLength(content) });
    } finally { this.active.delete(root); }
  }

  private text(value: unknown, maximum = FILE_BYTES): string {
    if (typeof value !== "string" || Buffer.byteLength(value) > maximum || value.includes("\0")) throw new Error("Invalid workspace text");
    if (Buffer.from(value).toString("utf8") !== value) throw new Error("Workspace text must be valid UTF-8");
    return value;
  }
  private path(root: string, value: unknown, context: ToolExecutionContext, write: boolean): string {
    const relative = this.text(value, 1024), segments = relative.split("/");
    if (segments.length > 16 || segments.some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))) throw new Error("Workspace paths must be relative, without traversal");
    const path = join(root, ...segments);
    if (!allowsFileSystemPath(context.effectivePermissions, write ? "write" : "read", path)) throw new Error("Workspace path is not authorized");
    this.checkAncestors(dirname(path));
    return path;
  }
  private checkAncestors(path: string): void {
    if (path !== dirname(path)) this.checkAncestors(dirname(path));
    if (existsSync(path)) { const info = lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Workspace directory is not a plain directory"); }
    else { try { lstatSync(path); throw new Error("Workspace directory is invalid"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
  private directory(path: string): void {
    this.checkAncestors(path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (realpathSync(path) !== path) throw new Error("Workspace directory must be canonical");
  }
  private read(path: string): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > FILE_BYTES) throw new Error("Workspace file must be a bounded, unlinked regular file");
      const bytes = readFileSync(fd);
      if (bytes.length > FILE_BYTES) throw new Error("Workspace file exceeds capacity");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (text.includes("\0")) throw new Error("Workspace file is not text");
      return text;
    } finally { closeSync(fd); }
  }
  private inventory(root: string): { path: string; type: "file" | "directory"; bytes: number }[] {
    const entries: { path: string; type: "file" | "directory"; bytes: number }[] = [];
    let total = 0;
    const visit = (relative: string, depth: number) => {
      if (depth > 16) throw new Error("Workspace directory depth exceeded");
      const directory = opendirSync(join(root, relative));
      try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        const name = entry.name;
        const path = relative ? `${relative}/${name}` : name, info = lstatSync(join(root, path));
        if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new Error("Workspace contains a link or special file; reconciliation required");
        total += info.isFile() ? info.size : 0;
        entries.push({ path, type: info.isDirectory() ? "directory" : "file", bytes: info.isFile() ? info.size : 0 });
        if (entries.length > TREE_ENTRIES || total > TREE_BYTES) throw new Error("Workspace capacity exceeded; reconciliation required");
        if (info.isDirectory()) visit(path, depth + 1);
      } } finally { directory.closeSync(); }
    };
    visit("", 0); return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  private syncDirectory(path: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private result(value: unknown): ToolExecutionResult {
    return { status: "succeeded", summary: "Run workspace operation completed", raw: JSON.stringify(value), refs: [], retryable: false };
  }
}
