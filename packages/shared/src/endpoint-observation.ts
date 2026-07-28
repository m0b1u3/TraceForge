import type { Fact } from "./schemas.js";

const ENDPOINT_FACT_TYPES = new Set(["api_endpoint", "login_endpoint"]);

export type EndpointObservationKind = "endpoint" | "error_signal" | "unsupported";

export function statusSupportsObservedEndpoint(status: number | null | undefined): boolean {
  if (status === null || status === undefined) return false;
  return (status >= 200 && status < 400) || status === 401 || status === 403 || status === 405;
}

export function classifyEndpointObservation(status: number | null | undefined): EndpointObservationKind {
  if (statusSupportsObservedEndpoint(status)) return "endpoint";
  if (status !== null && status !== undefined && status >= 500 && status < 600) return "error_signal";
  return "unsupported";
}

export function isUnsupportedObservedEndpointFact(fact: Fact): boolean {
  if (!ENDPOINT_FACT_TYPES.has(fact.type) || !fact.tags.includes("auto-discovery")) return false;
  const value = typeof fact.value === "object" && fact.value !== null
    ? fact.value as Record<string, unknown>
    : {};
  const sampleStatus = value.sampleStatus;
  return typeof sampleStatus === "number" && !statusSupportsObservedEndpoint(sampleStatus);
}
