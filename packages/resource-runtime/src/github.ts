import { createHash } from "node:crypto";
import { fromBuffer, type Entry } from "yauzl";
import { fetchPublic, type PublicFetch } from "./public-fetch.js";

export interface ProjectFile { path: string; bytes: Buffer }
export interface SourceProject { repository: string; commit: string; digest: string; archive: Buffer; files: ProjectFile[]; readme: string; license: string | null }
export function repositoryName(value: string): string {
  const name = value.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(name) || name.split("/").some(part => part === "." || part === "..")) throw new Error("Use a GitHub owner/repository or repository URL");
  return name;
}

/** No shell extraction, hooks, git configuration, submodules or executable launch. */
export async function readSourceArchive(bytes: Buffer): Promise<ProjectFile[]> {
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Source archive exceeds 8 MiB");
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
    if (error || !zip) { reject(new Error("Invalid source ZIP archive")); return; }
    const files: ProjectFile[] = [], names = new Set<string>(); let total = 0, entries = 0, prefix: string | undefined;
    const fail = (reason: string) => { zip.close(); reject(new Error(reason)); };
    zip.on("error", () => fail("Invalid source ZIP data")); zip.on("end", () => resolve(files));
    zip.on("entry", (entry: Entry) => {
      const parts = entry.fileName.split("/"); const type = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (++entries > 512 || parts.length > 17 || parts[0] === "" || parts.some((part, i) => (part === "" && i !== parts.length - 1) || part === "." || part === ".." || part === ".git" || /[\\\x00-\x1f\x7f]/.test(part))
        || (type !== 0 && type !== 0x8000 && type !== 0x4000) || (entry.generalPurposeBitFlag & 1)) { fail("Source archive has unsafe paths, links, special files or too many entries"); return; }
      prefix ??= parts[0];
      if (parts[0] !== prefix) { fail("Source archive must have one project root"); return; }
      if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
      const path = parts.slice(1).join("/");
      if (!path || path.length > 1024 || names.has(path.toLowerCase()) || entry.uncompressedSize > 4 * 1024 * 1024 || (total += entry.uncompressedSize) > 16 * 1024 * 1024) { fail("Source archive exceeds file/size limits or contains conflicting paths"); return; }
      names.add(path.toLowerCase());
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { fail("Cannot read source archive entry"); return; }
        const chunks: Buffer[] = []; let size = 0;
        stream.on("error", () => fail("Invalid source archive stream"));
        stream.on("data", (chunk: Buffer) => { size += chunk.length; if (size > entry.uncompressedSize) { stream.destroy(); fail("Source archive size mismatch"); } else chunks.push(chunk); });
        stream.on("end", () => { files.push({ path, bytes: Buffer.concat(chunks) }); zip.readEntry(); });
      });
    }); zip.readEntry();
  }));
}

export class GithubSources {
  constructor(private readonly fetch: PublicFetch = fetchPublic) {}
  async search(query: string, signal?: AbortSignal) {
    if (!query.trim() || query.length > 500) throw new Error("Repository search requires 1–500 characters");
    const data = await this.json(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=10`, signal);
    if (!Array.isArray(data.items)) throw new Error("Invalid repository search response");
    return data.items.slice(0, 10).map((item: Record<string, unknown>) => ({ repository: repositoryName(String(item.full_name)),
      description: String(item.description ?? "").slice(0, 2000), url: `https://github.com/${repositoryName(String(item.full_name))}` }));
  }
  async acquire(repository: string, ref: string, signal?: AbortSignal): Promise<SourceProject> {
    const name = repositoryName(repository);
    if (!ref.trim() || ref.length > 200) throw new Error("Specify a branch, tag or commit");
    const revision = await this.json(`https://api.github.com/repos/${name}/commits/${encodeURIComponent(ref)}`, signal);
    if (typeof revision.sha !== "string" || !/^[0-9a-f]{40}$/.test(revision.sha)) throw new Error("GitHub did not resolve an immutable commit");
    const archive = await this.fetch(`https://codeload.github.com/${name}/zip/${revision.sha}`, { maximumBytes: 8 * 1024 * 1024, signal });
    if (archive.status !== 200) throw new Error(`Source download returned HTTP ${archive.status}`);
    const files = await readSourceArchive(archive.bytes);
    const readme = files.find(file => /^readme(?:\.(?:md|rst|txt))?$/i.test(file.path));
    const license = files.find(file => /^(?:license|copying)(?:\.[a-z]+)?$/i.test(file.path));
    return { repository: name, commit: revision.sha, digest: createHash("sha256").update(archive.bytes).digest("hex"), archive: archive.bytes, files,
      readme: readme?.bytes.toString("utf8").slice(0, 32_768) ?? "No root README found. Inspect the project documentation before preparing an entry point.",
      license: license?.bytes.toString("utf8").slice(0, 16_384) ?? null };
  }
  private async json(url: string, signal?: AbortSignal) {
    const response = await this.fetch(url, { headers: { accept: "application/vnd.github+json" }, signal });
    if (response.status !== 200) throw new Error(`GitHub returned HTTP ${response.status}; check the source or API rate limit`);
    return JSON.parse(response.bytes.toString("utf8"));
  }
}
