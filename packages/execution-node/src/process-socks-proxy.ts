import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";

/** SOCKS5 TCP only. Authentication and destination dialing remain execution
 * scoped; UDP/BIND never fall back to direct sockets. No credentials are logged. */
export async function serveProcessSocks(socket: Socket, token: string, connect: (hostname: string, port: number) => Promise<Duplex>,
  maximumBytes: number, own: (stream: Duplex) => Duplex): Promise<void> {
  let buffer = Buffer.alloc(0), wake: (() => void) | undefined, ended = false;
  const receive = (bytes: Buffer) => { buffer = Buffer.concat([buffer, bytes]); if (buffer.length > 65536) socket.destroy(); wake?.(); };
  const end = () => { ended = true; wake?.(); };
  socket.on("data", receive); socket.once("close", end); socket.on("error", end);
  const timeout = setTimeout(() => socket.destroy(), 5000);
  const read = async (size: number) => {
    while (buffer.length < size) { if (ended || socket.destroyed) throw new Error("SOCKS handshake closed"); await new Promise<void>(resolve => { wake = resolve; }); }
    const result = buffer.subarray(0, size); buffer = buffer.subarray(size); return result;
  };
  let upstream: Duplex | undefined;
  try {
    const greeting = await read(2);
    if (greeting[0] !== 5 || !greeting[1] || !(await read(greeting[1]!)).includes(2)) { socket.end(Buffer.from([5,255])); return; }
    socket.write(Buffer.from([5,2]));
    const auth = await read(2), username = await read(auth[1]!), length = (await read(1))[0]!, password = await read(length);
    const expected = Buffer.from(token);
    if (auth[0] !== 1 || username.length !== expected.length || !timingSafeEqual(username, expected) || password.toString() !== "x") { socket.end(Buffer.from([1,1])); return; }
    socket.write(Buffer.from([1,0]));
    const request = await read(4);
    if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0) throw new Error("Only SOCKS TCP CONNECT is supported");
    let hostname: string;
    if (request[3] === 3) { const size = (await read(1))[0]!; if (!size) throw new Error("Missing host"); hostname = (await read(size)).toString("ascii"); if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) throw new Error("Invalid host"); }
    else if (request[3] === 1) hostname = [...await read(4)].join(".");
    else if (request[3] === 4) { const bytes = await read(16); hostname = `[${Array.from({length:8},(_,i)=>bytes.readUInt16BE(i*2).toString(16)).join(":")}]`; }
    else throw new Error("Unsupported host encoding");
    const port = (await read(2)).readUInt16BE(); if (!port) throw new Error("Invalid port");
    socket.pause(); socket.off("data", receive);
    upstream = own(await connect(hostname, port));
    if (socket.destroyed) throw new Error("SOCKS client closed");
    let bytes = buffer.length;
    const meter = (chunk: Buffer) => { bytes += chunk.length; if (bytes > maximumBytes) { upstream?.destroy(); socket.destroy(); } };
    if (bytes > maximumBytes) throw new Error("SOCKS byte budget exceeded");
    socket.on("data", meter); upstream.on("data", meter);
    socket.once("close", () => upstream?.destroy()); upstream.once("close", () => socket.destroy()); upstream.once("error", () => socket.destroy());
    socket.write(Buffer.from([5,0,0,1,0,0,0,0,0,0]));
    upstream.pipe(socket);
    if (buffer.length) upstream.write(buffer);
    socket.pipe(upstream); socket.resume();
  } catch { upstream?.destroy(); if (!socket.destroyed) socket.end(Buffer.from([5,1,0,1,0,0,0,0,0,0])); }
  finally { clearTimeout(timeout); socket.off("data", receive); socket.off("error", end); }
}
