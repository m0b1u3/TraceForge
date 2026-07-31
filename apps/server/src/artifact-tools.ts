import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ToolDescriptor } from "@traceforge/extension";
import type { ArtifactAnalyzerRegistry } from "./artifact-analyzer.js";
import type { ArtifactStore } from "./stores/artifact-store.js";

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

export function makeListArtifactsTool(caseId: string, store: ArtifactStore): ToolDescriptor {
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
        content: records.map((artifact) =>
          `${artifact.id} [${artifact.status}; format=${artifact.detectedFormat}; bytes=${artifact.byteSize}; sha256=${artifact.sha256}] ${artifact.relativePath}${artifact.analyzerId ? `; analyzer=${artifact.analyzerId}` : ""}${artifact.error ? `; error=${artifact.error}` : ""}`).join("\n"),
      };
    },
  };
}

export function makeAnalyzeArtifactTool(
  caseId: string,
  workspaceRoot: string,
  store: ArtifactStore,
  analyzers: ArtifactAnalyzerRegistry,
  onAnalyzed?: (artifactId: string, summary: string) => void,
): ToolDescriptor {
  return {
    name: "analyze_artifact",
    description: "Analyze one recorded artifact with a compatible structured analyzer. Returns explicit coverage, limitations, recovered values, and traceable object/file relationships. A failed or unsupported analysis must not be converted into a negative content conclusion.",
    inputSchema: {
      type: "object",
      properties: { artifactId: { type: "string" } },
      required: ["artifactId"],
    },
    risk: "normal",
    source: "builtin",
    executionMode: "serial",
    timeoutMs: 120_000,
    execute: async (input) => {
      const artifactId = (input as { artifactId?: string }).artifactId;
      if (!artifactId) return { ok: false, content: "missing artifactId" };
      const artifact = store.getById(artifactId);
      if (!artifact || artifact.caseId !== caseId) return { ok: false, content: `Artifact ${artifactId} does not exist in this Case.` };
      if (artifact.status === "analyzed" && artifact.analysis) {
        return { ok: true, content: formatAnalysis(artifact.id, artifact.analysis), meta: { artifactId } };
      }
      const analyzer = analyzers.find(artifact);
      if (!analyzer) {
        store.updateAnalysis(artifact.id, "unsupported", null, null, `No analyzer supports format ${artifact.detectedFormat}.`);
        return {
          ok: false,
          content: `Artifact ${artifact.id} format=${artifact.detectedFormat} has no compatible analyzer. Acquisition is verified, content is not. Do not infer absence from this result.`,
        };
      }
      const caseRoot = resolve(workspaceRoot, "data/cases", caseId);
      const absolutePath = resolve(caseRoot, artifact.relativePath);
      if (!absolutePath.startsWith(caseRoot + sep)) return { ok: false, content: "artifact path escapes Case workspace" };
      store.updateAnalysis(artifact.id, "analyzing", analyzer.id, null);
      try {
        const analysis = await analyzer.analyze(artifact, absolutePath);
        store.updateAnalysis(artifact.id, "analyzed", analyzer.id, analysis);
        onAnalyzed?.(artifact.id, analysis.summary);
        return { ok: true, content: formatAnalysis(artifact.id, analysis), meta: { artifactId, analyzerId: analyzer.id } };
      } catch (error) {
        const message = (error as Error).message;
        store.updateAnalysis(artifact.id, "failed", analyzer.id, null, message);
        return {
          ok: false,
          content: `Artifact ${artifact.id} analysis failed with ${analyzer.id}: ${message}. Acquisition remains verified; content conclusions remain unresolved.`,
        };
      }
    },
  };
}
