import { describe, expect, it } from "vitest";
import { ObserverCadence } from "./observer-cadence.js";

const quiet = {
  activeWarningCount: 0,
  pendingCorrectionCount: 0,
  resolvedCorrectionCount: 0,
  failedCorrectionCount: 0,
  stalledCorrectionCount: 0,
};

describe("Observer adaptive cadence", () => {
  it("starts at twelve turns and resets from the last successful review", () => {
    const cadence = new ObserverCadence();
    expect(cadence.shouldReview(11, quiet)).toBe(false);
    expect(cadence.shouldReview(12, quiet)).toBe(true);
    cadence.recordSuccessfulReview(12, { warningCount: 1, correctionCount: 1 });
    expect(cadence.shouldReview(23, quiet)).toBe(false);
    expect(cadence.shouldReview(24, quiet)).toBe(true);
  });

  it("checks pending corrections quickly without reviewing every turn", () => {
    const cadence = new ObserverCadence();
    cadence.recordSuccessfulReview(7, { warningCount: 1, correctionCount: 1 });
    const pending = { ...quiet, activeWarningCount: 1, pendingCorrectionCount: 1 };
    expect(cadence.interval(pending)).toBe(4);
    expect(cadence.shouldReview(10, pending)).toBe(false);
    expect(cadence.shouldReview(11, pending)).toBe(true);
  });

  it("uses an intermediate cadence for unresolved ineffective corrections", () => {
    const cadence = new ObserverCadence();
    cadence.recordSuccessfulReview(5, { warningCount: 1, correctionCount: 1 });
    const unresolved = { ...quiet, activeWarningCount: 1, failedCorrectionCount: 2 };
    expect(cadence.interval(unresolved)).toBe(6);
    expect(cadence.shouldReview(10, unresolved)).toBe(false);
    expect(cadence.shouldReview(11, unresolved)).toBe(true);
  });

  it("backs off after consecutive quiet reviews", () => {
    const cadence = new ObserverCadence();
    cadence.recordSuccessfulReview(12, { warningCount: 0, correctionCount: 0 });
    expect(cadence.interval(quiet)).toBe(18);
    cadence.recordSuccessfulReview(30, { warningCount: 0, correctionCount: 0 });
    expect(cadence.interval(quiet)).toBe(24);
    expect(cadence.shouldReview(53, quiet)).toBe(false);
    expect(cadence.shouldReview(54, quiet)).toBe(true);
  });

  it("returns to normal cadence after a productive review", () => {
    const cadence = new ObserverCadence();
    cadence.recordSuccessfulReview(12, { warningCount: 0, correctionCount: 0 });
    cadence.recordSuccessfulReview(30, { warningCount: 1, correctionCount: 0 });
    expect(cadence.interval(quiet)).toBe(12);
  });

  it("backs off periodic retries after a failed review", () => {
    const cadence = new ObserverCadence();
    cadence.recordFailedReview(12);
    expect(cadence.shouldReview(17, quiet)).toBe(false);
    expect(cadence.shouldReview(18, quiet)).toBe(true);
    cadence.recordSuccessfulReview(18, { warningCount: 0, correctionCount: 0 });
    expect(cadence.interval(quiet)).toBe(18);
  });

  it("tracks a stalled ordinary correction at low frequency", () => {
    const cadence = new ObserverCadence();
    const stalled = { ...quiet, activeWarningCount: 1, stalledCorrectionCount: 1 };
    expect(cadence.interval(stalled)).toBe(24);
    expect(cadence.shouldReview(23, stalled)).toBe(false);
    expect(cadence.shouldReview(24, stalled)).toBe(true);
  });
});
