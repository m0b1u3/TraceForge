import { describe, expect, it } from "vitest";
import { parseWindowsSandboxHelperProbe } from "./windows-helper-contract.js";

describe("Windows sandbox helper contract", () => {
  it("accepts the complete native isolation contract", () => {
    expect(parseWindowsSandboxHelperProbe(
      '{"protocol":2,"platform":"windows","modes":["unelevated-direct","appcontainer-deny"],"pty":true,"resourceLimits":["cpu_time","memory","process_count","write_bytes"]}',
    )).toMatchObject({ protocol: 2, platform: "windows", pty: true });
  });

  it("rejects invalid or incomplete native helpers", () => {
    expect(() => parseWindowsSandboxHelperProbe("not-json")).toThrow(/invalid JSON/);
    expect(() => parseWindowsSandboxHelperProbe(
      '{"protocol":2,"platform":"windows","modes":["unelevated-direct"],"pty":true,"resourceLimits":["cpu_time","memory","process_count","write_bytes"]}',
    )).toThrow(/missing a required isolation mode/);
    expect(() => parseWindowsSandboxHelperProbe(
      '{"protocol":2,"platform":"windows","modes":["unelevated-direct","appcontainer-deny"],"pty":true,"resourceLimits":["cpu_time"]}',
    )).toThrow(/missing a required resource limit/);
  });
});
