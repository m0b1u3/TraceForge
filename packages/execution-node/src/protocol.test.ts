import { describe, expect, it } from "vitest";
import {
  EXECUTION_PROTOCOL_VERSION,
  capabilityNames,
  negotiateExecutionProtocol,
  type ExecutionNodeDescriptor,
} from "./protocol.js";

const node: ExecutionNodeDescriptor = {
  id: "node_1",
  protocol: { ...EXECUTION_PROTOCOL_VERSION },
  platform: "windows",
  architecture: "x64",
  capabilities: {
    process: { spawn: true, stdio: true, tty: false, adoption: true, resourceLimits: true, signals: ["interrupt", "kill"] },
    filesystem: { canonicalize: true, read: true, write: false, list: true, stat: true, maximumChunkBytes: 1024, maximumListEntries: 100 },
    network: { brokered: false },
    http: { streaming: false },
    sandbox: { backends: ["test"] },
  },
  limits: {
    maximumProcesses: 2, maximumOutputBytesPerProcess: 4096, maximumRetainedEventsPerProcess: 100,
    maximumCpuTimeMsPerProcess: 60_000, maximumMemoryBytesPerProcess: 1024 * 1024 * 1024,
    maximumProcessesPerExecution: 16, maximumWriteBytesPerProcess: 1024 * 1024,
  },
  startedAt: "2026-08-25T08:00:00.000Z",
};

describe("execution protocol negotiation", () => {
  it("negotiates the minor version and publishes a stable capability inventory", () => {
    expect(capabilityNames(node.capabilities)).toEqual([
      "process.spawn", "process.stdio", "process.adopt", "process.resource_limits", "filesystem.canonicalize",
      "filesystem.read", "filesystem.list", "filesystem.stat",
    ]);
    const response = negotiateExecutionProtocol({
      clientId: "controller_1",
      protocol: { major: 1, minor: 4 },
      requiredCapabilities: ["process.spawn", "process.adopt"],
    }, node);
    expect(response.negotiatedProtocol).toEqual({ major: 1, minor: 3 });
  });

  it("fails closed for incompatible versions and missing capabilities", () => {
    expect(() => negotiateExecutionProtocol({
      clientId: "controller_1", protocol: { major: 2, minor: 0 }, requiredCapabilities: [],
    }, node)).toThrow(/major version mismatch/);
    expect(() => negotiateExecutionProtocol({
      clientId: "controller_1", protocol: { major: 1, minor: 0 }, requiredCapabilities: ["process.tty"],
    }, node)).toThrow(/process\.tty/);
  });
});
