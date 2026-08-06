import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ToolDescriptor } from "@traceforge/extension";
import type { ArtifactAnalysisAttempt, ArtifactRecord } from "@traceforge/shared";
import type { ArtifactAnalyzerRegistry } from "./artifact-analyzer.js";
import type { ArtifactAnalysisAttemptStore } from "./stores/artifact-analysis-attempt-store.js";
import type { ArtifactStore } from "./stores/artifact-store.js";
import { planArtifactAnalysis, type ArtifactAnalysisPlan } from "./artifact-analysis-planner.js";

export type ArtifactChangeReason = "cached" | "analyzing" | "analyzed" | "unsupported" | "failed";

function detectExistingFormat(buffer: Buffer, filename: string): string {
  if (buffer.subarray(0, 4).toString("ascii") === "JAVA") return "java-hprof";
  if (buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return "elf";
  if (buffer.subarray(0, 2).toString("ascii") === "MZ") return "pe";
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "zip";
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") return "pdf";
  if (/\.json$/i.test(filename)) return "json";
  if (/\.html?$/i.test(filename)) return "html";
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  const controls = [...sample].filter((byte) => byte < 9 || (byte > 13 && byte < 32)).length;
  return sample.length > 0 && controls / sample.length < 0.02 ? "text" : "binary";
}

async function inspectExistingFile(path: string, filename: string): Promise<{
  sha256: string;
  detectedFormat: string;
}> {
  const handle = await open(path, "r");
  const sample = Buffer.alloc(4_096);
  const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
  await handle.close();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return {
    sha256: hash.digest("hex"),
    detectedFormat: detectExistingFormat(sample.subarray(0, bytesRead), filename),
  };
}

export async function registerExistingCaseArtifacts(
  caseId: string,
  workspaceRoot: string,
  store: ArtifactStore,
): Promise<void> {
  const downloadDir = resolve(workspaceRoot, "data/cases", caseId, "downloads");
  let filenames: string[];
  try {
    filenames = await readdir(downloadDir);
  } catch {
    return;
  }
  const knownPaths = new Set(store.listByCase(caseId).map((artifact) => artifact.relativePath));
  for (const filename of filenames) {
    const relativePath = `downloads/${filename}`;
    if (knownPaths.has(relativePath)) continue;
    const absolutePath = resolve(downloadDir, filename);
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) continue;
    const inspected = await inspectExistingFile(absolutePath, filename);
    store.record({
      caseId,
      runId: null,
      sourceUrl: null,
      filename,
      relativePath,
      byteSize: metadata.size,
      sha256: inspected.sha256,
      detectedFormat: inspected.detectedFormat,
      mediaType: null,
    });
  }
}

function formatAnalysis(artifactId: string, analysis: NonNullable<ReturnType<ArtifactStore["getById"]>>["analysis"]): string {
  if (!analysis) return `Artifact ${artifactId} has no analysis.`;
  const findings = analysis.findings.length === 0
    ? "(none recovered)"
    : analysis.findings.map((finding, index) => [
      `${index + 1}. kind=${finding.kind}; label=${finding.label}; value=${finding.value}; confidence=${finding.confidence}`,
      `evidence=${finding.evidence.map((item) => [item.objectId, item.path, item.relationship, item.detail].filter(Boolean).join(" ")).join(" | ")}`,
    ].join("\n")).join("\n");
  return [
    `Artifact ${artifactId} analysis by ${analysis.analyzerId}: ${analysis.summary}`,
    `coverage: metadata=${analysis.coverage.metadata}; text=${analysis.coverage.text}; objectGraph=${analysis.coverage.objectGraph}`,
    `limitations: ${analysis.coverage.limitations.join(" | ") || "none"}`,
    `findings:\n${findings}`,
  ].join("\n");
}

function formatAnalysisPlan(plan: ArtifactAnalysisPlan): string {
  return [
    `Artifact ${plan.artifactId} analysis plan: ${plan.status}.`,
    `missingDimensions=${plan.missingDimensions.join(",") || "none"}`,
    `recommendedAnalyzer=${plan.recommendedAnalyzerId ?? "none"}`,
    `reason=${plan.reason}`,
    `candidates=${plan.candidates.length === 0 ? "none" : plan.candidates.map((candidate) =>
      `${candidate.analyzerId}[availability=${candidate.availability}; eligible=${candidate.eligible}; recoveryRequired=${candidate.requiresRecovery}; gain=${candidate.coverageGain.join(",") || "none"}; ${candidate.reason}${candidate.recoveryHint ? `; recovery=${candidate.recoveryHint}` : ""}]`).join(" | ")}`,
    "Run only the recommended analyzer. Re-plan after that attempt finishes before choosing another method.",
  ].join("\n");
}

export function makePlanArtifactAnalysisTool(
  caseId: string,
  store: ArtifactStore,
  analyzers: ArtifactAnalyzerRegistry,
  attempts: ArtifactAnalysisAttemptStore,
): ToolDescriptor {
  return {
    name: "plan_artifact_analysis",
    description: "Plan the next single artifact analysis method from missing coverage, registered analyzer capabilities, and persistent attempt history. This tool plans only; it never starts concurrent analysis.",
    inputSchema: {
      type: "object",
      properties: { artifactId: { type: "string" } },
      required: ["artifactId"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const artifactId = (input as { artifactId?: string }).artifactId;
      if (!artifactId) return { ok: false, content: "missing artifactId" };
      const artifact = store.getById(artifactId);
      if (!artifact || artifact.caseId !== caseId) return { ok: false, content: `Artifact ${artifactId} does not exist in this Case.` };
      return {
        ok: true,
        content: formatAnalysisPlan(planArtifactAnalysis(
          artifact,
          analyzers.capabilities(artifact),
          attempts.listByArtifact(artifact.id),
        )),
      };
    },
  };
}

export function makeListArtifactsTool(
  caseId: string,
  store: ArtifactStore,
  analyzers?: ArtifactAnalyzerRegistry,
  attempts?: ArtifactAnalysisAttemptStore,
): ToolDescriptor {
  return {
    name: "list_artifacts",
    description: "List persistent artifacts acquired in this Case, including hash, format, analysis status, and coverage. Use this before repeating a download or claiming an artifact was not acquired.",
    inputSchema: { type: "object", properties: {} },
    risk: "normal",
    source: "builtin",
    execute: async () => {
      const records = store.listByCase(caseId);
      if (records.length === 0) return { ok: true, content: "No artifacts are recorded for this Case." };
      return {
        ok: true,
        content: records.map((artifact) => {
          const compatible = analyzers?.capabilities(artifact).filter((item) => item.compatible) ?? [];
          const history = attempts?.listByArtifact(artifact.id) ?? [];
          return [
            `${artifact.id} [${artifact.status}; format=${artifact.detectedFormat}; bytes=${artifact.byteSize}; sha256=${artifact.sha256}] ${artifact.relativePath}${artifact.analyzerId ? `; analyzer=${artifact.analyzerId}` : ""}${artifact.error ? `; error=${artifact.error}` : ""}`,
            `compatibleAnalyzers=${compatible.map((item) => `${item.analyzerId}(availability=${item.availability ?? "ready"}; coverage=${item.coverageDimensions.join(",") || "declared coverage unavailable"}; reason=${item.availabilityReason ?? "none"}${item.recoveryHint ? `; recovery=${item.recoveryHint}` : ""})`).join(" | ") || "none"}`,
            `attempts=${history.length === 0 ? "none" : history.slice(0, 5).map((attempt) => `${attempt.analyzerId ?? "unresolved"}:${attempt.status}${attempt.error ? `(${attempt.error})` : ""}`).join(" | ")}`,
          ].join("\n");
        }).join("\n\n"),
      };
    },
  };
}

export function makeAnalyzeArtifactTool(
  caseId: string,
  workspaceRoot: string,
  store: ArtifactStore,
  analyzers: ArtifactAnalyzerRegistry,
  options: {
    onChanged?: (artifact: ArtifactRecord, reason: ArtifactChangeReason) => void;
    attempts?: ArtifactAnalysisAttemptStore;
    runId?: string | null;
    onAttemptChanged?: (attempt: ArtifactAnalysisAttempt) => void;
  } = {},
): ToolDescriptor {
  return {
    name: "analyze_artifact",
    description: "Analyze one recorded artifact with a compatible structured analyzer. Returns explicit coverage, limitations, recovered values, and traceable object/file relationships. A failed or unsupported analysis must not be converted into a negative content conclusion.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string" },
        analyzerId: { type: "string" },
        retry: { type: "boolean" },
      },
      required: ["artifactId"],
    },
    risk: "normal",
    source: "builtin",
    executionMode: "serial",
    timeoutMs: 120_000,
    execute: async (input) => {
      const request = input as { artifactId?: string; analyzerId?: string; retry?: boolean };
      const artifactId = request.artifactId;
      if (!artifactId) return { ok: false, content: "missing artifactId" };
      const artifact = store.getById(artifactId);
      if (!artifact || artifact.caseId !== caseId) return { ok: false, content: `Artifact ${artifactId} does not exist in this Case.` };
      const previousAttempts = options.attempts?.listByArtifact(artifact.id) ?? [];
      const capabilities = analyzers.capabilities(artifact);
      const plan = planArtifactAnalysis(artifact, capabilities, previousAttempts);
      if (!request.analyzerId && artifact.status === "analyzed" && artifact.analysis && plan.status !== "ready") {
        options.onChanged?.(artifact, "cached");
        return { ok: true, content: `${formatAnalysis(artifact.id, artifact.analysis)}\n${formatAnalysisPlan(plan)}`, meta: { artifactId } };
      }
      if (!request.analyzerId && plan.status === "running") {
        return { ok: false, content: formatAnalysisPlan(plan) };
      }
      if (!request.analyzerId && plan.status !== "ready") {
        return { ok: false, content: formatAnalysisPlan(plan) };
      }
      const selectedAnalyzerId = request.analyzerId ?? plan.recommendedAnalyzerId ?? undefined;
      const selectedCapability = capabilities.find((capability) => capability.analyzerId === selectedAnalyzerId);
      if (selectedCapability?.compatible && selectedCapability.availability === "unavailable") {
        return {
          ok: false,
          content: [
            `Analyzer ${selectedCapability.analyzerId} failed execution preflight: ${selectedCapability.availabilityReason ?? "required dependency is unavailable"}.`,
            selectedCapability.recoveryHint ? `Recovery: ${selectedCapability.recoveryHint}` : null,
            "No analysis attempt was started. Acquisition remains verified and content conclusions remain unresolved.",
          ].filter(Boolean).join(" "),
        };
      }
      const analyzer = analyzers.find(artifact, selectedAnalyzerId);
      const activeSameMethod = previousAttempts.find((attempt) =>
        attempt.analyzerId === (analyzer?.id ?? selectedAnalyzerId ?? null)
        && attempt.status === "running");
      if (activeSameMethod) {
        return {
          ok: false,
          content: `Analyzer ${activeSameMethod.analyzerId ?? "selection"} already has a running attempt ${activeSameMethod.id}. Wait for that attempt instead of starting another one.`,
        };
      }
      const previousSameMethod = previousAttempts.find((attempt) =>
        attempt.analyzerId === (analyzer?.id ?? selectedAnalyzerId ?? null)
        && ["succeeded", "failed", "unsupported"].includes(attempt.status));
      if (previousSameMethod && !request.retry) {
        return {
          ok: false,
          content: `Analyzer ${previousSameMethod.analyzerId ?? "selection"} already ended as ${previousSameMethod.status}: ${previousSameMethod.error ?? "its declared coverage was recorded"}. Re-plan, choose another compatible analyzer, or set retry=true only after conditions changed.`,
        };
      }
      if (!analyzer) {
        const error = selectedAnalyzerId
          ? `Analyzer ${selectedAnalyzerId} is unavailable or incompatible with format ${artifact.detectedFormat}.`
          : `No analyzer supports format ${artifact.detectedFormat}.`;
        const attempt = options.attempts?.start({
          caseId,
          runId: options.runId ?? artifact.runId,
          artifactId: artifact.id,
          analyzerId: selectedAnalyzerId ?? null,
          coverageDimensions: [],
          status: "unsupported",
          error,
        });
        if (attempt) options.onAttemptChanged?.(attempt);
        const unsupported = store.updateAnalysis(artifact.id, "unsupported", selectedAnalyzerId ?? null, null, error);
        if (unsupported) options.onChanged?.(unsupported, "unsupported");
        return {
          ok: false,
          content: `${error} Acquisition is verified, content is not. Do not infer absence from this result.`,
        };
      }
      const caseRoot = resolve(workspaceRoot, "data/cases", caseId);
      const absolutePath = resolve(caseRoot, artifact.relativePath);
      if (!absolutePath.startsWith(caseRoot + sep)) return { ok: false, content: "artifact path escapes Case workspace" };
      const attempt = options.attempts?.start({
        caseId,
        runId: options.runId ?? artifact.runId,
        artifactId: artifact.id,
        analyzerId: analyzer.id,
        coverageDimensions: analyzer.coverageDimensions ?? [],
      });
      if (attempt) options.onAttemptChanged?.(attempt);
      const analyzing = store.updateAnalysis(artifact.id, "analyzing", analyzer.id, null);
      if (analyzing) options.onChanged?.(analyzing, "analyzing");
      try {
        const analysis = await analyzer.analyze(artifact, absolutePath);
        const analyzed = store.updateAnalysis(artifact.id, "analyzed", analyzer.id, analysis);
        if (attempt) {
          const completed = options.attempts?.finish(attempt.id, "succeeded", null, analysis);
          if (completed) options.onAttemptChanged?.(completed);
        }
        if (analyzed) options.onChanged?.(analyzed, "analyzed");
        return { ok: true, content: formatAnalysis(artifact.id, analysis), meta: { artifactId, analyzerId: analyzer.id } };
      } catch (error) {
        const message = (error as Error).message;
        if (attempt) {
          const completed = options.attempts?.finish(attempt.id, "failed", message);
          if (completed) options.onAttemptChanged?.(completed);
        }
        const failed = store.updateAnalysis(artifact.id, "failed", analyzer.id, null, message);
        if (failed) options.onChanged?.(failed, "failed");
        return {
          ok: false,
          content: `Artifact ${artifact.id} analysis failed with ${analyzer.id}: ${message}. Acquisition remains verified; content conclusions remain unresolved.`,
        };
      }
    },
  };
}
