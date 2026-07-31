export type ArtifactStatus = "downloaded" | "analyzing" | "analyzed" | "unsupported" | "failed";

export interface ArtifactEvidence {
  objectId?: string;
  path?: string;
  relationship?: string;
  detail?: string;
}

export interface ArtifactFinding {
  kind: "credential" | "secret" | "configuration" | "identifier" | "relationship" | "metadata" | "other";
  label: string;
  value: string;
  confidence: number;
  sensitive?: boolean;
  evidence: ArtifactEvidence[];
}

export interface ArtifactAnalysisCoverage {
  metadata: boolean;
  text: boolean;
  objectGraph: boolean;
  limitations: string[];
}

export interface ArtifactAnalysis {
  analyzerId: string;
  summary: string;
  findings: ArtifactFinding[];
  coverage: ArtifactAnalysisCoverage;
}

export interface ArtifactRecord {
  id: string;
  caseId: string;
  runId: string | null;
  sourceUrl: string | null;
  filename: string;
  relativePath: string;
  byteSize: number;
  sha256: string;
  detectedFormat: string;
  mediaType: string | null;
  status: ArtifactStatus;
  analyzerId: string | null;
  analysis: ArtifactAnalysis | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
