import { expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { GithubSources, readSourceArchive, repositoryName } from "./github.js";
import { extractDocument, PublicResearch } from "./research.js";
import { isPublicAddress, publicUrl, type PublicFetch } from "./public-fetch.js";

async function archive(entries: Array<[string, string, number?]>) {
  const zip = new ZipFile(), chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on("data", chunk => chunks.push(chunk)); zip.outputStream.on("end", () => resolve(Buffer.concat(chunks))); zip.outputStream.on("error", reject); });
  for (const [path, text, mode] of entries) zip.addBuffer(Buffer.from(text), path, mode ? { mode } : {});
  zip.end(); return done;
}
it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "192.168.1.1", "198.18.0.1", "203.0.113.1", "::1", "fc00::1", "2001:db8::1", "2002::1", "::ffff:8.8.8.8"])("rejects non-global address %s", address => expect(isPublicAddress(address)).toBe(false));
it("accepts global addresses but never credentials, local names or non-HTTPS URLs", () => {
  expect(isPublicAddress("8.8.8.8")).toBe(true); expect(isPublicAddress("2606:4700::1111")).toBe(true);
  for (const url of ["http://example.org", "https://localhost", "https://a:b@example.org", "https://example.org:8443", "https://example.org/#x"]) expect(() => publicUrl(url)).toThrow();
});
it("extracts bounded plain text and links without running or preserving executable markup", () => {
  const result = extractDocument(Buffer.from('<title>Manual</title><script>evil()</script><style>hidden</style><form>private form</form><p>Read &amp; inspect</p><a href="/guide#section">Guide</a><a href="javascript:evil()">Bad</a>'), "text/html", "https://docs.example.org/");
  expect(result).toMatchObject({ title: "Manual", trust: "untrusted_external_content", links: ["https://docs.example.org/guide"] });
  expect(result.text).toContain("Read & inspect"); expect(result.text).not.toMatch(/evil|private form|hidden/);
  expect(extractDocument(Buffer.from("a".repeat(70000)), "text/plain", result.url)).toMatchObject({ truncated: true, text: "a".repeat(65536) });
  expect(() => extractDocument(Buffer.from("binary"), "application/pdf", result.url)).toThrow("Only UTF-8");
});
it("keeps disabled search offline and adapts both configurable search services", async () => {
  const fetch = vi.fn<PublicFetch>(async url => ({ url, status: 200, contentType: "application/json", bytes: Buffer.from(JSON.stringify({ web: { results: [{ title: "First", url: "https://docs.example.org/", description: "Manual" }] }, results: [{ title: "Second", url: "https://second.example.org/", content: "Guide" }] })) }));
  const research = new PublicResearch(fetch);
  await expect(research.search("manual", { provider: "disabled", endpoint: "" })).rejects.toThrow("not configured"); expect(fetch).not.toHaveBeenCalled();
  expect(await research.search("manual", { provider: "brave", endpoint: "https://search.example.org/web" }, "test-key")).toMatchObject([{ title: "First" }]);
  expect(fetch.mock.calls[0]).toMatchObject(["https://search.example.org/web?q=manual&count=10", { headers: { "X-Subscription-Token": "test-key" } }]);
  expect(await research.search("manual", { provider: "searxng", endpoint: "https://search.example.org/search" })).toMatchObject([{ title: "Second" }]);
  expect(fetch.mock.calls[1][0]).toContain("format=json");
});
it("pins repository acquisition to a full commit and only reads archive bytes", async () => {
  const zip = await archive([["repo/README.md", "Usage"], ["repo/run.sh", "printf example"]]), sha = "a".repeat(40);
  const fetch = vi.fn<PublicFetch>(async url => ({ url, status: 200, contentType: "application/zip", bytes: url.includes("/commits/") ? Buffer.from(JSON.stringify({ sha })) : zip }));
  const source = await new GithubSources(fetch).acquire("https://github.com/example/project.git", "main");
  expect(source).toMatchObject({ repository: "example/project", commit: sha, readme: "Usage", files: [{ path: "README.md" }, { path: "run.sh" }] });
  expect(fetch.mock.calls[1][0]).toBe(`https://codeload.github.com/example/project/zip/${sha}`);
  expect(() => repositoryName("https://other.example.org/a/b")).toThrow();
});
it("rejects unsafe source layouts, links, case collisions and oversized entries", async () => {
  for (const entries of [ [["repo/A", "one"], ["repo/a", "two"]], [["repo/a", "one"], ["other/b", "two"]], [["repo/link", "target", 0o120777]], [["repo/.git/config", "config"]], [["repo/large", "x".repeat(4 * 1024 * 1024 + 1)]] ] as Array<Array<[string, string, number?]>>) await expect(readSourceArchive(await archive(entries))).rejects.toThrow();
  await expect(readSourceArchive(Buffer.from("not zip"))).rejects.toThrow();
});
