import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExecutionSessionGateway } from "./execution-session-gateway.js";

const cookie = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
});

function message(error: unknown): string { return error instanceof Error ? error.message : "execution session operation failed"; }

export function registerExecutionSessionRoutes(app: FastifyInstance, sessions: ExecutionSessionGateway): void {
  app.post("/api/execution/identities", async (request, reply) => {
    try {
      const body = z.object({
        id: z.string().min(1).optional(),
        caseId: z.string().min(1),
        name: z.string().min(1),
        kind: z.enum(["anonymous", "user", "admin", "service", "custom"]),
        secret: z.object({ headers: z.record(z.string()).default({}), cookies: z.array(cookie).default([]) }),
      }).parse(request.body);
      return reply.code(201).send(sessions.createIdentity(body));
    } catch (error) { return reply.code(400).send({ error: message(error) }); }
  });

  app.get("/api/execution/identities", async (request, reply) => {
    try {
      const { caseId } = z.object({ caseId: z.string().min(1) }).parse(request.query);
      return sessions.listIdentities(caseId);
    } catch (error) { return reply.code(400).send({ error: message(error) }); }
  });

  app.post("/api/execution/identities/:identityId/revoke", async (request, reply) => {
    try {
      const { identityId } = z.object({ identityId: z.string().min(1) }).parse(request.params);
      return sessions.revokeIdentity(identityId);
    } catch (error) { return reply.code(400).send({ error: message(error) }); }
  });

  app.get("/api/execution/sessions", async (request, reply) => {
    try {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.query);
      return sessions.listSessions(runId);
    } catch (error) { return reply.code(400).send({ error: message(error) }); }
  });

  app.post("/api/execution/sessions/:sessionId/close", async (request, reply) => {
    try {
      const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      return sessions.close(sessionId);
    } catch (error) { return reply.code(400).send({ error: message(error) }); }
  });
}
