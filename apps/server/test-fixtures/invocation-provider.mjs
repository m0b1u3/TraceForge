import fs from "node:fs";
import { join } from "node:path";
const [root, phase] = process.argv.slice(2);
let buffered = Buffer.alloc(0);
function send(id, result) {
  const body = Buffer.from(JSON.stringify({ version: 1, id, ok: true, result }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4 && buffered.length >= buffered.readUInt32BE(0) + 4) {
    const length = buffered.readUInt32BE(0);
    const request = JSON.parse(buffered.subarray(4, 4 + length));
    buffered = buffered.subarray(4 + length);
    if (request.method === "provider.handshake") send(request.id, { providerId: "neutral", providerVersion: "1.0.0", protocolVersion: 1 });
    if (request.method === "tools.call") {
      fs.appendFileSync(join(root, "effects.log"), "observed\n");
      if (phase === "executing") fs.writeFileSync(join(root, "executing"), "ready");
      else send(request.id, { status: "succeeded", summary: "neutral observation", raw: "", refs: [], retryable: false });
    }
  }
});
// This fixture deliberately exits on ownership-channel loss. This is not a sandbox attestation.
process.stdin.on("end", () => {
  fs.writeFileSync(join(root, "provider-exited"), "stdin-closed");
  process.exit(0);
});
process.stdout.on("error", () => process.exit(0));
setTimeout(() => process.exit(3), 15_000).unref();
