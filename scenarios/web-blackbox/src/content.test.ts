import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { authorizeScenarioResource, parseScenarioPackageDescriptor } from "@traceforge/scenario-sdk";
import { inspectDocument } from "../runtime-src/surface-document.mjs";

const root = resolve("scenarios/web-blackbox");
describe("Web Scenario playbooks and passive discovery", () => {
  it("ships reviewed phase-local playbooks with exact content digests and resolvable references", () => {
    const descriptor = parseScenarioPackageDescriptor(JSON.parse(readFileSync(resolve(root, "scenario.json"), "utf8")));
    const resources = descriptor.resourceManifest!.resources;
    const ids = new Set(resources.map(item => item.id));
    for (const id of ids) expect(authorizeScenarioResource(descriptor.authorizationPolicy, {}, "context.resource", id)).toBe(id);
    expect(() => authorizeScenarioResource(descriptor.authorizationPolicy, {}, "context.resource", "unregistered")).toThrow();
    expect(descriptor.version).toBe("0.5.6");
    for (const resource of resources) {
      const bytes = readFileSync(resolve(root, resource.locator.slice("package://".length)));
      expect(resource.digest, resource.id).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      for (const ref of resource.context!.references) expect(ids.has(ref), ref).toBe(true);
      expect(resource.context!.readerRoles).toEqual(["worker", "planner", "observer"]);
    }
    expect(resources.find(item => item.id === "web.review-and-report")?.context?.phaseIds).toEqual(["synthesis", "reporting"]);
    expect(resources.find(item => item.id === "web.hypothesis-validation")?.context?.phaseIds).toEqual(["hypothesis_planning", "validation"]);
    expect(resources.find(item => item.id === "web.vulnerability-techniques")?.context?.phaseIds).toEqual(["surface_mapping", "hypothesis_planning", "validation"]);
    for (const pool of descriptor.definition.agentTopology!.workerPools) {
      expect(pool.capabilities).toEqual(expect.arrayContaining(["tool.recall", "context.catalog", "context.read", "context.search"]));
      expect(pool.capabilities).toContain("web.investigation.snapshot");
      if (pool.role === "researcher") expect(pool.capabilities).not.toContain("web.validation.execute");
      if (pool.role === "reporter") expect(pool.capabilities).not.toContain("web.request.replay");
    }
    for (const phase of descriptor.definition.phases) expect(phase.requiredCapabilities).toEqual(expect.arrayContaining(["tool.recall", "context.catalog", "context.read", "context.search"]));
  });

  it("extracts link and form metadata without credentials, scripts, comments or automatic form requests", () => {
    const hints = inspectDocument(`<a href='/path?first=1&amp;second=2'>link</a>
      <!-- <a href='/comment'>untrusted</a> --><script>"<a href='/script'>not markup</a>"</script>
      <form action='/change' method='post'><input name='password' type='password' value='do-not-return'>
      <input name='csrf' value='private-state'><button name='submit' value='execute'>submit</button></form>
      <a href='https://outside.invalid/'>external</a><a href='javascript:alert(1)'>invalid</a>`,
    "https://target.invalid/", new Set(["https://target.invalid"]), 8);
    expect(hints.sameOrigin).toEqual(["https://target.invalid/path?first=1&second=2"]);
    expect(hints.external).toEqual(["https://outside.invalid/"]);
    expect(hints.forms[0]).toMatchObject({ action: "https://target.invalid/change", method: "POST", automaticSubmission: false });
    expect(JSON.stringify(hints)).not.toMatch(/do-not-return|private-state|\/comment|\/script|javascript:/);
  });

  it("reports bounded link, form and field omissions rather than silently claiming full extraction", () => {
    const body = Array.from({ length: 12 }, (_, i) => `<a href='/page/${i}'>link</a>`).join("")
      + Array.from({ length: 10 }, () => `<form>${Array.from({ length: 20 }, (_, i) => `<input name='field-${i}' value='never-return'>`).join("")}</form>`).join("");
    const hints = inspectDocument(body, "https://target.invalid/", new Set(["https://target.invalid"]), 2);
    expect(hints.sameOrigin).toHaveLength(2); expect(hints.hintsTruncated).toBe(true);
    expect(hints.forms.length).toBeLessThanOrEqual(8); expect(hints.forms[0].fields).toHaveLength(16);
    expect(hints.forms[0].fieldsTruncated).toBe(true);
    expect(inspectDocument("<form></form>".repeat(10), "https://target.invalid/", new Set(["https://target.invalid"]), 2).forms).toHaveLength(8);
  });

  it("keeps form metadata within the Host artifact budget even for long multibyte field names", () => {
    const body = Array.from({ length: 8 }, () => `<form action='/${"x".repeat(800)}'>${Array.from({ length: 16 }, () => `<input name='${"字".repeat(128)}'>`).join("")}</form>`).join("");
    const hints = inspectDocument(body, "https://target.invalid/", new Set(["https://target.invalid"]), 64);
    expect(Buffer.byteLength(JSON.stringify(hints.forms))).toBeLessThanOrEqual(4096);
    expect(hints.hintsTruncated).toBe(true);
  });
});
