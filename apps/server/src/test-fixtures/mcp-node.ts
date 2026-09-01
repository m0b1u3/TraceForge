import { permissionProfileFingerprint, resourceLimitsFingerprint, type ExecutionNode, type ProcessDescriptor,
  type ProcessEvent, type StartProcessRequest, type ReadProcessEventsRequest, type WriteProcessInputRequest, type ProcessAccess } from "@traceforge/execution-node";

/** Protocol simulator only: this does not attest to any operating-system sandbox. */
export function fixtureMcpNode(options: { invalidAttestation?: boolean; schemaMismatch?: boolean; hangCall?: boolean; errorCall?: boolean; versionMismatch?: boolean;
  resourceText?: string; promptText?: string; wrongUri?: boolean; binary?: boolean; missing?: boolean } = {}) {
  const sessions = new Map<string, { descriptor: ProcessDescriptor; events: ProcessEvent[]; wake?: () => void }>();
  const starts: StartProcessRequest[] = []; const messages: Array<Record<string, any>> = []; let calls = 0; let terminated = 0;
  const inputSchema = { type: "object", properties: {}, additionalProperties: false };
  const node = {
    async handshake() { return {}; },
    async startProcess(request: StartProcessRequest) {
      starts.push(request); const id = `process-${starts.length}`;
      const descriptor = { id, nodeId: "fixture", pid: starts.length, state: "running", attribution: request.attribution,
        executable: request.executable, arguments: request.arguments, workingDirectory: request.workingDirectory, terminal: null,
        enforcement: { sandboxed: !options.invalidAttestation, filesystemPolicyApplied: true, resourceLimitsApplied: true,
          sandboxBackend: "protocol-fixture-only", permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
          resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources!), network: request.permissions.network },
        startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), exitedAt: null, exitCode: null, exitSignal: null,
        resourceLimitExceeded: null, capturedOutputBytes: 0, omittedOutputBytes: 0, lastEventSequence: 0 } as ProcessDescriptor;
      sessions.set(id, { descriptor, events: [] }); return { process: descriptor, adoptionToken: id, replayed: false };
    },
    async writeProcessInput(request: WriteProcessInputRequest) {
      const session = sessions.get(request.processId)!;
      const message = JSON.parse(Buffer.from(request.dataBase64, "base64").toString()); messages.push(message);
      if (!message.id) return session.descriptor;
      let result: unknown;
      if (message.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "neutral", version: options.versionMismatch ? "2" : "1" }, capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: "UNTRUSTED_SERVER_INSTRUCTIONS" };
      else if (message.method === "tools/list") result = { tools: [{ name: "observe", inputSchema: options.schemaMismatch ? { type: "object" } : inputSchema,
        description: "UNTRUSTED_DESCRIPTION", annotations: { readOnlyHint: true, destructiveHint: false } }] };
      else if (message.method === "resources/list") result = { resources: options.missing ? [] : [{ uri: "fixture:notes", name: "Notes" }] };
      else if (message.method === "prompts/list") result = { prompts: options.missing ? [] : [{ name: "notes", arguments: [{ name: "topic", required: true }] }] };
      else {
        calls++; if (options.hangCall) return session.descriptor;
        if (message.method === "resources/read") result = { contents: [{ uri: options.wrongUri ? "fixture:other" : "fixture:notes",
          ...(options.binary ? { blob: "YWJj" } : { text: options.resourceText ?? "neutral reference" }) }] };
        else if (message.method === "prompts/get") result = { description: "UNTRUSTED_PROMPT_DESCRIPTION",
          messages: [{ role: "user", content: { type: "text", text: options.promptText ?? "neutral prompt" } }] };
        else result = { content: [{ type: "text", text: "neutral observation" }], isError: options.errorCall ?? false };
      }
      const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
      const event: ProcessEvent = { type: "process.output", processId: request.processId, sequence: session.events.length + 1,
        at: new Date().toISOString(), stream: "stdout", dataBase64: data.toString("base64"), bytes: data.length };
      session.events.push(event); session.wake?.(); return session.descriptor;
    },
    async waitProcessEvents(request: ReadProcessEventsRequest) {
      const session = sessions.get(request.processId)!;
      while (!session.events.some((e) => e.sequence > request.afterSequence) && session.descriptor.state === "running") {
        await new Promise<void>((done) => { session.wake = done; });
      }
      const events = session.events.filter((e) => e.sequence > request.afterSequence);
      return { process: session.descriptor, events, nextSequence: events.at(-1)?.sequence ?? request.afterSequence, lostEvents: false };
    },
    async terminateProcess(request: ProcessAccess) {
      const session = sessions.get(request.processId)!; terminated++;
      session.descriptor = { ...session.descriptor, state: "exited", exitCode: 0 }; session.wake?.(); return session.descriptor;
    },
  } as unknown as ExecutionNode;
  return { node, starts, messages, inputSchema, calls: () => calls, terminated: () => terminated };
}
