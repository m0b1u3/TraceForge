const version = 1;
let buffered = Buffer.alloc(0);

function send(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  process.stdout.write(frame);
}

function respond(request) {
  if (request.version !== version) return process.exit(2);
  if (request.method === "provider.handshake") {
    return send({ version, id: request.id, ok: true, result: { providerId: "fixture", providerVersion: "1.0.0", protocolVersion: version } });
  }
  if (request.method === "tools.list") {
    return send({ version, id: request.id, ok: true, result: [{
      name: "fixture.read", source: process.env.TRACEFORGE_TEST_SOURCE ?? "rpc:test", version: "1.0.0", priority: 100,
      description: "Read fixture input", inputSchema: { type: "object" }, providedCapabilities: ["fixture.read"],
      dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000,
    }] });
  }
  if (request.method === "tools.call") {
    if (request.params?.input?.crash === true) return process.exit(9);
    return send({ version, id: request.id, ok: true, result: {
      status: "succeeded", summary: "fixture completed", raw: JSON.stringify(request.params?.input ?? null),
      refs: [`work:${request.params?.context?.workId ?? "unknown"}`], retryable: false,
    } });
  }
  send({ version, id: request.id, ok: false, error: { code: "method_not_found", message: "Unknown method", retryable: false } });
}

process.stdin.on("data", (chunk) => {
  buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < length + 4) break;
    const value = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    respond(value);
  }
});
