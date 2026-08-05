import type { ArtifactAnalysis, ArtifactEvidence, ArtifactFinding, ArtifactRecord } from "./artifact.js";
import type { ArtifactAnalysisAttempt, ArtifactAnalyzerCapability } from "./artifact-analysis-attempt.js";

export interface AggregatedArtifactFinding extends ArtifactFinding {
  analyzerIds: string[];
  attemptIds: string[];
}

export interface ArtifactAnalysisLimitation {
  analyzerId: string;
  attemptId: string | null;
  detail: string;
}

export interface ArtifactAnalysisAggregate {
  artifactId: string;
  quality: "pending" | "incomplete" | "substantial" | "unavailable";
  coveredDimensions: ArtifactAnalyzerCapability["coverageDimensions"];
  missingDimensions: ArtifactAnalyzerCapability["coverageDimensions"];
  analyzerIds: string[];
  attemptIds: string[];
  findings: AggregatedArtifactFinding[];
  limitations: ArtifactAnalysisLimitation[];
  followUpRequired: boolean;
  negativeConclusionSupported: false;
  nextAction: string;
}

interface AnalysisSource {
  analyzerId: string;
  attemptId: string | null;
  analysis: ArtifactAnalysis;
}

const dimensions = ["metadata", "text", "object_graph"] as const;

function evidenceKey(evidence: ArtifactEvidence): string {
  return [evidence.objectId, evidence.path, evidence.relationship, evidence.detail]
    .map((value) => value ?? "")
    .join("\u0000");
}

function findingKey(finding: ArtifactFinding): string {
  return [finding.kind, finding.label, finding.value].join("\u0000");
}

function sourceAnalyses(artifact: ArtifactRecord, attempts: ArtifactAnalysisAttempt[]): AnalysisSource[] {
  const succeeded: AnalysisSource[] = attempts
    .filter((attempt) => attempt.artifactId === artifact.id && attempt.status === "succeeded" && attempt.analysis)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
    .map((attempt) => ({
      analyzerId: attempt.analysis!.analyzerId,
      attemptId: attempt.id,
      analysis: attempt.analysis!,
    }));

  if (artifact.analysis && !succeeded.some((source) => source.analyzerId === artifact.analysis!.analyzerId)) {
    succeeded.push({ analyzerId: artifact.analysis.analyzerId, attemptId: null, analysis: artifact.analysis });
  }
  return succeeded;
}

export function aggregateArtifactAnalysis(
  artifact: ArtifactRecord,
  attempts: ArtifactAnalysisAttempt[],
): ArtifactAnalysisAggregate {
  const sources = sourceAnalyses(artifact, attempts);
  const covered = new Set<ArtifactAnalyzerCapability["coverageDimensions"][number]>();
  const findings = new Map<string, AggregatedArtifactFinding>();
  const limitations = new Map<string, ArtifactAnalysisLimitation>();

  for (const source of sources) {
    if (source.analysis.coverage.metadata) covered.add("metadata");
    if (source.analysis.coverage.text) covered.add("text");
    if (source.analysis.coverage.objectGraph) covered.add("object_graph");
    for (const detail of source.analysis.coverage.limitations) {
      const key = `${source.analyzerId}\u0000${detail}`;
      if (!limitations.has(key)) limitations.set(key, { analyzerId: source.analyzerId, attemptId: source.attemptId, detail });
    }
    for (const finding of source.analysis.findings) {
      const key = findingKey(finding);
      const existing = findings.get(key);
      if (!existing) {
        findings.set(key, {
          ...finding,
          evidence: [...finding.evidence],
          analyzerIds: [source.analyzerId],
          attemptIds: source.attemptId ? [source.attemptId] : [],
        });
        continue;
      }
      existing.confidence = Math.max(existing.confidence, finding.confidence);
      existing.sensitive = existing.sensitive || finding.sensitive || undefined;
      if (!existing.analyzerIds.includes(source.analyzerId)) existing.analyzerIds.push(source.analyzerId);
      if (source.attemptId && !existing.attemptIds.includes(source.attemptId)) existing.attemptIds.push(source.attemptId);
      const knownEvidence = new Set(existing.evidence.map(evidenceKey));
      for (const evidence of finding.evidence) {
        const key = evidenceKey(evidence);
        if (!knownEvidence.has(key)) {
          existing.evidence.push(evidence);
          knownEvidence.add(key);
        }
      }
    }
  }

  const coveredDimensions = dimensions.filter((dimension) => covered.has(dimension));
  const missingDimensions = dimensions.filter((dimension) => !covered.has(dimension));
  const unavailable = sources.length === 0 && (artifact.status === "failed" || artifact.status === "unsupported");
  const pending = sources.length === 0 && !unavailable;
  const complete = sources.length > 0 && missingDimensions.length === 0;
  const quality: ArtifactAnalysisAggregate["quality"] = unavailable
    ? "unavailable"
    : pending
      ? "pending"
      : complete
        ? "substantial"
        : "incomplete";
  if (unavailable) {
    const detail = artifact.error ?? "No compatible analysis result is available.";
    limitations.set(`artifact\u0000${detail}`, { analyzerId: "artifact", attemptId: null, detail });
  }

  return {
    artifactId: artifact.id,
    quality,
    coveredDimensions,
    missingDimensions,
    analyzerIds: [...new Set(sources.map((source) => source.analyzerId))],
    attemptIds: sources.flatMap((source) => source.attemptId ? [source.attemptId] : []),
    findings: [...findings.values()],
    limitations: [...limitations.values()],
    followUpRequired: !complete,
    negativeConclusionSupported: false,
    nextAction: complete
      ? "Review the cumulative recovered evidence in the current Task."
      : unavailable
        ? "Use another compatible analysis method or record the unresolved limitation."
        : pending
          ? "Run a compatible structured analyzer before drawing content conclusions."
          : "Address the missing cumulative coverage with another compatible method or retain the limitation in the Task conclusion.",
  };
}
