// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  artifactConsumptionLabel,
  buildEvidenceClusters,
  isPresentableEvidence,
  KnowledgePanel,
} from "./KnowledgePanel.js";
import { useStore } from "../store.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(createElement(KnowledgePanel)));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  useStore.setState(initialState, true);
  document.body.innerHTML = "";
});

const fact = {
  id: "fact_1",
  caseId: "case_1",
  type: "finding",
  title: "First candidate",
  value: { endpoint: "/resource" },
  source: { type: "ai", ref: "run_1" },
  confidence: 0.9,
  tags: [],
  createdAt: "now",
  updateCount: 0,
  updatedAt: "",
  validity: "valid" as const,
  findingStatus: "verified" as const,
};

describe("KnowledgePanel", () => {
  it("uses concise labels for every artifact consumption lifecycle state", () => {
    const consumption = {
      caseId: "case_1",
      runId: "run_1",
      artifactId: "artifact_1",
      taskId: "task_1",
      factIds: ["fact_1"],
      status: "pending" as const,
      usedByTool: null,
      missedActions: 0,
      updatedAt: "now",
      lastEventId: "timeline_1",
    };

    expect(artifactConsumptionLabel()).toBe("Not tracked");
    expect(artifactConsumptionLabel(consumption)).toBe("Awaiting use");
    expect(artifactConsumptionLabel({ ...consumption, status: "consumed" })).toBe("Used");
    expect(artifactConsumptionLabel({ ...consumption, status: "replan_requested" })).toBe("Needs attention");
    expect(artifactConsumptionLabel({ ...consumption, status: "closed" })).toBe("Tracking closed");
  });

  it("shows how analyzed artifact evidence was consumed by the Agent", () => {
    useStore.setState({
      artifacts: [{
        id: "artifact_1",
        caseId: "case_1",
        runId: "run_1",
        sourceUrl: "https://target.example/export",
        filename: "analysis.bin",
        relativePath: "artifacts/analysis.bin",
        byteSize: 2_048,
        sha256: "abc123",
        detectedFormat: "binary",
        mediaType: "application/octet-stream",
        status: "analyzed",
        analyzerId: "generic-binary",
        analysis: {
          analyzerId: "generic-binary",
          summary: "Candidate evidence recovered.",
          findings: [],
          coverage: { metadata: true, text: true, objectGraph: false, limitations: [] },
        },
        error: null,
        createdAt: "now",
        updatedAt: "now",
      }],
      artifactConsumptions: [{
        caseId: "case_1",
        runId: "run_1",
        artifactId: "artifact_1",
        taskId: "task_1",
        factIds: ["fact_1"],
        status: "consumed",
        usedByTool: "record_fact",
        missedActions: 0,
        updatedAt: "later",
        lastEventId: "timeline_2",
      }],
      artifactAnalysisAttempts: [{
        id: "attempt_1",
        caseId: "case_1",
        runId: "run_1",
        artifactId: "artifact_1",
        analyzerId: "generic-binary",
        status: "succeeded",
        coverageDimensions: ["metadata", "text"],
        error: null,
        analysis: {
          analyzerId: "generic-binary",
          summary: "Candidate evidence recovered.",
          findings: [],
          coverage: { metadata: true, text: true, objectGraph: false, limitations: [] },
        },
        startedAt: "now",
        finishedAt: "later",
      }, {
        id: "attempt_2",
        caseId: "case_1",
        runId: "run_1",
        artifactId: "artifact_1",
        analyzerId: "relationship-analyzer",
        status: "succeeded",
        coverageDimensions: ["object_graph"],
        error: null,
        analysis: {
          analyzerId: "relationship-analyzer",
          summary: "Relationships inspected.",
          findings: [],
          coverage: { metadata: false, text: false, objectGraph: true, limitations: [] },
        },
        startedAt: "later",
        finishedAt: "latest",
      }],
    });

    const panel = renderPanel();
    const artifact = panel.querySelector<HTMLDetailsElement>(".artifact-evidence-item");
    expect(artifact?.textContent).toContain("analysis.bin");
    expect(artifact?.textContent).toContain("Used");
    expect(artifact?.textContent).toContain("substantial");
    expect(artifact?.textContent).toContain("2 attempts");

    artifact?.setAttribute("open", "");
    expect(artifact?.textContent).toContain("task_1");
    expect(artifact?.textContent).toContain("record_fact");
    expect(artifact?.textContent).toContain("Not supported by this analysis alone");
    expect(artifact?.textContent).toContain("generic-binary");
    expect(artifact?.textContent).toContain("relationship-analyzer");
  });

  it("keeps internal failure memory out of security evidence", () => {
    const failedAttempt = {
      ...fact,
      id: "failure_1",
      type: "failed_attempt",
      title: "Failed attempt: record_fact",
      tags: ["failure-memory"],
      findingStatus: undefined,
    };

    expect(isPresentableEvidence(failedAttempt)).toBe(false);
    expect(buildEvidenceClusters([fact, failedAttempt])).toEqual([
      expect.objectContaining({ primary: expect.objectContaining({ id: fact.id }) }),
    ]);
  });

  it("groups only equivalent evidence records and keeps the newest record selectable", () => {
    const clusters = buildEvidenceClusters([
      { ...fact, id: "fact_1" },
      { ...fact, id: "fact_2" },
      { ...fact, id: "fact_3", findingStatus: "validating" as const },
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ count: 1, primary: { id: "fact_3" } });
    expect(clusters[1]).toMatchObject({ count: 2, primary: { id: "fact_2" } });
  });

  it("shows the case overview with the latest findings when nothing is selected", () => {
    useStore.setState({
      facts: [fact],
      tasks: [],
      selectedTrafficId: null,
      selectedFactId: null,
      selectedTaskId: null,
      selectedTimelineNodeId: null,
      selectedAgentEvent: null,
    });
    const panel = renderPanel();

    expect(panel.textContent).toContain("Overview");
    expect(panel.textContent).toContain("Evidence");
    expect(panel.textContent).toContain("First candidate");
  });

  it("switches from the overview to the finding inspector on selection", async () => {
    useStore.setState({
      facts: [fact],
      tasks: [],
      selectedTrafficId: null,
      selectedFactId: null,
      selectedTaskId: null,
      selectedTimelineNodeId: null,
      selectedAgentEvent: null,
    });
    const panel = renderPanel();
    expect(panel.textContent).toContain("Overview");

    await act(async () => {
      useStore.getState().selectFact("fact_1");
      await Promise.resolve();
    });

    expect(panel.textContent).not.toContain("1 records");
    expect(panel.textContent).toContain("Verified evidence");
    expect(panel.textContent).toContain("First candidate");
  });
});
