import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LengthPrefixedJsonDecoder, NodeBrowserControllerProcessIo,
  parseBrowserControllerEntryArguments } from "./index.js";

describe("Node Browser Controller entry", () => {
  it("accepts only one complete set of bounded absolute release paths", () => {
    expect(parseBrowserControllerEntryArguments([
      "--release-manifest=/opt/traceforge/browser/release.json",
      "--source-lock=/opt/traceforge/browser/source-lock.json",
      "--source-review=/opt/traceforge/browser/source-review.json",
      "--source-authority=/opt/traceforge/trust/browser-authority.json",
      "--build-attestation=/opt/traceforge/browser/build-attestation.json",
      "--browser-root=/opt/traceforge/browser/chromium",
      "--browser=/opt/traceforge/browser/chrome",
      "--working-directory=/var/lib/traceforge/browser",
      "--user-data-directory=/var/lib/traceforge/browser/profile/run-1",
    ])).toEqual({
      releaseManifestPath: "/opt/traceforge/browser/release.json",
      sourceLockPath: "/opt/traceforge/browser/source-lock.json",
      sourceReviewPath: "/opt/traceforge/browser/source-review.json",
      sourceAuthorityPath: "/opt/traceforge/trust/browser-authority.json",
      buildAttestationPath: "/opt/traceforge/browser/build-attestation.json",
      browserRootPath: "/opt/traceforge/browser/chromium",
      browserExecutable: "/opt/traceforge/browser/chrome",
      workingDirectory: "/var/lib/traceforge/browser",
      userDataDirectory: "/var/lib/traceforge/browser/profile/run-1",
    });
    expect(() => parseBrowserControllerEntryArguments(["--browser=relative/chrome"])).toThrow();
    expect(() => parseBrowserControllerEntryArguments([
      "--release-manifest=/release.json", "--source-lock=/source-lock.json", "--source-review=/source-review.json",
      "--source-authority=/source-authority.json", "--browser-root=/chromium", "--browser=/chrome", "--working-directory=/work",
      "--build-attestation=/build-attestation.json",
      "--user-data-directory=/profile", "--proxy=/bypass",
    ])).toThrow("invalid or duplicated");
  });

  it("frames stdin/stdout without logging payloads and reports pipe loss until normal close", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const exitCodes: number[] = [], received: Buffer[] = [], failures: Error[] = [];
    const io = new NodeBrowserControllerProcessIo(input, output, (code) => exitCodes.push(code));
    io.onData((data) => received.push(data));
    io.onFailure((error) => failures.push(error));
    const outputBytes: Buffer[] = [];
    output.on("data", (data: Buffer) => outputBytes.push(data));
    input.write(Buffer.from("host-frame"));
    expect(Buffer.concat(received).toString()).toBe("host-frame");
    await io.write(Buffer.from([0, 0, 0, 2, 123, 125]));
    expect(new LengthPrefixedJsonDecoder(1024, 2048).push(Buffer.concat(outputBytes))).toEqual([{}]);
    input.emit("end");
    expect(failures.at(-1)?.message).toBe("Browser Controller Host pipe closed");
    io.close(0);
    input.emit("close");
    expect(exitCodes).toEqual([0]);
    expect(failures).toHaveLength(1);
    expect(input.destroyed).toBe(true);
  });
});
