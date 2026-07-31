import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactAnalysis, ArtifactFinding, ArtifactRecord } from "@traceforge/shared";

export interface ArtifactAnalyzer {
  id: string;
  supports(artifact: ArtifactRecord): boolean;
  analyze(artifact: ArtifactRecord, absolutePath: string): Promise<ArtifactAnalysis>;
}

export class ArtifactAnalyzerRegistry {
  private readonly analyzers: ArtifactAnalyzer[] = [];

  register(analyzer: ArtifactAnalyzer): void {
    this.analyzers.push(analyzer);
  }

  find(artifact: ArtifactRecord): ArtifactAnalyzer | undefined {
    return this.analyzers.find((analyzer) => analyzer.supports(artifact));
  }

  list(): string[] {
    return this.analyzers.map((analyzer) => analyzer.id);
  }
}

function discoverJhat(): string | undefined {
  const configured = [process.env.TRACEFORGE_JHAT_PATH, process.env.JHAT_PATH]
    .find((candidate): candidate is string => !!candidate && existsSync(candidate));
  if (configured) return configured;
  const executable = process.platform === "win32" ? "jhat.exe" : "jhat";
  if (process.env.JAVA_HOME) {
    const candidate = resolve(process.env.JAVA_HOME, "bin", executable);
    if (existsSync(candidate)) return candidate;
  }
  const located = spawnSync(process.platform === "win32" ? "where.exe" : "which", [executable], {
    encoding: "utf8",
    windowsHide: true,
  });
  const first = located.status === 0 ? located.stdout.split(/\r?\n/).find(Boolean) : undefined;
  if (first && existsSync(first)) return first;
  if (process.platform === "win32") {
    for (const root of ["C:\\Program Files\\Java", "C:\\Program Files\\Eclipse Adoptium"]) {
      if (!existsSync(root)) continue;
      const candidates = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolve(root, entry.name, "bin", executable))
        .filter(existsSync)
        .reverse();
      if (candidates[0]) return candidates[0];
    }
  }
  return undefined;
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function objectLinks(html: string): string[] {
  return [...html.matchAll(/href=["'](?:\.\.\/|\/)?(?:object|instance)\/(?:0x)?([0-9a-f]+)["']/gi)]
    .map((match) => match[1]!)
    .filter((id, index, all) => all.indexOf(id) === index);
}

function fieldObjectId(html: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`${escaped}\\s*\\([^)]*\\)\\s*:\\s*<a[^>]+href=["'](?:\\.\\./|/)?(?:object|instance)/(?:0x)?([0-9a-f]+)["']`, "i"));
  return match?.[1];
}

function fieldText(html: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`${escaped}\\s*\\([^)]*\\)\\s*:\\s*([\\s\\S]*?)<br>`, "i"));
  return match ? decodeHtml(match[1]!) : undefined;
}

function pageStringValue(html: string): string | undefined {
  const heading = html.match(/<h1>instance of ([\s\S]*?)\s*<small>/i);
  if (heading) {
    const value = decodeHtml(heading[1]!);
    if (value && !/^[\w.$\[\]]+@0x[0-9a-f]+$/i.test(value) && !/^\[[BCDFIJSZL]@0x/i.test(value)) return value;
  }
  const explicit = html.match(/String value(?:\s*<\/[^>]+>)*\s*:?\s*<[^>]*>([\s\S]*?)<\/[^>]+>/i);
  if (explicit) return decodeHtml(explicit[1]!);
  const value = fieldText(html, "value");
  return value && !/^0x[0-9a-f]+$/i.test(value) ? value : undefined;
}

async function waitForJhat(port: number, processHandle: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`jhat exited before becoming ready (code ${processHandle.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Parsing can take several seconds. Keep polling until the explicit deadline.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("jhat did not become ready within 90 seconds");
}

async function getPage(port: number, path: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`jhat request failed: HTTP ${response.status}`);
  return response.text();
}

async function runOql(port: number, query: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/oql/?${new URLSearchParams({ query })}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`jhat OQL failed: HTTP ${response.status}`);
  return response.text();
}

async function inspectMapEntries(port: number): Promise<ArtifactFinding[]> {
  const query = "select x from instanceof org.springframework.boot.origin.OriginTrackedValue$OriginTrackedCharSequence x";
  const result = await runOql(port, query);
  const findings: ArtifactFinding[] = [];
  for (const valueObjectId of objectLinks(result).slice(0, 500)) {
    const valueObjectPage = await getPage(port, `/object/0x${valueObjectId}`);
    const valueId = fieldObjectId(valueObjectPage, "value");
    const referenceSection = valueObjectPage.split(/References to this object:/i)[1]?.split(/Other Queries/i)[0] ?? "";
    const entryIds = objectLinks(referenceSection);
    for (const entryId of entryIds) {
    const entryPage = await getPage(port, `/object/0x${entryId}`);
    const keyId = fieldObjectId(entryPage, "key");
    if (!keyId || !valueId) continue;
    const [keyPage, valuePage] = await Promise.all([
      getPage(port, `/object/0x${keyId}`),
      getPage(port, `/object/0x${valueId}`),
    ]);
    const label = pageStringValue(keyPage);
    const value = pageStringValue(valuePage);
    if (!label || !/(password|passwd|secret|token|credential|api.?key)/i.test(label) || !value || value === label) continue;
    findings.push({
      kind: "configuration",
      label,
      value,
      confidence: 0.95,
      sensitive: true,
      evidence: [{
        objectId: `0x${entryId}`,
        relationship: `map entry key object 0x${keyId} -> tracked value object 0x${valueObjectId} -> string object 0x${valueId}`,
      }],
    });
    }
  }
  return findings;
}

async function inspectSecurityUsers(port: number): Promise<ArtifactFinding[]> {
  const result = await runOql(port, "select u from instanceof org.springframework.security.core.userdetails.User u");
  const findings: ArtifactFinding[] = [];
  for (const userId of objectLinks(result).slice(0, 200)) {
    const userPage = await getPage(port, `/object/0x${userId}`);
    const usernameId = fieldObjectId(userPage, "username");
    const passwordId = fieldObjectId(userPage, "password");
    if (!usernameId || !passwordId) continue;
    const [usernamePage, passwordPage] = await Promise.all([
      getPage(port, `/object/0x${usernameId}`),
      getPage(port, `/object/0x${passwordId}`),
    ]);
    const username = pageStringValue(usernamePage);
    const password = pageStringValue(passwordPage);
    if (!username || !password) continue;
    findings.push({
      kind: "credential",
      label: username,
      value: password,
      confidence: 0.98,
      sensitive: true,
      evidence: [{
        objectId: `0x${userId}`,
        relationship: `security principal username object 0x${usernameId} -> password object 0x${passwordId}`,
      }],
    });
  }
  return findings;
}

export class JhatHprofAnalyzer implements ArtifactAnalyzer {
  readonly id = "jhat-hprof-object-graph";

  supports(artifact: ArtifactRecord): boolean {
    return artifact.detectedFormat === "java-hprof";
  }

  async analyze(_artifact: ArtifactRecord, absolutePath: string): Promise<ArtifactAnalysis> {
    const jhat = discoverJhat();
    if (!jhat) {
      throw new Error("No HPROF object-graph analyzer is available. Install a JDK containing jhat or set TRACEFORGE_JHAT_PATH.");
    }
    const port = 41_000 + Math.floor(Math.random() * 10_000);
    const child = spawn(jhat, ["-J-Xmx1g", "-port", String(port), absolutePath], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await waitForJhat(port, child);
      const findings = [
        ...await inspectMapEntries(port),
        ...await inspectSecurityUsers(port),
      ].filter((finding, index, all) =>
        all.findIndex((candidate) => candidate.kind === finding.kind
          && candidate.label === finding.label
          && candidate.value === finding.value) === index);
      return {
        analyzerId: this.id,
        summary: findings.length > 0
          ? `Completed HPROF object-graph analysis and recovered ${findings.length} candidate relationship${findings.length === 1 ? "" : "s"}.`
          : "Completed the available HPROF object-graph queries; no matching candidates were recovered. This is not proof that the artifact contains no secrets.",
        findings,
        coverage: {
          metadata: true,
          text: false,
          objectGraph: true,
          limitations: [
            "Coverage is limited to supported object relationships and loaded classes.",
            "No match is an analyzer result, not proof of absence from the artifact.",
          ],
        },
      };
    } finally {
      child.kill();
    }
  }
}
