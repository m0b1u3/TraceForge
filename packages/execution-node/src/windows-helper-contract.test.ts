import { describe, expect, it } from "vitest";
import { parseWindowsSandboxHelperProbe } from "./windows-helper-contract.js";

const probe = {
  protocol: 4, platform: "windows", modes: ["unelevated-direct", "appcontainer-deny"],
  pty: true, jobEmptyBarrier: true, atomicJobAssignment: true, resourceLimits: ["cpu_time", "memory", "process_count", "write_bytes"],
};

describe("Windows sandbox helper contract", () => {
  it("accepts the complete native isolation contract", () => {
    expect(parseWindowsSandboxHelperProbe(JSON.stringify(probe))).toEqual(probe);
  });

  it("rejects invalid or incomplete native helpers", () => {
    expect(() => parseWindowsSandboxHelperProbe("not-json")).toThrow(/invalid JSON/);
    expect(() => parseWindowsSandboxHelperProbe(
      JSON.stringify({ ...probe, modes: ["unelevated-direct"] }),
    )).toThrow(/missing a required isolation mode/);
    expect(() => parseWindowsSandboxHelperProbe(
      JSON.stringify({ ...probe, resourceLimits: ["cpu_time"] }),
    )).toThrow(/missing a required resource limit/);
  });

  it("rejects older helpers and helpers without the cleanup barrier", () => {
    expect(() => parseWindowsSandboxHelperProbe(JSON.stringify({ ...probe, protocol: 2 }))).toThrow(/incompatible/);
    for (const jobEmptyBarrier of [false, undefined, "true"]) {
      expect(() => parseWindowsSandboxHelperProbe(JSON.stringify({ ...probe, jobEmptyBarrier }))).toThrow(/cleanup barrier/);
    }
  });
  it("rejects pre-watchdog helpers and non-atomic process ownership", () => {
    expect(() => parseWindowsSandboxHelperProbe(JSON.stringify({ ...probe, protocol: 3 }))).toThrow(/incompatible/);
    expect(() => parseWindowsSandboxHelperProbe(JSON.stringify({ ...probe, atomicJobAssignment: false }))).toThrow(/atomic job assignment/);
  });
});
