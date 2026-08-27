import { describe, expect, it } from "vitest";
import { CapabilityProviderRegistry, type CapabilityProviderDescriptor } from "./capability-registry.js";

type Provider = CapabilityProviderDescriptor & { marker: string };
const provider = (name: string, capabilities: string[], priority = 0): Provider => ({
  name, source: "test", version: "1.0.0", priority, providedCapabilities: capabilities, marker: name,
  dependencyCapabilities: [],
});

describe("CapabilityProviderRegistry", () => {
  it("selects the smallest deterministic provider set for requested capabilities", () => {
    const registry = new CapabilityProviderRegistry<Provider>();
    registry.register(provider("single-a", ["cap.a"], 100));
    registry.register(provider("single-b", ["cap.b"], 100));
    registry.register(provider("combined", ["cap.a", "cap.b"], 10));

    expect(registry.resolve(["cap.b", "cap.a", "cognitive.only"]).providers.map((item) => item.name)).toEqual(["combined"]);
    expect(registry.resolve(["cap.a", "cognitive.only"]).requestedCapabilities).toEqual(["cap.a"]);
  });

  it("resolves transitive provider dependencies", () => {
    const registry = new CapabilityProviderRegistry<Provider>();
    registry.register({ ...provider("request", ["web.request"]), dependencyCapabilities: ["session.open"] });
    registry.register(provider("session", ["session.open"]));
    expect(registry.resolve(["web.request"]).providers.map((item) => item.name)).toEqual(["request", "session"]);
  });

  it("removes draining and repeatedly failing providers from new resolutions", () => {
    const registry = new CapabilityProviderRegistry<Provider>(2);
    registry.register(provider("primary", ["cap.a"], 100));
    registry.register(provider("fallback", ["cap.a"], 10));
    registry.recordFailure("primary", "temporary failure");
    expect(registry.resolve(["cap.a"]).providers[0].name).toBe("fallback");
    registry.setLifecycle("fallback", "draining");
    registry.recordFailure("primary", "temporary failure");
    expect(registry.resolve(["cap.a"]).unresolvedCapabilities).toEqual(["cap.a"]);
  });

  it("requires replacement registration for retired provider names", () => {
    const registry = new CapabilityProviderRegistry<Provider>();
    registry.register(provider("provider", ["cap.a"]));
    expect(() => registry.replace({ ...provider("provider", ["cap.a"]), version: "2.0.0" })).toThrow(/must be retired/);
    registry.setLifecycle("provider", "retired");
    expect(() => registry.setLifecycle("provider", "active")).toThrow(/cannot be reactivated/);
    registry.replace({ ...provider("provider", ["cap.a"]), version: "2.0.0" });
    expect(registry.get("provider")).toMatchObject({ lifecycle: "active", health: "healthy", provider: { version: "2.0.0" } });
  });

  it("synchronizes dynamic discovery without keeping disappeared providers active", () => {
    const registry = new CapabilityProviderRegistry<Provider>();
    expect(registry.synchronize("test", [provider("first", ["cap.a"]), provider("second", ["cap.b"])]))
      .toMatchObject({ registered: ["first", "second"], draining: [] });
    const updated = { ...provider("first", ["cap.a"]), version: "2.0.0" };
    expect(registry.synchronize("test", [updated])).toMatchObject({ replaced: ["first"], draining: ["second"] });
    expect(registry.get("first")).toMatchObject({ lifecycle: "active", provider: { version: "2.0.0" } });
    expect(registry.get("second")).toMatchObject({ lifecycle: "draining" });
  });

  it("validates a complete discovery result before changing existing lifecycle state", () => {
    const registry = new CapabilityProviderRegistry<Provider>();
    registry.synchronize("test", [provider("existing", ["cap.a"])]);
    const invalid = { ...provider("invalid", ["cap.b"]), source: "different" };
    expect(() => registry.synchronize("test", [invalid])).toThrow(/does not belong/);
    expect(registry.get("existing")).toMatchObject({ lifecycle: "active" });
  });
});
