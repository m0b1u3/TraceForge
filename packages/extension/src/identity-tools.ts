import type { IdentityContext, RuntimeEvent, TimelineEntry } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export interface IdentityWriter {
  create(caseId: string, input: Omit<IdentityContext, "id" | "caseId" | "version" | "createdAt" | "updatedAt">): IdentityContext;
  getById(id: string): IdentityContext | undefined;
  update(id: string, patch: Partial<Pick<IdentityContext, "name" | "kind" | "status" | "credentials" | "headers" | "cookies">>): IdentityContext | undefined;
  listByCase(caseId: string): IdentityContext[];
}

export interface IdentityTimeline {
  append(caseId: string, eventType: string, detail: string, refId?: string): TimelineEntry;
}

export interface BrowserIdentityController {
  applyIdentity(identity: IdentityContext): Promise<void>;
}

type Emit = (event: RuntimeEvent) => void;

export function makeListIdentitiesTool(caseId: string, identities: IdentityWriter): ToolDescriptor {
  return {
    name: "list_identities",
    description: "List named identities available in this case, including role, status, version, headers, cookies, and plaintext credentials.",
    inputSchema: { type: "object", properties: {} },
    risk: "normal",
    source: "builtin",
    executionMode: "parallel",
    execute: async () => ({
      ok: true,
      content: JSON.stringify(identities.listByCase(caseId), null, 2),
    }),
  };
}

export function makeRecordIdentityTool(
  caseId: string,
  identities: IdentityWriter,
  timeline: IdentityTimeline,
  emit: Emit,
): ToolDescriptor {
  return {
    name: "record_identity",
    description: "Create or update a named security identity. Credentials remain plaintext so the Agent can reason about them. Updating session material increments the identity version.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        kind: { type: "string", enum: ["guest", "user", "admin", "service", "custom"] },
        status: { type: "string", enum: ["active", "expired", "revoked"] },
        credentials: { type: "object" },
        headers: { type: "object" },
        cookies: { type: "array", items: { type: "object" } },
      },
      required: ["name", "kind"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const value = input as Partial<IdentityContext>;
      let identity: IdentityContext | undefined;
      if (value.id) {
        const existing = identities.getById(value.id);
        if (!existing || existing.caseId !== caseId) return { ok: false, content: "identity not found in this case" };
        identity = identities.update(value.id, {
          name: value.name,
          kind: value.kind,
          status: value.status,
          credentials: value.credentials,
          headers: value.headers,
          cookies: value.cookies,
        });
      } else {
        identity = identities.create(caseId, {
          name: value.name ?? "",
          kind: value.kind ?? "custom",
          status: value.status ?? "active",
          credentials: value.credentials ?? {},
          headers: value.headers ?? {},
          cookies: value.cookies ?? [],
        });
      }
      if (!identity) return { ok: false, content: "identity update failed" };
      const entry = timeline.append(caseId, value.id ? "identity_updated" : "identity_created", `${identity.name} v${identity.version}`, identity.id);
      emit({ type: value.id ? "identity_updated" : "identity_created", identity });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `identityId=${identity.id} version=${identity.version}` };
    },
  };
}

export function makeUseBrowserIdentityTool(
  caseId: string,
  identities: IdentityWriter,
  browser: BrowserIdentityController,
): ToolDescriptor {
  return {
    name: "use_browser_identity",
    description: "Replace the shared browser cookies and extra headers with one named identity and attribute subsequent browser traffic to it.",
    inputSchema: {
      type: "object",
      properties: { identityId: { type: "string" } },
      required: ["identityId"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const { identityId } = input as { identityId: string };
      const identity = identities.getById(identityId);
      if (!identity || identity.caseId !== caseId) return { ok: false, content: "identity not found in this case" };
      try {
        await browser.applyIdentity(identity);
        return { ok: true, content: `browser identity=${identity.name} version=${identity.version}` };
      } catch (error) {
        return { ok: false, content: (error as Error).message };
      }
    },
  };
}
