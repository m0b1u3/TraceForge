import { PACKAGE_ID, PACKAGE_VERSION, PROTOCOL_VERSION, tools } from "./contracts.mjs";
import { ScenarioRpcHost } from "./rpc.mjs";
import { callTool } from "./tools.mjs";
const host = new ScenarioRpcHost();
let buffered = Buffer.alloc(0);
function handle(message) {
    if (message.version !== PROTOCOL_VERSION || typeof message.id !== "string")
        return process.exit(2);
    if (host.acceptResponse(message))
        return;
    if (message.method === "provider.handshake")
        return host.send({ version: PROTOCOL_VERSION, id: message.id, ok: true, result: {
                providerId: PACKAGE_ID, providerVersion: PACKAGE_VERSION, protocolVersion: PROTOCOL_VERSION, profile: "traceforge-scenario-process-rpc",
            } });
    if (message.method === "tools.list")
        return host.send({ version: PROTOCOL_VERSION, id: message.id, ok: true, result: tools });
    if (message.method === "tools.call")
        return void callTool(message, host).then((result) => host.send({ version: PROTOCOL_VERSION, id: message.id, ok: true, result }), (error) => host.fail(message.id, error));
    host.fail(message.id, new Error("Unknown method"));
}
process.stdin.on("data", (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
    while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0);
        if (length > 4 * 1024 * 1024)
            return process.exit(2);
        if (buffered.length < length + 4)
            break;
        let message;
        try {
            message = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
        }
        catch {
            return process.exit(2);
        }
        buffered = buffered.subarray(length + 4);
        handle(message);
    }
});
process.stdin.on("end", () => process.exit(0));
