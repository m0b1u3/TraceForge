import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { CaseStore } from "./stores/case-store.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { IdentityStore } from "./stores/identity-store.js";
import { AttackPathStore } from "./stores/attack-path-store.js";

describe("AttackPathStore real SQLite lifecycle", () => {
  it("persists an evidence-linked path and advances it across runs without losing provenance", () => {
    const db = createDb(":memory:");
    const caseId = new CaseStore(db).create("attack path", []).id;
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const identities = new IdentityStore(db);
    const paths = new AttackPathStore(db);

    const asset = facts.create(caseId, {
      type: "asset",
      title: "Admin API",
      value: { url: "https://target.test/admin" },
      source: { type: "traffic", ref: "traffic_1" },
      confidence: 1,
      tags: [],
      sourceRunId: "run_1",
    });
    const hypothesis = hypotheses.create(caseId, {
      statement: "A normal user can reach the admin API",
      basedOnFactIds: [asset.id],
      runId: "run_1",
      status: "active",
    });
    const identity = identities.create(caseId, {
      name: "normal-user",
      kind: "user",
      status: "active",
      credentials: { username: "alice", password: "plain-text-is-intentional" },
      headers: {},
      cookies: [],
    });

    const created = paths.create(caseId, {
      title: "User to admin control",
      objective: "Reach an administrative action as a normal user",
      status: "exploring",
      confidence: 0.45,
      sourceRunId: "run_1",
      lastRunId: "run_1",
      entryIdentityId: identity.id,
      targetAssetFactId: asset.id,
      findingFactIds: [],
      hypothesisIds: [hypothesis.id],
      evidenceRefs: [asset.id],
      breakpoint: "Need an authorization differential",
      steps: [{
        id: "step_access",
        order: 0,
        kind: "access",
        title: "Authenticate as normal user",
        description: "",
        status: "observed",
        identityId: identity.id,
        trafficId: null,
        factIds: [asset.id],
        taskId: null,
        actionId: null,
        prerequisiteStepIds: [],
        validation: "Identity recorded",
      }],
    });

    const advanced = paths.update(created.id, {
      lastRunId: "run_2",
      confidence: 0.7,
      breakpoint: "Compare admin-only mutation under both identities",
      steps: [{
        ...created.steps[0],
        status: "verified",
        validation: "Credential and authenticated response verified",
      }],
    });

    expect(advanced).toMatchObject({
      sourceRunId: "run_1",
      lastRunId: "run_2",
      version: 2,
      confidence: 0.7,
    });
    expect(new AttackPathStore(db).getById(created.id)).toEqual(advanced);
  });

  it("rejects unsupported verified steps and cross-case references", () => {
    const db = createDb(":memory:");
    const cases = new CaseStore(db);
    const caseA = cases.create("A", []).id;
    const caseB = cases.create("B", []).id;
    const foreignFact = new FactStore(db).create(caseB, {
      type: "asset",
      title: "foreign",
      value: {},
      source: { type: "manual", ref: "test" },
      confidence: 1,
      tags: [],
    });
    const paths = new AttackPathStore(db);
    expect(() => paths.create(caseA, {
      title: "Invalid",
      objective: "Should fail",
      status: "exploring",
      confidence: 0.5,
      sourceRunId: "run_1",
      lastRunId: "run_1",
      entryIdentityId: null,
      targetAssetFactId: foreignFact.id,
      findingFactIds: [],
      hypothesisIds: [],
      evidenceRefs: [],
      breakpoint: null,
      steps: [{
        id: "step_1",
        order: 0,
        kind: "impact",
        title: "Unsupported impact",
        description: "",
        status: "verified",
        identityId: null,
        trafficId: null,
        factIds: [],
        taskId: null,
        actionId: null,
        prerequisiteStepIds: [],
        validation: "",
      }],
    })).toThrow(/requires evidence Facts/);

    expect(() => paths.create(caseA, {
      title: "Cross-case",
      objective: "Should also fail",
      status: "exploring",
      confidence: 0.5,
      sourceRunId: "run_1",
      lastRunId: "run_1",
      entryIdentityId: null,
      targetAssetFactId: foreignFact.id,
      findingFactIds: [],
      hypothesisIds: [],
      evidenceRefs: [],
      breakpoint: "Foreign asset reference",
      steps: [{
        id: "step_1",
        order: 0,
        kind: "access",
        title: "Observe target",
        description: "",
        status: "observed",
        identityId: null,
        trafficId: null,
        factIds: [],
        taskId: null,
        actionId: null,
        prerequisiteStepIds: [],
        validation: "",
      }],
    })).toThrow(/Fact references are missing or belong to another case/);
  });
});
